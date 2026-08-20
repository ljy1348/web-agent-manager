import type { Json } from "../types";

// 토큰 수를 좁은 채팅 말풍선에 맞는 K·M 단위로 줄여 표시한다.
export function compactTokenCount(value: unknown): string {
  const count = typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  if (count < 1_000) return Math.round(count).toLocaleString("ko-KR");
  const divisor = count < 1_000_000 ? 1_000 : 1_000_000;
  const suffix = divisor === 1_000 ? "K" : "M";
  const scaled = count / divisor;
  return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/, "")}${suffix}`;
}

// 공급자별 선택 필드는 값이 있을 때만 포함해 메시지 하단의 짧은 usage 문구를 만든다.
export function tokenUsageLabel(usage: Json | null | undefined): string {
  if (!usage || !(Number(usage.totalTokens) > 0)) return "";
  const fields = [
    `토큰 ${compactTokenCount(Number(usage.totalTokens))}`,
    Number(usage.inputTokens) > 0 ? `입력 ${compactTokenCount(Number(usage.inputTokens))}` : "",
    Number(usage.cachedInputTokens) > 0 ? `캐시 ${compactTokenCount(Number(usage.cachedInputTokens))}` : "",
    Number(usage.cacheCreationInputTokens) > 0 ? `캐시 생성 ${compactTokenCount(Number(usage.cacheCreationInputTokens))}` : "",
    Number(usage.cacheReadInputTokens) > 0 ? `캐시 읽기 ${compactTokenCount(Number(usage.cacheReadInputTokens))}` : "",
    Number(usage.outputTokens) > 0 ? `출력 ${compactTokenCount(Number(usage.outputTokens))}` : "",
    Number(usage.reasoningOutputTokens) > 0 ? `추론 ${compactTokenCount(Number(usage.reasoningOutputTokens))}` : "",
  ];
  return fields.filter(Boolean).join(" · ");
}
