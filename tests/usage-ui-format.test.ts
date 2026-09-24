import { describe, expect, it } from "vitest";
import { formatUsageResetAt, isUsageFallbackNotice, usageErrorLabel } from "../src/client/lib/format";

describe("사용량 초기화 시각 한국 시간 표시", () => {
  const now = new Date("2026-09-23T04:00:00.000Z");

  it.each([
    ["2026-09-25T04:23:46.615Z", "09월 25일 13:23"],
    ["17:13 on 26 Sep", "09월 26일 17:13"],
    ["Sep 25, 1:23pm (Asia/Seoul)", "09월 25일 13:23"],
    ["September 25, 13:23", "09월 25일 13:23"],
    ["8:00pm (Asia/Seoul)", "09월 23일 20:00"],
  ])("%s를 날짜·시·분으로 통일한다", (value, expected) => {
    expect(formatUsageResetAt(value, now)).toBe(expected);
  });

  it("해석할 수 없는 레거시 문구는 정보 손실 없이 유지한다", () => {
    expect(formatUsageResetAt("다음 결제 주기")).toBe("다음 결제 주기");
  });
});

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
