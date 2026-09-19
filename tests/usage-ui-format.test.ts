import { describe, expect, it } from "vitest";
import { isUsageFallbackNotice, usageErrorLabel } from "../src/client/lib/format";

describe("사용량 fallback UI 의미", () => {
  it.each([
    ["usage_seeded_headers_throttled", "마지막 직접 확인값"],
    ["usage_seeded_persisted_throttled", "마지막 직접 확인값"],
    ["usage_seeded_headers_refresh_failed", "마지막 직접 확인값"],
    ["usage_seeded_persisted_refresh_failed", "마지막 직접 확인값"],
    ["usage_endpoint_throttled", "상세 조회 응답"],
    ["usage_refreshing", "갱신하는 중"],
  ])("%s를 사용자 quota 제한이 아닌 안내로 표시한다", (code, phrase) => {
    expect(isUsageFallbackNotice(code)).toBe(true);
    expect(usageErrorLabel(code)).toContain(phrase);
    expect(usageErrorLabel(code)).not.toMatch(/한도 초과|세션 제한|rate.?limit/i);
  });

  it("인증·파싱 실패는 fallback 안내로 숨기지 않는다", () => {
    expect(isUsageFallbackNotice("auth_required")).toBe(false);
    expect(isUsageFallbackNotice("parse_failed")).toBe(false);
  });
});
