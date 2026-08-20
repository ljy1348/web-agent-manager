import { describe, expect, it } from "vitest";
import { classifyFailureReason, looksLikeContextOverflow } from "../src/server/experiments/failure-classification";

describe("실패 원인 분류", () => {
  it("컨텍스트 초과 신호를 일반 실행 오류와 분리한다", () => {
    expect(classifyFailureReason("runtime_error", "stop_reason: model_context_window_exceeded")).toBe("context_exceeded");
    expect(classifyFailureReason("runtime_error", { subtype: "error", result: "prompt is too long" })).toBe("context_exceeded");
    expect(classifyFailureReason("runtime_error", "input length and `max_tokens` exceed context limit")).toBe("context_exceeded");
  });

  it("무관한 오류는 그대로 두고 이미 구조화된 이유는 덮어쓰지 않는다", () => {
    expect(classifyFailureReason("runtime_error", "ENOENT: command not found")).toBe("runtime_error");
    expect(classifyFailureReason("runtime_error", null)).toBe("runtime_error");
    // 예산·한도처럼 이미 확정된 이유는 문구와 무관하게 유지해야 한다.
    expect(classifyFailureReason("token_budget", "maximum context length")).toBe("token_budget");
    expect(classifyFailureReason("provider_limit", "context window")).toBe("provider_limit");
  });

  it("대소문자와 여러 증거를 함께 본다", () => {
    expect(looksLikeContextOverflow("Context Window Exceeded")).toBe(true);
    expect(looksLikeContextOverflow(null, undefined, "", "maximum CONTEXT length")).toBe(true);
    expect(looksLikeContextOverflow("정상 종료")).toBe(false);
  });
});
