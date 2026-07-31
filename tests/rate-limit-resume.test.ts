import { describe, expect, it } from "vitest";
import { isRateLimitRecovered, parseResetTime } from "../src/server/services/rate-limit-resume";

describe("parseResetTime", () => {
  it("타임존 없이 24시간 표기(Codex)를 오늘 남은 시각으로 해석한다", () => {
    const now = new Date(2026, 0, 1, 10, 0, 0);
    const result = parseResetTime("16:45", now);
    expect(result).toEqual(new Date(2026, 0, 1, 16, 45, 0, 0));
  });

  it("Codex 사용량 한도 문장의 try again at 시각을 오늘 남은 시각으로 해석한다", () => {
    const now = new Date(2026, 0, 1, 10, 0, 0);
    const result = parseResetTime("You've hit your usage limit, or try again at 2:15 PM", now);
    expect(result).toEqual(new Date(2026, 0, 1, 14, 15, 0, 0));
  });

  it("타임존 없이 오늘 이미 지난 시각이면 다음 날로 본다", () => {
    const now = new Date(2026, 0, 1, 20, 0, 0);
    const result = parseResetTime("16:45", now);
    expect(result).toEqual(new Date(2026, 0, 2, 16, 45, 0, 0));
  });

  it("am/pm과 타임존이 있는 표기(Claude)를 UTC로 정확히 환산한다", () => {
    // 2026-07-08T00:00:00Z = 서울(UTC+9) 기준 07-08 09:00 — 아직 17:39(=UTC 08:39)가 안 지났으므로 오늘.
    const now = new Date("2026-07-08T00:00:00.000Z");
    const result = parseResetTime("5:39pm (Asia/Seoul)", now);
    expect(result?.toISOString()).toBe("2026-07-08T08:39:00.000Z");
  });

  it("타임존 있는 표기가 이미 지났으면 다음 날 같은 시각(UTC)으로 넘어간다", () => {
    // 2026-07-08T10:00:00Z = 서울 기준 19:00 — 17:39는 이미 지났으므로 다음 날.
    const now = new Date("2026-07-08T10:00:00.000Z");
    const result = parseResetTime("5:39pm (Asia/Seoul)", now);
    expect(result?.toISOString()).toBe("2026-07-09T08:39:00.000Z");
  });

  it("자정 시각(12am)도 정오(12pm)와 구분해 올바르게 해석한다", () => {
    const now = new Date(2026, 0, 1, 0, 30, 0);
    expect(parseResetTime("12:00am", now)).toEqual(new Date(2026, 0, 2, 0, 0, 0, 0));
    expect(parseResetTime("12:00pm", now)).toEqual(new Date(2026, 0, 1, 12, 0, 0, 0));
  });

  it("Codex가 요일 없는 전체 날짜까지 찍는 새 한도 문장(월 일, 연도 시:분 am/pm)을 정확히 해석한다", () => {
    // 실사용 재현: 기존 시:분 전용 패턴은 "Jul"부터 숫자가 아니라 매칭이 안 돼 아예 등록되지 않았다.
    const now = new Date(2026, 6, 12, 20, 0, 0);
    const result = parseResetTime("You've hit your usage limit. ... or try again at Jul 13th, 2026 12:14 AM.", now);
    expect(result).toEqual(new Date(2026, 6, 13, 0, 14, 0, 0));
  });

  it("전체 날짜 형식은 이미 지난 시각이어도(오늘/내일 추측 없이) 명시된 날짜를 그대로 신뢰한다", () => {
    const now = new Date(2026, 6, 13, 23, 0, 0);
    const result = parseResetTime("try again at Jul 13th, 2026 12:14 AM.", now);
    expect(result).toEqual(new Date(2026, 6, 13, 0, 14, 0, 0));
  });

  it("빈 값이나 시각을 못 찾으면 null을 반환한다", () => {
    const now = new Date();
    expect(parseResetTime(null, now)).toBeNull();
    expect(parseResetTime(undefined, now)).toBeNull();
    expect(parseResetTime("잠시 후", now)).toBeNull();
  });
});

describe("isRateLimitRecovered", () => {
  // 실제 운영 중 재현된 버그: rate_limit_options로 대기가 걸린 뒤 그 창이 자연 롤링 리셋되고 usage_status가
  // 다음 예정 리셋(reset_at)으로 이미 갱신된 경우 — reset_at만 보면 "아직 안 지났다"며 영원히 대기한다.
  it("예정 리셋 시각이 아직 안 지났어도 사용량이 이미 회복됐으면 재개 대상으로 본다", () => {
    const now = new Date("2026-07-08T09:00:00.000Z");
    // reset_at은 서울 기준 오늘 22:40(=UTC 13:40) — 아직 안 지남.
    expect(isRateLimitRecovered("10:40pm (Asia/Seoul)", 87, now)).toBe(true);
  });

  it("리셋 시각도 안 지났고 사용량도 회복 전이면 계속 대기한다", () => {
    const now = new Date("2026-07-08T09:00:00.000Z");
    expect(isRateLimitRecovered("10:40pm (Asia/Seoul)", 3, now)).toBe(false);
  });

  // parseResetTime은 "지금 기준으로 다음에 돌아올 시각"만 계산하고 등록 당시의 절대 목표 시각을 따로
  // 저장하지 않아, 매 tick마다 새로 파싱한 결과는 항상 now보다 미래다(이미 지났으면 다음 날로 넘어가
  // 버림) — 그래서 시각 경과만으로 회복을 판단하는 경로는 사실상 항상 false가 되고, 실제로는 아래
  // remaining_percent 판정이 주력이다. 사용량 정보가 아예 없는 극단적인 경우에도 무한 대기하지 않는지만 확인한다.
  it("사용량 정보가 없으면 예정 리셋 시각도 항상 미래로 계산돼 재개하지 않는다", () => {
    const now = new Date("2026-07-08T20:00:00.000Z");
    expect(isRateLimitRecovered("10:40pm (Asia/Seoul)", null, now)).toBe(false);
  });

  it("회복 기준(10%) 미만이면 재개하지 않는다", () => {
    const now = new Date("2026-07-08T09:00:00.000Z");
    expect(isRateLimitRecovered("10:40pm (Asia/Seoul)", 9, now)).toBe(false);
    expect(isRateLimitRecovered("10:40pm (Asia/Seoul)", 10, now)).toBe(true);
  });
});
