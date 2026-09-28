let csrfToken = "";

// 어느 화면의 요청에서든 세션 만료(401)를 발견하면 App이 즉시 로그인 화면으로 전환한다.
// 로그인 폼은 api()가 아닌 자체 fetch를 사용하므로 잘못된 비밀번호 401과는 섞이지 않는다.
export const AUTHENTICATION_REQUIRED_EVENT = "web-agent-manager:authentication-required";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export function notifyAuthenticationRequired(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(AUTHENTICATION_REQUIRED_EVENT));
}

// 서버가 403으로 막은 원인. reauth=최근 본인 확인 필요, network=외부망이라 내부망 전용 작업 차단.
export type SecurityBlockReason = "reauth" | "network";
// 원인 안내창을 띄우는 App 처리기. 재인증을 마치면 true를 돌려 원래 요청을 재시도하게 한다.
export type SecurityBlockHandler = (reason: SecurityBlockReason, message: string) => Promise<boolean>;
let securityBlockHandler: SecurityBlockHandler | null = null;
let pendingReauthentication: Promise<boolean> | null = null;

// App이 공통 차단 안내창 처리기를 등록·해제한다.
export function setSecurityBlockHandler(handler: SecurityBlockHandler | null): void {
  securityBlockHandler = handler;
}

// 여러 요청이 동시에 재인증에 걸려도 안내창은 하나만 띄우고 그 결과를 함께 쓴다.
function requestReauthentication(message: string): Promise<boolean> {
  if (!securityBlockHandler) return Promise.resolve(false);
  pendingReauthentication ??= securityBlockHandler("reauth", message).catch(() => false).finally(() => { pendingReauthentication = null; });
  return pendingReauthentication;
}

// 후속 쓰기 API 요청에 붙일 CSRF 토큰을 갱신한다.
export function setCsrfToken(token: string): void {
  csrfToken = token;
}

// 로그 전송처럼 api() 밖에서 직접 fetch할 때 쓸 현재 CSRF 토큰을 돌려준다.
export function getCsrfToken(): string {
  return csrfToken;
}

// TODO(임시 상세 로그): API 인/아웃 전체 기록. 문제가 안정화되면 제거하거나 레벨을 낮춘다.
// 로그에 남기기 전에 비밀 값(password·token 등)을 마스킹하고 길이를 제한한다.
function maskForLog(value: unknown): string {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (!text) return "";
    const masked = text.replace(/("[^"]*(?:password|passphrase|token|secret|one.?time.?code)[^"]*"\s*:\s*)"[^"]*"/gi, '$1"***"');
    return masked.length > 1500 ? `${masked.slice(0, 1500)}…` : masked;
  } catch {
    return "[unserializable]";
  }
}

// 인증·CSRF를 포함해 JSON API를 호출한다.
export function api(path: string, options: RequestInit = {}): Promise<any> {
  return requestApi(path, options, false);
}

// 재인증 후 재시도는 1회만 하도록 retried로 구분한다. 재인증 가드는 라우트 실행 전에 막으므로 재시도해도 작업이 두 번 실행되지 않는다.
async function requestApi(path: string, options: RequestInit, retried: boolean): Promise<any> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  if (options.method && !["GET", "HEAD"].includes(options.method)) headers.set("x-csrf-token", csrfToken);
  const method = options.method ?? "GET";
  const startedAt = Date.now();
  const requestBody = options.body instanceof FormData ? "[FormData]" : options.body ? maskForLog(options.body) : "";
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { ...options, headers });
  } catch (error) {
    console.debug("[web-agent-manager:api]", method, path, "network-error", { ms: Date.now() - startedAt, in: requestBody, error: String(error) });
    throw error;
  }
  if (response.status === 204) {
    console.debug("[web-agent-manager:api]", method, path, 204, { ms: Date.now() - startedAt, in: requestBody, out: "" });
    return null;
  }
  const data = await response.json().catch(() => ({}));
  console.debug("[web-agent-manager:api]", method, path, response.status, { ms: Date.now() - startedAt, in: requestBody, out: maskForLog(data) });
  if (!response.ok) {
    const message = data.error || `HTTP ${response.status}`;
    // 원격 WAM이 중계한 응답은 이 WAM의 세션·네트워크로 해결할 수 없으므로 전역 처리하지 않는다.
    const upstream = response.headers.get("x-wam-federation-upstream") === "1";
    if (response.status === 401 && !upstream) notifyAuthenticationRequired();
    if (response.status === 403 && !upstream) {
      if (data.reauthRequired === true && !retried) {
        if (await requestReauthentication(message)) return requestApi(path, options, true);
      } else if (data.networkRestricted === true) void securityBlockHandler?.("network", message);
    }
    throw new ApiError(message, response.status);
  }
  return data;
}

// fetch는 업로드 진행률을 알려주지 않아 큰 파일은 진행 상황 없이 멈춘 것처럼 보인다.
// XMLHttpRequest의 upload.onprogress로 퍼센트를 받아 onProgress에 전달한다.
export function uploadFile(path: string, form: FormData, onProgress?: (fraction: number) => void): Promise<any> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api${path}`);
    xhr.setRequestHeader("x-csrf-token", csrfToken);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    xhr.onerror = () => reject(new Error("네트워크 오류로 업로드에 실패했습니다."));
    xhr.onload = () => {
      let data: any = {};
      try { data = xhr.responseText ? JSON.parse(xhr.responseText) : {}; } catch { /* 빈 응답 등은 무시 */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else {
        if (xhr.status === 401) notifyAuthenticationRequired();
        reject(new ApiError(data.error || `HTTP ${xhr.status}`, xhr.status));
      }
    };
    xhr.send(form);
  });
}
