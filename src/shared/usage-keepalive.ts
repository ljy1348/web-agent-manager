export const USAGE_KEEPALIVE_PROMPT = "hi";
export const LEGACY_CODEX_USAGE_KEEPALIVE_PROMPT = "세션 유지 확인입니다. 짧은 한 문장으로 답해주세요.";
export const LEGACY_CODEX_USAGE_KEEPALIVE_LONG_PROMPT = "세션 유지 확인입니다. 현재 세션이 정상이라고 판단한 이유를 서로 다른 표현의 한국어 세 문장, 총 150자 이상으로 답해주세요.";
export const LEGACY_CODEX_USAGE_KEEPALIVE_LONG_RETRY_PROMPT = "세션 유지 재확인입니다. 현재 세션 상태와 응답 가능 여부를 서로 다른 표현의 한국어 다섯 문장, 총 300자 이상으로 자세히 답해주세요.";
export const LEGACY_CODEX_USAGE_KEEPALIVE_150_PROMPT = "세션 유지 확인입니다. 도구를 사용하지 말고 현재 응답 가능 여부를 서로 다른 표현의 한국어 세 문장, 총 150자 이상으로 답해주세요.";
export const LEGACY_CODEX_USAGE_KEEPALIVE_300_RETRY_PROMPT = "세션 유지 재확인입니다. 도구를 사용하지 말고 현재 응답 가능 여부를 서로 다른 표현의 한국어 다섯 문장, 총 300자 이상으로 자세히 답해주세요.";
export const LEGACY_CODEX_USAGE_KEEPALIVE_500_PROMPT = "세션 유지 확인입니다. 도구를 사용하지 말고 현재 세션 상태와 응답 가능 여부를 서로 겹치지 않는 표현의 한국어 문장들로 총 500자 이상 자세히 답해주세요.";
export const LEGACY_CODEX_USAGE_KEEPALIVE_700_RETRY_PROMPT = "세션 유지 재확인입니다. 도구를 사용하지 말고 현재 세션 상태, 문맥 유지 여부와 응답 가능 여부를 서로 겹치지 않는 표현의 한국어 문장들로 총 700자 이상 자세히 답해주세요.";
export const CODEX_USAGE_KEEPALIVE_MAX_ATTEMPTS = 10;
export const CODEX_USAGE_KEEPALIVE_MIN_RESPONSE_CHARS = 1500;
export const CODEX_USAGE_KEEPALIVE_MAX_RESPONSE_CHARS = 10000;
export const CODEX_USAGE_KEEPALIVE_STEP_CHARS = Math.round(
  (CODEX_USAGE_KEEPALIVE_MAX_RESPONSE_CHARS - CODEX_USAGE_KEEPALIVE_MIN_RESPONSE_CHARS) / (CODEX_USAGE_KEEPALIVE_MAX_ATTEMPTS - 1),
);
export const CODEX_USAGE_KEEPALIVE_RETRY_MIN_RESPONSE_CHARS = CODEX_USAGE_KEEPALIVE_MIN_RESPONSE_CHARS + CODEX_USAGE_KEEPALIVE_STEP_CHARS;
export const CODEX_USAGE_KEEPALIVE_PROMPT = `세션 유지 확인입니다. 도구를 사용하지 말고 현재 세션 상태와 응답 가능 여부를 서로 겹치지 않는 표현의 한국어 문장들로 총 ${CODEX_USAGE_KEEPALIVE_MIN_RESPONSE_CHARS}자 이상 자세히 답해주세요.`;
export const CODEX_USAGE_KEEPALIVE_RETRY_PROMPT = `세션 유지 재확인입니다. 도구를 사용하지 말고 현재 세션 상태, 문맥 유지 여부와 응답 가능 여부를 서로 겹치지 않는 표현의 한국어 문장들로 총 ${CODEX_USAGE_KEEPALIVE_RETRY_MIN_RESPONSE_CHARS}자 이상 자세히 답해주세요.`;
const CODEX_USAGE_KEEPALIVE_GROWING_PROMPT = /^세션 유지 재확인입니다\. 도구를 사용하지 말고 현재 세션 상태, 문맥 유지 여부와 응답 가능 여부를 서로 겹치지 않는 표현의 한국어 문장들로 총 \d+자 이상 자세히 답해주세요\.$/;

// 재시도 횟수(0부터)를 최소 응답 글자 수로 바꾼다. 0은 1500, 9는 10000이 되도록 10회에 나눠 올린다.
export function usageKeepaliveMinimumResponseChars(provider: string, attempt = 0): number {
  if (provider !== "codex") return 0;
  const bounded = Math.max(0, Math.floor(attempt));
  if (bounded <= 0) return CODEX_USAGE_KEEPALIVE_MIN_RESPONSE_CHARS;
  if (bounded >= CODEX_USAGE_KEEPALIVE_MAX_ATTEMPTS - 1) return CODEX_USAGE_KEEPALIVE_MAX_RESPONSE_CHARS;
  return CODEX_USAGE_KEEPALIVE_MIN_RESPONSE_CHARS + Math.round(
    bounded * (CODEX_USAGE_KEEPALIVE_MAX_RESPONSE_CHARS - CODEX_USAGE_KEEPALIVE_MIN_RESPONSE_CHARS) / (CODEX_USAGE_KEEPALIVE_MAX_ATTEMPTS - 1),
  );
}

// 방금 끝난 시도 다음에 보낼 횟수가 남아 있는지 본다. Codex는 0~9만 허용한다.
export function usageKeepaliveHasRemainingAttempts(provider: string, completedAttempt = 0): boolean {
  if (provider !== "codex") return true;
  return Math.max(0, Math.floor(completedAttempt)) + 1 < CODEX_USAGE_KEEPALIVE_MAX_ATTEMPTS;
}

// Codex만 1% 반영에 충분한 응답을 요청하고, 확인 실패마다 요구 글자 수를 늘린다.
export function usageKeepalivePrompt(provider: string, retryOrAttempt: boolean | number = false): string {
  if (provider !== "codex") return USAGE_KEEPALIVE_PROMPT;
  const attempt = typeof retryOrAttempt === "number" ? Math.max(0, Math.floor(retryOrAttempt)) : (retryOrAttempt ? 1 : 0);
  const minimum = usageKeepaliveMinimumResponseChars(provider, attempt);
  if (attempt <= 0) return CODEX_USAGE_KEEPALIVE_PROMPT;
  if (attempt === 1) return CODEX_USAGE_KEEPALIVE_RETRY_PROMPT;
  return `세션 유지 재확인입니다. 도구를 사용하지 말고 현재 세션 상태, 문맥 유지 여부와 응답 가능 여부를 서로 겹치지 않는 표현의 한국어 문장들로 총 ${minimum}자 이상 자세히 답해주세요.`;
}

// 문구 변경 전 만들어진 Codex 내부 세션도 일반 채팅으로 다시 노출되지 않게 함께 인정한다.
export function isCodexUsageKeepalivePrompt(prompt: string): boolean {
  return prompt === CODEX_USAGE_KEEPALIVE_PROMPT
    || prompt === CODEX_USAGE_KEEPALIVE_RETRY_PROMPT
    || CODEX_USAGE_KEEPALIVE_GROWING_PROMPT.test(prompt)
    || prompt === LEGACY_CODEX_USAGE_KEEPALIVE_500_PROMPT
    || prompt === LEGACY_CODEX_USAGE_KEEPALIVE_700_RETRY_PROMPT
    || prompt === LEGACY_CODEX_USAGE_KEEPALIVE_150_PROMPT
    || prompt === LEGACY_CODEX_USAGE_KEEPALIVE_300_RETRY_PROMPT
    || prompt === LEGACY_CODEX_USAGE_KEEPALIVE_LONG_PROMPT
    || prompt === LEGACY_CODEX_USAGE_KEEPALIVE_LONG_RETRY_PROMPT
    || prompt === LEGACY_CODEX_USAGE_KEEPALIVE_PROMPT
    || prompt === USAGE_KEEPALIVE_PROMPT;
}

// 초기화 창을 식별할 수 없는 예외 상태에서만 쓰는 보수적 재전송 제한이다.
export const USAGE_KEEPALIVE_COOLDOWN_MS = 5 * 60 * 60_000;
