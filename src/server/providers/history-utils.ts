import crypto from "node:crypto";

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
