const fs = require("node:fs");
const path = require("node:path");

const CONFIG_FILE = "connection.json";

// 입력한 WAM 주소를 origin으로 정규화한다. 계정 정보·경로·쿼리는 받지 않는다(#139).
function normalizeServerUrl(input) {
  const raw = String(input ?? "").trim();
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    throw new Error("WAM 주소 형식이 올바르지 않습니다. 예: https://wam.example.com 또는 http://100.101.102.103:14003");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("http 또는 https 주소만 사용할 수 있습니다.");
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== "/")) {
    throw new Error("WAM 주소는 경로·쿼리·계정 정보 없이 입력하세요.");
  }
  return url.origin;
}

// 암호화되지 않은 HTTP로 공개 주소에 붙는지 판단한다. localhost·사설망·Tailnet(100.64.0.0/10)은 경고하지 않는다.
function isUnencryptedPublic(serverUrl) {
  const url = new URL(serverUrl);
  if (url.protocol === "https:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || /^fc|^fd/i.test(host)) return false;
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return !(a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
}

// 저장한 연결 주소를 읽는다. 파일이 없거나 깨졌으면 null.
function readSavedServer(userDataDir) {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(userDataDir, CONFIG_FILE), "utf8"));
    return typeof saved?.serverUrl === "string" ? normalizeServerUrl(saved.serverUrl) : null;
  } catch {
    return null;
  }
}

// 연결에 성공한 주소만 저장한다. 비밀 값은 저장하지 않는다(로그인은 창의 쿠키 세션이 담당).
function saveServer(userDataDir, serverUrl) {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(path.join(userDataDir, CONFIG_FILE), `${JSON.stringify({ serverUrl: normalizeServerUrl(serverUrl) }, null, 2)}\n`, { mode: 0o600 });
}

// 주소가 실제 WAM 서버인지 확인한다. health와 공개 초기 설정 상태 API가 모두 응답해야 한다.
async function probeServer(serverUrl, fetchImpl = fetch, timeoutMs = 8000) {
  const get = async (pathname) => {
    try {
      return await fetchImpl(`${serverUrl}${pathname}`, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new Error(`${serverUrl}에 연결할 수 없습니다. 주소·포트와 서버 실행 여부, 방화벽·Tailscale 연결을 확인하세요.`);
    }
  };
  const health = await get("/health");
  if (!health.ok) throw new Error(`${serverUrl}이(가) 응답했지만 WAM 서버가 아닙니다(health ${health.status}).`);
  const setup = await get("/api/auth/setup-status");
  const body = setup.ok ? await setup.json().catch(() => null) : null;
  if (!body || typeof body.setupRequired !== "boolean") throw new Error(`${serverUrl}은(는) WAM 서버가 아니거나 지원하지 않는 버전입니다.`);
  return { setupRequired: body.setupRequired };
}

module.exports = { normalizeServerUrl, isUnencryptedPublic, readSavedServer, saveServer, probeServer };
