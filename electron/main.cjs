const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const { randomInt } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let mainWindow = null;
let serverProcess = null;
let backendRoot = "";
let serverUrl = "";

// 패키지의 asar 외부 실행 파일 또는 개발 저장소에서 백엔드 루트를 찾는다.
function resolveBackendRoot() {
  return app.isPackaged ? path.join(process.resourcesPath, "app.asar.unpacked") : path.resolve(__dirname, "..");
}

// 다른 로컬 프로세스의 고정 포트 선점 가능성을 줄인 데스크톱 전용 주소를 만든다.
function createLocalServerUrl() {
  return `http://127.0.0.1:${randomInt(20_000, 60_000)}`;
}

// 데스크톱 창 내부 이동을 설정 화면과 선택한 WAM 서버 origin으로 제한한다.
function isAllowedNavigation(url) {
  if (url === pathToFileURL(path.join(__dirname, "setup.html")).href) return true;
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

// macOS GUI PATH까지 고려해 서버를 실행할 Node.js 22+ 경로를 찾는다.
function resolveNodeCommand() {
  if (process.env.WEB_AGENT_MANAGER_NODE || process.env.MYAGENT_NODE) {
    return process.env.WEB_AGENT_MANAGER_NODE || process.env.MYAGENT_NODE;
  }
  const candidates = process.platform === "darwin"
    ? ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
    : ["/usr/local/bin/node", "/usr/bin/node"];
  return candidates.find((candidate) => fs.existsSync(candidate)) || "node";
}

// 서버 자식 프로세스 출력을 Electron 사용자 데이터 로그에 이어 쓴다.
function appendServerLog(chunk) {
  const logPath = path.join(app.getPath("userData"), "server.log");
  fs.appendFile(logPath, String(chunk), () => undefined);
}

// 로컬 web-agent-manager 서버가 응답할 때까지 제한 시간 동안 기다린다.
async function waitForServer(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${serverUrl}/health`);
      if (response.ok) return true;
    } catch {
      // 서버 시작 중에는 연결 실패가 정상이다.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

// Linux·macOS에서 패키지에 포함된 production 서버를 시스템 Node로 실행한다.
function startLocalServer() {
  if (serverProcess || process.platform === "win32" || process.env.WEB_AGENT_MANAGER_SERVER_URL || process.env.MYAGENT_SERVER_URL) return;
  const entry = path.join(backendRoot, "dist", "server", "src", "server", "index.js");
  if (!fs.existsSync(entry)) throw new Error(`web-agent-manager 서버 파일을 찾을 수 없습니다: ${entry}`);
  const dataDir = path.join(app.getPath("userData"), "data");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  serverProcess = spawn(resolveNodeCommand(), [entry], {
    cwd: backendRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      WEB_AGENT_MANAGER_HOST: "127.0.0.1",
      WEB_AGENT_MANAGER_PORT: new URL(serverUrl).port,
      WEB_AGENT_MANAGER_PUBLIC_URL: serverUrl,
      WEB_AGENT_MANAGER_DATA_DIR: dataDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProcess.stdout.on("data", appendServerLog);
  serverProcess.stderr.on("data", appendServerLog);
  serverProcess.once("exit", () => {
    serverProcess = null;
  });
}

// 최초 사용자 생성 여부를 서버의 공개 상태 API로 확인한다.
async function setupRequired() {
  const response = await fetch(`${serverUrl}/api/auth/setup-status`);
  if (!response.ok) throw new Error("초기 설정 상태를 확인하지 못했습니다.");
  return Boolean((await response.json()).setupRequired);
}

// 시스템 Node의 관리자 생성 스크립트를 민감 값을 출력하지 않고 실행한다.
function createAdmin(username, password) {
  return new Promise((resolve, reject) => {
    const entry = path.join(backendRoot, "dist", "server", "scripts", "create-admin.js");
    const child = spawn(resolveNodeCommand(), [entry], {
      cwd: backendRoot,
      env: {
        ...process.env,
        WEB_AGENT_MANAGER_DATA_DIR: path.join(app.getPath("userData"), "data"),
        WEB_AGENT_MANAGER_ADMIN_USERNAME: username,
        WEB_AGENT_MANAGER_ADMIN_PASSWORD: password,
      },
      stdio: ["ignore", "ignore", "pipe"],
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
  if (process.platform === "win32") return Promise.resolve();
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
        WEB_AGENT_MANAGER_DATA_DIR: path.join(app.getPath("userData"), "data"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", appendServerLog);
    child.stderr.on("data", appendServerLog);
    child.once("error", () => resolve());
    child.once("exit", () => resolve());
  });
}

// 외부 탐색을 막은 데스크톱 창에서 로컬 web-agent-manager UI만 연다.
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 360,
    minHeight: 640,
    show: false,
    backgroundColor: "#f3f5f2",
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
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
}

// 서버·초기 설정 상태에 맞는 화면을 데스크톱 창에 표시한다.
async function loadInitialPage() {
  const ready = await waitForServer();
  if (!ready) {
    if (process.platform === "win32") {
      throw new Error("Windows에서는 WSL2의 setup-windows.cmd로 web-agent-manager 서버를 먼저 실행하거나 WEB_AGENT_MANAGER_SERVER_URL을 설정해야 합니다.");
    }
    throw new Error(`web-agent-manager 서버가 시작되지 않았습니다. 로그: ${path.join(app.getPath("userData"), "server.log")}`);
  }
  await installAgentIntegrations();
  if (await setupRequired()) await mainWindow.loadFile(path.join(__dirname, "setup.html"));
  else await mainWindow.loadURL(serverUrl);
}

ipcMain.handle("web-agent-manager:create-admin", async (_event, credentials) => {
  if (!(await setupRequired())) throw new Error("초기 관리자 설정이 이미 완료됐습니다.");
  const username = typeof credentials?.username === "string" ? credentials.username.trim() : "";
  const password = typeof credentials?.password === "string" ? credentials.password : "";
  if (!username || password.length < 12) throw new Error("아이디와 12자 이상의 비밀번호가 필요합니다.");
  await createAdmin(username, password);
  await mainWindow.loadURL(serverUrl);
  return { ok: true };
});

app.whenReady().then(async () => {
  backendRoot = resolveBackendRoot();
  serverUrl = process.env.WEB_AGENT_MANAGER_SERVER_URL || process.env.MYAGENT_SERVER_URL || createLocalServerUrl();
  createWindow();
  try {
    startLocalServer();
    await loadInitialPage();
  } catch (error) {
    await dialog.showMessageBox(mainWindow, {
      type: "error",
      title: "web-agent-manager 시작 실패",
      message: error instanceof Error ? error.message : String(error),
    });
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (!mainWindow) {
    createWindow();
    void loadInitialPage();
  }
});

app.on("before-quit", () => {
  if (serverProcess && !serverProcess.killed) serverProcess.kill("SIGTERM");
});
