const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, shell, Tray } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const { randomInt } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { normalizeServerUrl, isUnencryptedPublic, readSavedServer, saveServer, probeServer } = require("./connection.cjs");
const { DEFAULT_PORT, readSavedMode, saveMode, detectAddresses, normalizeLocalConfig, readLocalConfig, saveLocalConfig, bundledNode } = require("./local-node.cjs");

let mainWindow = null;
let serverProcess = null;
let backendRoot = "";
let serverUrl = "";
// "local": 앱 안에서 서버 실행, "remote": 다른 WAM에 접속(#139), "choose": 첫 실행 선택 화면(#156).
let mode = "local";
let remoteMode = false;
// 저장된 로컬 서버 설정(Windows·선택형). null이면 Linux·macOS 기존 방식(임의 포트, 이 PC 전용)이다.
let localConfig = null;
let tray = null;
let quitting = false;
const startHidden = process.argv.includes("--hidden");

const ENV_SERVER_URL = () => process.env.WEB_AGENT_MANAGER_SERVER_URL || process.env.MYAGENT_SERVER_URL || "";

// 시작 방식을 정한다. 환경변수가 우선이고, Windows(또는 DESKTOP_MODE=choose)는 첫 실행에 사용자가 고른 방식을 저장해 쓴다.
// Linux·macOS 기본은 예전처럼 앱 안의 로컬 서버다.
function resolveMode() {
  const forced = process.env.WEB_AGENT_MANAGER_DESKTOP_MODE;
  if (ENV_SERVER_URL() || forced === "remote") return "remote";
  if (forced === "local") return "local";
  if (process.platform === "win32" || forced === "choose") return readSavedMode(app.getPath("userData")) ?? "choose";
  return "local";
}

// 첫 실행 선택·트레이를 쓰는 설치본인지(Windows 또는 시험용 DESKTOP_MODE=choose).
function usesChooser() {
  return process.platform === "win32" || process.env.WEB_AGENT_MANAGER_DESKTOP_MODE === "choose";
}

function setMode(next) {
  mode = next;
  remoteMode = next === "remote";
}

// 패키지의 asar 외부 실행 파일 또는 개발 저장소에서 백엔드 루트를 찾는다.
function resolveBackendRoot() {
  return app.isPackaged ? path.join(process.resourcesPath, "app.asar.unpacked") : path.resolve(__dirname, "..");
}

// 다른 로컬 프로세스의 고정 포트 선점 가능성을 줄인 데스크톱 전용 주소를 만든다.
function createLocalServerUrl() {
  return `http://127.0.0.1:${randomInt(20_000, 60_000)}`;
}

// 앱 창·상태 확인은 항상 이 PC 루프백으로 연다. 공개 주소(Tailscale 등)는 다른 컴퓨터 접속용이라 이 PC 안에서 안 닿을 수 있다(#156).
function localAppUrl(config) {
  return `http://127.0.0.1:${config.port}`;
}

// 다른 컴퓨터(메인 WAM)가 이 서버에 접속할 주소. 외부 접속을 허용하지 않았으면 앱 주소와 같다.
function publicServerUrl() {
  return localConfig?.publicUrl ?? serverUrl;
}

// 데스크톱 창 내부 이동을 앱 화면과 선택한 WAM 서버 origin으로 제한한다.
function isAllowedNavigation(url) {
  const withoutQuery = url.split(/[?#]/, 1)[0];
  if (["setup.html", "connect.html", "mode.html"].some((page) => withoutQuery === pathToFileURL(path.join(__dirname, page)).href)) return true;
  try {
    return new URL(url).origin === new URL(serverUrl).origin;
  } catch {
    return false;
  }
}

// 허용되지 않은 창 내부 이동을 막고 일반 웹 주소는 시스템 브라우저로 넘긴다.
function guardNavigation(event, url) {
  if (isAllowedNavigation(url)) return;
  event.preventDefault();
  if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
}

// 서버를 실행할 Node.js 22+ 경로. Windows 설치 파일은 함께 넣은 node.exe를 쓰고, 그 밖에는 시스템 Node를 찾는다.
function resolveNodeCommand() {
  if (process.env.WEB_AGENT_MANAGER_NODE || process.env.MYAGENT_NODE) {
    return process.env.WEB_AGENT_MANAGER_NODE || process.env.MYAGENT_NODE;
  }
  const bundled = bundledNode(process.resourcesPath);
  if (bundled) return bundled;
  const candidates = process.platform === "darwin"
    ? ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
    : process.platform === "win32" ? [] : ["/usr/local/bin/node", "/usr/bin/node"];
  return candidates.find((candidate) => fs.existsSync(candidate)) || "node";
}

function dataDir() {
  return localConfig?.dataDir ?? path.join(app.getPath("userData"), "data");
}

// 서버 자식 프로세스 출력을 Electron 사용자 데이터 로그에 이어 쓴다.
function appendServerLog(chunk) {
  const logPath = path.join(app.getPath("userData"), "server.log");
  fs.appendFile(logPath, String(chunk), () => undefined);
}

// 로컬 web-agent-manager 서버가 응답할 때까지 제한 시간 동안 기다린다. Windows 첫 실행은 백신 검사로 느릴 수 있어 넉넉히 둔다.
async function waitForServer(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!serverProcess) return false;
    try {
      const response = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return true;
    } catch {
      // 서버 시작 중에는 연결 실패가 정상이다.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

// 같은 주소에 이미 다른 서버(예: 터미널로 설치한 WAM)가 떠 있으면 그 서버를 자기 것으로 착각하지 않도록 먼저 막는다.
async function assertPortFree() {
  try {
    await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(1500) });
  } catch {
    return;
  }
  throw new Error(`${serverUrl}을(를) 이미 다른 프로그램(예: 터미널로 설치한 WAM)이 쓰고 있습니다. 그 프로그램을 끄거나, 메뉴의 WAM → 시작 방식 변경에서 다른 포트를 고르세요.`);
}

// 패키지에 포함된 production 서버를 Node로 실행한다. 로컬 설정이 있으면 그 포트·접속 범위·주소를 쓴다.
function startLocalServer() {
  if (serverProcess || remoteMode) return;
  const entry = path.join(backendRoot, "dist", "server", "src", "server", "index.js");
  if (!fs.existsSync(entry)) throw new Error(`web-agent-manager 서버 파일을 찾을 수 없습니다: ${entry}`);
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  const child = spawn(resolveNodeCommand(), [entry], {
    cwd: backendRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      WEB_AGENT_MANAGER_HOST: localConfig?.host ?? "127.0.0.1",
      WEB_AGENT_MANAGER_PORT: String(localConfig?.port ?? new URL(serverUrl).port),
      WEB_AGENT_MANAGER_PUBLIC_URL: publicServerUrl(),
      WEB_AGENT_MANAGER_DATA_DIR: dataDir(),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  serverProcess = child;
  child.stdout.on("data", appendServerLog);
  child.stderr.on("data", appendServerLog);
  child.once("error", (error) => appendServerLog(`서버 실행 실패: ${error.message}\n`));
  child.once("exit", () => {
    if (serverProcess === child) serverProcess = null;
    updateTray();
  });
}

// 로컬 서버를 끈다. Windows는 Volta 등 대리 실행 파일이 실제 node를 자식으로 띄우므로 프로세스 트리째 끈다(대리만 끄면 서버가 포트를 잡은 채 남는다).
function stopLocalServer() {
  if (!serverProcess) return;
  const child = serverProcess;
  serverProcess = null;
  if (process.platform === "win32" && child.pid) {
    const result = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5000 });
    if (result.status === 0) return;
  }
  child.kill();
}

// 방금 끈 서버가 포트를 놓을 때까지 잠깐 기다린다. 같은 포트로 다시 시작할 때 "이미 사용 중"으로 오인하지 않게 한다.
async function waitUntilStopped(url, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) }); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

// 최초 사용자 생성 여부를 서버의 공개 상태 API로 확인한다.
async function setupRequired() {
  const response = await fetch(`${serverUrl}/api/auth/setup-status`);
  if (!response.ok) throw new Error("초기 설정 상태를 확인하지 못했습니다.");
  return Boolean((await response.json()).setupRequired);
}

// 관리자 생성 스크립트를 민감 값을 출력하지 않고 실행한다.
function createAdmin(username, password) {
  return new Promise((resolve, reject) => {
    const entry = path.join(backendRoot, "dist", "server", "scripts", "create-admin.js");
    const child = spawn(resolveNodeCommand(), [entry], {
      cwd: backendRoot,
      env: {
        ...process.env,
        WEB_AGENT_MANAGER_DATA_DIR: dataDir(),
        WEB_AGENT_MANAGER_ADMIN_USERNAME: username,
        WEB_AGENT_MANAGER_ADMIN_PASSWORD: password,
      },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let errorText = "";
    child.stderr.on("data", (chunk) => {
      errorText += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(errorText.trim() || "관리자 계정을 만들지 못했습니다."));
    });
  });
}

// 데스크톱 시작 시 설치된 Claude·Codex의 스킬과 MCP 연결을 자동 보정한다.
function installAgentIntegrations() {
  if (remoteMode) return Promise.resolve();
  return new Promise((resolve) => {
    const entry = path.join(backendRoot, "dist", "server", "scripts", "install-agent-integrations.js");
    if (!fs.existsSync(entry)) {
      resolve();
      return;
    }
    const child = spawn(resolveNodeCommand(), [entry], {
      cwd: backendRoot,
      env: {
        ...process.env,
        WEB_AGENT_MANAGER_DATA_DIR: dataDir(),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.on("data", appendServerLog);
    child.stderr.on("data", appendServerLog);
    child.once("error", () => resolve());
    child.once("exit", () => resolve());
  });
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// 외부 탐색을 막은 데스크톱 창에서 WAM UI만 연다.
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 360,
    minHeight: 640,
    show: false,
    backgroundColor: "#f3f5f2",
    icon: path.join(__dirname, "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", guardNavigation);
  mainWindow.webContents.on("will-redirect", guardNavigation);
  // 중계 모드에서 서버가 꺼졌거나 네트워크가 끊겨 화면을 못 열면 연결 화면으로 돌아간다(-3은 사용자 이동에 따른 취소).
  mainWindow.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    if (!remoteMode || !isMainFrame || code === -3 || !serverUrl || !url.startsWith(serverUrl)) return;
    void showConnectPage(`${serverUrl}에 연결할 수 없습니다(${description}). 서버 상태를 확인하거나 다른 주소를 입력하세요.`, serverUrl);
  });
  // 로컬 서버를 트레이로 계속 돌리는 동안 창을 닫으면 끄지 않고 숨긴다(#156). 트레이의 "종료"로만 끝낸다.
  mainWindow.on("close", (event) => {
    if (tray && !quitting && mode === "local") {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.once("ready-to-show", () => { if (!startHidden) mainWindow?.show(); });
}

// 중계 모드 연결 화면을 연다. 직전 오류와 입력하던 주소를 함께 보여준다.
async function showConnectPage(error = "", url = serverUrl) {
  serverUrl = url || "";
  await mainWindow.loadFile(path.join(__dirname, "connect.html"), { query: { ...(url ? { url } : {}), ...(error ? { error } : {}) } });
}

// 시작 방식 선택 화면을 연다(#156).
async function showModePage() {
  showWindow();
  await mainWindow.loadFile(path.join(__dirname, "mode.html"));
}

// 원격 WAM을 확인한 뒤 창에 연다. 초기 관리자가 없는 서버는 이 앱에서 만들 수 없으므로 안내만 한다.
async function openRemoteServer(url) {
  const { setupRequired: needsSetup } = await probeServer(url);
  if (needsSetup) throw new Error(`${url}에 아직 관리자 계정이 없습니다. 서버 컴퓨터에서 초기 설정(관리자 생성)을 먼저 마치세요.`);
  serverUrl = url;
  await mainWindow.loadURL(serverUrl);
}

// 중계 모드 시작: 환경변수 주소 → 저장된 주소 순서로 접속하고, 없거나 실패하면 연결 화면을 연다.
async function loadRemoteStartPage() {
  const fromEnv = ENV_SERVER_URL();
  let target = null;
  try { target = fromEnv ? normalizeServerUrl(fromEnv) : readSavedServer(app.getPath("userData")); }
  catch (error) { return showConnectPage(error instanceof Error ? error.message : String(error), fromEnv); }
  if (!target) return showConnectPage();
  try { await openRemoteServer(target); }
  catch (error) { await showConnectPage(error instanceof Error ? error.message : String(error), target); }
}

// 메뉴. 중계 모드는 연결 서버 변경, 선택형 설치본은 시작 방식 변경·로그 폴더를 둔다.
function installMenu() {
  const wamItems = [
    ...(remoteMode ? [{ label: "연결 서버 변경…", click: () => { if (mainWindow) void showConnectPage("", serverUrl); } }] : []),
    ...(usesChooser() ? [{ label: "시작 방식 변경…", click: () => { if (mainWindow) void showModePage(); } }] : []),
    { label: "로그 폴더 열기", click: () => { void shell.openPath(app.getPath("userData")); } },
  ];
  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    { label: remoteMode ? "연결" : "WAM", submenu: wamItems },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// 로컬 서버를 쓰는 선택형 설치본은 트레이에 남아 서버를 계속 돌린다(#156).
function updateTray() {
  const wanted = usesChooser() && mode === "local";
  if (!wanted) {
    tray?.destroy();
    tray = null;
    return;
  }
  if (!tray) {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, "tray.png")));
    tray.on("click", showWindow);
  }
  const running = Boolean(serverProcess);
  tray.setToolTip(`web-agent-manager — ${running ? publicServerUrl() : "서버 중지됨"}`);
  const openAtLogin = app.getLoginItemSettings({ args: ["--hidden"] }).openAtLogin;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "WAM 열기", click: showWindow },
    { label: `접속 주소 복사 (${publicServerUrl()})`, enabled: Boolean(serverUrl), click: () => clipboard.writeText(publicServerUrl()) },
    { type: "separator" },
    { label: "로그온 시 자동 시작", type: "checkbox", checked: openAtLogin, click: (item) => { app.setLoginItemSettings({ openAtLogin: item.checked, args: ["--hidden"] }); updateTray(); } },
    { label: "로그 폴더 열기", click: () => { void shell.openPath(app.getPath("userData")); } },
    { type: "separator" },
    { label: "종료(서버도 멈춤)", click: () => { quitting = true; app.quit(); } },
  ]));
}

// 서버·초기 설정 상태에 맞는 화면을 데스크톱 창에 표시한다.
async function loadInitialPage() {
  if (mode === "choose") return showModePage();
  if (remoteMode) return loadRemoteStartPage();
  const ready = await waitForServer();
  if (!ready) {
    throw new Error(`web-agent-manager 서버가 시작되지 않았습니다. 로그: ${path.join(app.getPath("userData"), "server.log")}`);
  }
  updateTray();
  await installAgentIntegrations();
  if (await setupRequired()) await mainWindow.loadFile(path.join(__dirname, "setup.html"));
  else await mainWindow.loadURL(serverUrl);
}

ipcMain.handle("web-agent-manager:inspect-server-url", (_event, input) => {
  const normalized = normalizeServerUrl(input);
  return { normalized, insecure: isUnencryptedPublic(normalized) };
});

// 연결 화면에서 입력한 주소를 확인·저장하고 접속한다. 성공한 주소만 저장한다.
ipcMain.handle("web-agent-manager:connect-server", async (_event, input) => {
  if (!remoteMode) throw new Error("이 앱은 로컬 서버 모드로 실행 중입니다.");
  const url = normalizeServerUrl(input);
  await openRemoteServer(url);
  saveServer(app.getPath("userData"), url);
  return { ok: true, serverUrl: url };
});

// 선택 화면 기본값: 저장된 포트와 이 PC의 Tailscale·사설망 주소 후보.
ipcMain.handle("web-agent-manager:local-defaults", () => ({
  port: readLocalConfig(app.getPath("userData"))?.port ?? DEFAULT_PORT,
  addresses: detectAddresses(),
}));

// "이 PC에서 WAM 실행"을 고르면 설정을 저장하고 서버를 띄운다. 포트가 이미 쓰이면 저장 전에 알린다.
ipcMain.handle("web-agent-manager:choose-local", async (_event, input) => {
  if (!usesChooser()) throw new Error("이 설치본은 시작 방식을 바꿀 수 없습니다.");
  const next = normalizeLocalConfig(input, app.getPath("userData"));
  const previousUrl = serverProcess ? serverUrl : null;
  stopLocalServer();
  if (previousUrl) await waitUntilStopped(previousUrl);
  serverUrl = localAppUrl(next);
  await assertPortFree();
  localConfig = next;
  saveLocalConfig(app.getPath("userData"), next);
  saveMode(app.getPath("userData"), "local");
  setMode("local");
  installMenu();
  startLocalServer();
  await loadInitialPage();
  return { ok: true, serverUrl };
});

// "다른 WAM에 접속"을 고르면 로컬 서버를 멈추고 연결 화면을 연다.
ipcMain.handle("web-agent-manager:choose-remote", async () => {
  if (!usesChooser()) throw new Error("이 설치본은 시작 방식을 바꿀 수 없습니다.");
  stopLocalServer();
  saveMode(app.getPath("userData"), "remote");
  setMode("remote");
  localConfig = null;
  installMenu();
  updateTray();
  await showConnectPage("", readSavedServer(app.getPath("userData")) ?? "");
  return { ok: true };
});

ipcMain.handle("web-agent-manager:create-admin", async (_event, credentials) => {
  if (remoteMode) throw new Error("중계 모드에서는 관리자 계정을 만들 수 없습니다. 서버 컴퓨터에서 초기 설정을 하세요.");
  if (!(await setupRequired())) throw new Error("초기 관리자 설정이 이미 완료됐습니다.");
  const username = typeof credentials?.username === "string" ? credentials.username.trim() : "";
  const password = typeof credentials?.password === "string" ? credentials.password : "";
  if (!username || password.length < 12) throw new Error("아이디와 12자 이상의 비밀번호가 필요합니다.");
  await createAdmin(username, password);
  await mainWindow.loadURL(serverUrl);
  return { ok: true };
});

// 이미 실행 중이면 두 번째 실행은 기존 창을 앞으로 가져오고 끝낸다(트레이 상주 앱이 두 번 뜨지 않게).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);

  app.whenReady().then(async () => {
    backendRoot = resolveBackendRoot();
    setMode(resolveMode());
    if (mode === "local") {
      localConfig = usesChooser() ? readLocalConfig(app.getPath("userData")) : null;
      if (usesChooser() && !localConfig) setMode("choose");
    }
    serverUrl = mode === "local" ? (localConfig ? localAppUrl(localConfig) : createLocalServerUrl()) : "";
    createWindow();
    installMenu();
    try {
      if (mode === "local") {
        if (localConfig) await assertPortFree();
        startLocalServer();
      }
      await loadInitialPage();
    } catch (error) {
      showWindow();
      const message = error instanceof Error ? error.message : String(error);
      // 선택형 설치본은 앱을 끄지 않고 시작 방식 화면으로 돌아가 포트 등을 바꿀 수 있게 한다.
      if (usesChooser()) {
        await dialog.showMessageBox(mainWindow, { type: "error", title: "web-agent-manager 시작 실패", message });
        stopLocalServer();
        await showModePage();
        return;
      }
      await dialog.showMessageBox(mainWindow, { type: "error", title: "web-agent-manager 시작 실패", message });
      app.quit();
    }
  });
}

app.on("before-quit", () => {
  quitting = true;
  stopLocalServer();
});

app.on("window-all-closed", () => {
  if (tray) return;
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (!mainWindow) {
    createWindow();
    void loadInitialPage();
  }
});
