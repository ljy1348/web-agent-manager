let csrfToken = "";

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
    const masked = text.replace(/("[^"]*(?:password|token|secret)[^"]*"\s*:\s*)"[^"]*"/gi, '$1"***"');
    return masked.length > 1500 ? `${masked.slice(0, 1500)}…` : masked;
  } catch {
    return "[unserializable]";
  }
}

// 인증·CSRF를 포함해 JSON API를 호출한다.
export async function api(path: string, options: RequestInit = {}): Promise<any> {
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
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
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
      else reject(new Error(data.error || `HTTP ${xhr.status}`));
    };
    xhr.send(form);
  });
}
