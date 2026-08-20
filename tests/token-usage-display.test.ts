import { describe, expect, it } from "vitest";
import { compactTokenCount, tokenUsageLabel } from "../src/client/lib/token-usage";

describe("채팅 토큰 사용량 표시", () => {
  it("큰 토큰 수를 좁은 K·M 단위로 줄인다", () => {
    expect(compactTokenCount(999)).toBe("999");
    expect(compactTokenCount(20264)).toBe("20.3K");
    expect(compactTokenCount(1_250_000)).toBe("1.3M");
  });

  it("값이 있는 공급자별 항목만 작은 설명 문구에 포함한다", () => {
    expect(tokenUsageLabel({ totalTokens: 20264, inputTokens: 2, cacheCreationInputTokens: 6519, cacheReadInputTokens: 13740, outputTokens: 3 })).toBe(
      "토큰 20.3K · 입력 2 · 캐시 생성 6.5K · 캐시 읽기 13.7K · 출력 3",
    );
    expect(tokenUsageLabel({ totalTokens: 50137, inputTokens: 50049, cachedInputTokens: 48896, outputTokens: 88, reasoningOutputTokens: 15 })).toBe(
      "토큰 50.1K · 입력 50K · 캐시 48.9K · 출력 88 · 추론 15",
    );
  });

  it("usage가 없는 과거 메시지는 아무것도 표시하지 않는다", () => {
    expect(tokenUsageLabel(undefined)).toBe("");
    expect(tokenUsageLabel({ totalTokens: 0 })).toBe("");
  });
});
