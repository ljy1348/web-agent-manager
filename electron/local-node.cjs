const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// 데스크톱 앱의 실행 모드와 로컬 WAM 서버 설정(#156). 비밀 값은 저장하지 않는다.
const MODE_FILE = "desktop-mode.json";
const LOCAL_FILE = "local-node.json";
const DEFAULT_PORT = 4317;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

// 저장된 모드("local" | "remote"). 없으면 null(첫 실행).
function readSavedMode(userDataDir) {
  const mode = readJson(path.join(userDataDir, MODE_FILE))?.mode;
  return mode === "local" || mode === "remote" ? mode : null;
}

function saveMode(userDataDir, mode) {
  if (mode !== "local" && mode !== "remote") throw new Error("알 수 없는 실행 모드입니다.");
  writeJson(path.join(userDataDir, MODE_FILE), { mode });
}

// Tailscale(100.64.0.0/10) → 사설망 IPv4 순서로 이 PC의 접속 주소 후보를 만든다.
function detectAddresses(interfaces = os.networkInterfaces()) {
  const tailnet = [];
  const lan = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" && entry.family !== 4) continue;
      if (entry.internal) continue;
      const [a, b] = entry.address.split(".").map(Number);
      if (a === 100 && b >= 64 && b <= 127) tailnet.push(entry.address);
      else if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) lan.push(entry.address);
    }
  }
  return [...tailnet, ...lan];
}

// 창에서 받은 로컬 서버 설정을 검증해 서버 실행 값으로 만든다. 외부 접속은 Tailscale·사설망 주소만 허용한다.
function normalizeLocalConfig(input, userDataDir) {
  const port = Number(input?.port ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("포트는 1024~65535 사이 숫자여야 합니다.");
  const allowNetwork = input?.allowNetwork === true;
  let address = "127.0.0.1";
  if (allowNetwork) {
    address = String(input?.address ?? "").trim();
    const [a, b] = address.split(".").map(Number);
    const privateAddress = /^\d+\.\d+\.\d+\.\d+$/.test(address) && (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
    if (!privateAddress) throw new Error("다른 컴퓨터 접속은 Tailscale(100.x) 또는 사설망 IPv4 주소만 쓸 수 있습니다.");
  }
  return {
    host: allowNetwork ? "0.0.0.0" : "127.0.0.1",
    port,
    publicUrl: `http://${address}:${port}`,
    dataDir: path.join(userDataDir, "data"),
  };
}

function readLocalConfig(userDataDir) {
  const saved = readJson(path.join(userDataDir, LOCAL_FILE));
  if (!saved || typeof saved.publicUrl !== "string" || !Number.isInteger(saved.port)) return null;
  // 데이터 폴더는 저장하지 않고 항상 userData 기준으로 계산해, 경로가 바뀌어도 데이터가 따로 놀지 않게 한다.
  return { host: saved.host === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1", port: saved.port, publicUrl: saved.publicUrl, dataDir: path.join(userDataDir, "data") };
}

function saveLocalConfig(userDataDir, config) {
  writeJson(path.join(userDataDir, LOCAL_FILE), { host: config.host, port: config.port, publicUrl: config.publicUrl });
}

// Windows 설치 파일에 함께 넣은 node.exe(없으면 null). 네이티브 모듈과 같은 Node 버전이다.
function bundledNode(resourcesPath, platform = process.platform) {
  if (platform !== "win32" || !resourcesPath) return null;
  const candidate = path.join(resourcesPath, "node", "node.exe");
  return fs.existsSync(candidate) ? candidate : null;
}

module.exports = { DEFAULT_PORT, readSavedMode, saveMode, detectAddresses, normalizeLocalConfig, readLocalConfig, saveLocalConfig, bundledNode };
