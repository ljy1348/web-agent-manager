import crypto from "node:crypto";
import type { HistoryMessage, HistoryTokenUsage } from "./provider";

// 다양한 메시지 블록에서 사람이 읽을 수 있는 텍스트를 추출한다.
export function extractContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((item) => {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object") return "";
    const block = item as Record<string, unknown>;
    if (typeof block.text === "string") return block.text;
    if (block.type === "tool_use") return `[도구: ${String(block.name ?? "unknown")}]\n${safeJson(block.input)}`;
    if (block.type === "tool_result") return `[도구 결과]\n${extractContent(block.content)}`;
    if (block.type === "input_text" || block.type === "output_text") return String(block.text ?? "");
    return "";
  }).filter(Boolean).join("\n");
}

// JSON 직렬화 실패를 막으면서 도구 입력을 문자열로 변환한다.
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? "");
  }
}

// 레코드에 ID가 없을 때 안정적인 메시지 식별자를 만든다.
export function fallbackId(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// 두 사용량을 필드별로 더한다.
function addTokenUsage(left: HistoryTokenUsage, right: HistoryTokenUsage): HistoryTokenUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheCreationInputTokens: left.cacheCreationInputTokens + right.cacheCreationInputTokens,
    cacheReadInputTokens: left.cacheReadInputTokens + right.cacheReadInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

// 현재 턴(마지막 user 이후)의 모델 호출량을 합쳐 그 턴의 최신 assistant 메시지에만 표시한다.
// 공급자는 도구 단계마다 모델을 호출해, 호출 하나를 메시지 하나에 붙이면 보이는 답변의 표시가 턴 사용량의
// 일부만 되거나(Codex·Claude) 덮어써졌다(#134). 합계는 메시지에 붙은 값에서 이어 더하므로 증분 파싱에서도
// 따로 상태가 필요 없다. added가 없으면(같은 호출의 분할 레코드) 합계를 최신 메시지로 옮기기만 한다.
export function attachTurnTokenUsage(messages: HistoryMessage[], added: HistoryTokenUsage | null): void {
  let latestUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") { latestUser = index; break; }
  }
  // 도구 호출 메시지는 기본으로 숨겨지므로, 합계는 가장 최근의 보이는 답변에 우선 붙인다.
  let target = -1;
  let fallback = -1;
  let holder = -1;
  for (let index = messages.length - 1; index > latestUser; index -= 1) {
    if (messages[index].role !== "assistant") continue;
    if (fallback < 0) fallback = index;
    if (target < 0 && messages[index].kind !== "tool_call") target = index;
    if (holder < 0 && messages[index].tokenUsage) holder = index;
  }
  if (target < 0) target = fallback;
  if (target < 0) return;
  const previous = holder >= 0 ? messages[holder].tokenUsage! : null;
  const total = previous && added ? addTokenUsage(previous, added) : previous ?? added;
  if (!total) return;
  if (holder >= 0 && holder !== target) messages[holder] = { ...messages[holder], tokenUsage: undefined };
  messages[target] = { ...messages[target], tokenUsage: total };
}
