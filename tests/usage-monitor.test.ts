import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../src/server/providers/codex";
import { ClaudeAdapter } from "../src/server/providers/claude";
import { claudeUsageBackoffMs, decideFreshUsageAdoption, detectUsageKeepaliveReason, detectUsageKeepaliveTrigger, detectUsageRegression, isClaudeUsageFallbackError, isImplausibleClaudeSessionReset, isMonitorTerminalAged, isSameUsageKeepaliveWindow, isUsageDetailsDue, isUsageKeepaliveDue, mergeCodexResetCredits, reconcileStaleClaudeSessionWindow } from "../src/server/services/usage-monitor";
import { parseResetTime } from "../src/server/services/rate-limit-resume";
import { isExpiredResetTime, todayResetTime } from "../src/server/providers/usage-utils";

const codex = new CodexAdapter();
const claude = new ClaudeAdapter("/tmp/claude-settings.json", {});

// detectUsageRegression 테스트용 details_json을 만든다.
function details(windows: Array<{ id: string; usedPercent: number | null; resetAt: string | null }>): string {
  return JSON.stringify({ windows: windows.map((window) => ({ label: window.id, remainingPercent: null, ...window })) });
}

describe("실제 TUI 사용량 파서", () => {
  it("Codex /status와 /usage 활동 정보를 구조화한다", () => {
    const screen = `
/usage weekly
Token activity   last 12 months
Lifetime 329M · Peak 28.4M · Streak 1d
Each column = 1 week · tallest 62.2M
/status
│  5h limit:       [███░░░░░░░░░░░░░░░░░] 13% left (resets 16:56) │
│  Weekly limit:   [███████████████░░░░░] 75% left                │
│                  (resets 19:05 on 9 Jul)                         │`;
    const parsed = codex.parseUsage(screen, new Date("2026-07-09T06:00:00.000Z"));
    const details = JSON.parse(parsed.details_json!);
    expect(parsed.data_status).toBe("fresh");
    expect(details.windows).toEqual([
      { id: "weekly", label: "Weekly limit", usedPercent: 25, remainingPercent: 75, resetAt: "19:05 on 9 Jul" },
      { id: "five_hour", label: "5h limit", usedPercent: 87, remainingPercent: 13, resetAt: "16:56" },
    ]);
    // 다시 제공되는 5시간 창이 대표값이라 채팅 상태바·위젯·자동 재개가 이 수치를 사용한다.
    expect(codex.usageWindowId).toBe("five_hour");
    expect(parsed.used_percent).toBe(87);
    expect(parsed.remaining_percent).toBe(13);
    expect(parsed.reset_at).toBe("16:56");
    expect(details.activity).toHaveLength(2);
  });

  it("Codex 초기화권 상세 화면의 개수와 기한도 함께 구조화한다", () => {
    const screen = `Weekly limit: 94% left (resets 09:17 on 18 Aug)
Usage limit resets
1 usage limit reset available.
1. Full reset  Expires 02:28 on 13 Aug 2026.`;
    const parsed = codex.parseUsage(screen);
    const credits = JSON.parse(parsed.details_json!).rateLimitResetCredits;

    expect(credits.availableCount).toBe(1);
    expect(new Date(credits.expiresAt).getHours()).toBe(2);
    expect(new Date(credits.expiresAt).getMinutes()).toBe(28);
  });

  // Codex 0.148.0의 /status에는 "gpt-reserve Weekly limit"이 진짜 "Weekly limit"보다 위에 나온다.
  // 라벨을 includes로 찾으면 이쪽이 먼저 걸려, 실제로는 54% 사용 중인 창을 0%로 읽고 리셋 시각도
  // 매분 밀리는 값으로 표시했다(#60). 그 오파싱이 "초기화됐다"는 오판과 알림 중복까지 불렀다.
  it("Codex /status의 gpt-reserve가 아니라 진짜 주간 한도를 읽는다", () => {
    const screen = `/status
╭────────────────────────────────────────────────────────────────────────────────────────╮
│  >_ OpenAI Codex (v0.148.0)                                                            │
│  gpt-reserve Weekly limit:   [████████████████████] 100% left (resets 11:46 on 29 Aug) │
│  Weekly limit:               [█████████░░░░░░░░░░░] 46% left (resets 12:43 on 27 Aug)  │
╰────────────────────────────────────────────────────────────────────────────────────────╯`;
    const parsed = codex.parseUsage(screen);
    expect(parsed.used_percent).toBe(54);
    expect(parsed.reset_at).toBe("12:43 on 27 Aug");
  });

  it("Claude /usage의 현재 모델명이 달라도 모든 구간을 추출한다", () => {
    const screen = `Current session
49% 49% used
Resets 4:09pm (Asia/Seoul)
Current week (all models)
25% 25% used
Resets Jul 11, 12:59am (Asia/Seoul)
Current week (Future Model)
5% 5% used
Resets Jul 11, 12:59am (Asia/Seoul)`;
    const parsed = claude.parseUsage(screen, new Date("2026-07-10T06:00:00.000Z"));
    const details = JSON.parse(parsed.details_json!);
    expect(parsed.data_status).toBe("fresh");
    expect(details.windows.map((window: { usedPercent: number }) => window.usedPercent)).toEqual([49, 25, 5]);
    expect(details.windows[2].label).toBe("Current week (Future Model)");
  });

  it("Claude 일반 TUI /usage의 진행 막대 형식도 사용량으로 추출한다", () => {
    const screen = `Current session
██████████████████████▌                            45% used
Resets 7:10pm (Asia/Seoul)

Current week (all models)
████████                                           16% used
Resets Jul 11, 1am (Asia/Seoul)`;
    const parsed = claude.parseUsage(screen, new Date("2026-07-10T06:00:00.000Z"));
    const details = JSON.parse(parsed.details_json!);
    expect(parsed.data_status).toBe("fresh");
    expect(details.windows.map((window: { usedPercent: number }) => window.usedPercent)).toEqual([45, 16]);
    expect(parsed.reset_at).toBe("7:10pm (Asia/Seoul)");
  });

  it("Claude가 밤에 표시한 날짜 없는 새벽 리셋은 다음 날의 5시간 창으로 해석한다", () => {
    const screen = `Current session
40% 40% used
Resets 1am (Asia/Seoul)
Current week (all models)
30% 30% used
Resets Sep 12, 1am (Asia/Seoul)`;
    const parsed = claude.parseUsage(screen, new Date("2026-09-08T13:53:55.000Z")); // 서울 22:53

    expect(parsed).toMatchObject({
      data_status: "fresh",
      error_code: null,
      used_percent: 40,
      remaining_percent: 60,
      reset_at: "1am (Asia/Seoul)",
    });
  });

  it("인증 요구 화면은 사용 불가로 표시한다", () => {
    const parsed = claude.parseUsage("Login required. Sign in to continue.");
    expect(parsed).toMatchObject({ data_status: "unavailable", error_code: "auth_required" });
  });

  it("파싱 실패 때는 이전 사용량 캐시를 덮지 않도록 details_json을 비워둔다", () => {
    const parsed = codex.parseUsage("temporary spinner without usage data");
    expect(parsed).toMatchObject({ data_status: "unavailable", error_code: "parse_failed" });
    expect(parsed.details_json).toBeNull();
  });

  // Claude 2.1.251 설치본의 seeded/loading 문구 전체를 fixture로 고정한다. 어느 변형이든 막대 숫자는
  // live endpoint 응답이 아니므로 파서가 반환하거나 DB에 채택하면 안 된다.
  it.each([
    ["헤더 seed + 상세 제한", "Per-model breakdown unavailable (rate limited — try again in a moment)", "usage_seeded_headers_throttled"],
    ["영속 seed + 상세 제한", "Showing last-known usage as of 5m ago (rate limited — try again in a moment)", "usage_seeded_persisted_throttled"],
    ["헤더 seed + 갱신 실패", "Could not refresh usage data", "usage_seeded_headers_refresh_failed"],
    ["영속 seed + 갱신 실패", "Showing last-known usage as of 5m ago (could not refresh)", "usage_seeded_persisted_refresh_failed"],
    ["갱신 진행 중", "Refreshing…", "usage_refreshing"],
  ])("Claude /usage %s 화면의 퍼센트를 성공 스냅샷으로 쓰지 않는다", (_label, footer, errorCode) => {
    const screen = `you: /usage
Settings  Status   Config   Usage   Stats
Session
Total cost:            $0.0000
Current session
1% 1% used
Resets 8:30am (Asia/Seoul)
Current week (all models)
1% 1% used
Resets Sep 5, 1am (Asia/Seoul)
${footer}
r to retry · Esc to cancel`;
    const parsed = claude.parseUsage(screen, new Date("2026-08-30T21:34:00.000Z"));
    expect(parsed).toMatchObject({
      data_status: "stale",
      error_code: errorCode,
      used_percent: null,
      remaining_percent: null,
      reset_at: null,
      details_json: null,
    });
  });

  it("Claude usage endpoint 제한은 사용자 session quota 초과와 다른 상태로 분류한다", () => {
    const parsed = claude.parseUsage("Usage endpoint is rate limited. Please try again in a moment.");
    expect(parsed).toMatchObject({ data_status: "stale", error_code: "usage_endpoint_throttled", used_percent: null, details_json: null });
    expect(claude.detectApproval("⎿  You've hit your session limit · resets 7:10pm (Asia/Seoul)\n$ ")).toMatchObject({ requestType: "session_limit_notice" });
  });

  // 실측 23:30: Current session이 `0% used`만 있고 Resets가 없으면 세션 창이 빠지고 주간 4%가
  // 대표값으로 fresh 저장됐다. 5시간 25%를 덮으면 안 된다.
  it("Claude 세션 블록에 Resets가 없으면 주간 숫자로 5시간 창을 덮지 않는다", () => {
    const screen = `Current session
0% 0% used
Current week (all models)
4% 4% used
Resets Sep 5, 1am (Asia/Seoul)
Esc to cancel`;
    const parsed = claude.parseUsage(screen, new Date("2026-08-30T23:30:33.000Z"));
    expect(parsed).toMatchObject({
      data_status: "stale",
      used_percent: null,
      error_code: null,
    });
    expect(JSON.parse(parsed.details_json!).windows).toEqual([
      { id: "session", label: "Current session", usedPercent: 0, remainingPercent: 100, resetAt: null },
      { id: "weekly_all", label: "Current week (all models)", usedPercent: 4, remainingPercent: 96, resetAt: "Sep 5, 1am (Asia/Seoul)" },
    ]);
  });

  // 실제 운영 중 재현된 버그: 조회 전용 PTY를 며칠씩 켜두고 반복 조회하면 Claude CLI가 이미 지난
  // 리셋 시각을 그대로 돌려주는 경우가 있었다(예: 지금은 오전 10시인데 세션 리셋이 "오전 3시 40분"
  // 이었다고 나옴 — 실제라면 있을 수 없는 값). 날짜 없는 리셋 문구가 이미 지났으면 fresh 대신
  // stale로 표시해야 대시보드가 오래된 값을 최신인 것처럼 보여주지 않는다.
  it("세션 리셋 시각이 이미 지났으면 fresh 대신 stale로 표시한다", () => {
    const now = new Date("2026-07-09T01:24:00.000Z"); // 서울 기준 오전 10:24
    const screen = `Current session
15% 15% used
Resets 3:40am (Asia/Seoul)
Current week (all models)
97% 97% used
Resets Jul 11, 12:59am (Asia/Seoul)`;
    const parsed = claude.parseUsage(screen, now);
    expect(parsed.data_status).toBe("stale");
  });

  it("세션 리셋 시각이 아직 안 지났으면 정상적으로 fresh로 표시한다", () => {
    const now = new Date("2026-07-09T01:24:00.000Z"); // 서울 기준 오전 10:24
    const screen = `Current session
5% 5% used
Resets 3:09pm (Asia/Seoul)
Current week (all models)
97% 97% used
Resets Jul 11, 12:59am (Asia/Seoul)`;
    const parsed = claude.parseUsage(screen, now);
    expect(parsed.data_status).toBe("fresh");
  });

  // 날짜가 붙은 주간 구간("Jul 11, ...")은 요일이 다른 리셋 문구라 시:분만 보고 스테일 여부를
  // 판단하면 안 된다 — 검사 대상에서 제외되어야 세션 창만 지나도 주간 구간까지 stale로 오염되지 않는다.
  it("날짜가 포함된 주간 리셋 문구는 스테일 검사 대상에서 제외한다", () => {
    const now = new Date("2026-07-09T01:24:00.000Z");
    const screen = `Current session
5% 5% used
Resets 3:09pm (Asia/Seoul)
Current week (all models)
97% 97% used
Resets Jul 11, 12:59am (Asia/Seoul)
Current week (Old Model)
2% 2% used
Resets Jul 2, 12:59am (Asia/Seoul)`;
    const parsed = claude.parseUsage(screen, now);
    expect(parsed.data_status).toBe("fresh");
  });

  // 실제 운영 중 재현된 두 번째 스테일 유형: 리셋 시각은 아직 미래인데 퍼센트만 과거 값으로
  // 후퇴하는 경우(실측: 실제 56% 사용 시점에 1시간 전 값 26%를 최신인 척 반환). 같은 리셋
  // 시각의 창에서 사용량은 누적만 되므로, 줄었다면 CLI가 옛 스냅샷을 돌려준 것이다.
  it("같은 리셋 시각의 창에서 사용량이 줄면 옛 스냅샷(regression)으로 감지한다", () => {
    const previous = details([{ id: "session", usedPercent: 56, resetAt: "2:10pm (Asia/Seoul)" }]);
    const regressed = details([{ id: "session", usedPercent: 26, resetAt: "2:10pm (Asia/Seoul)" }]);
    expect(detectUsageRegression(previous, regressed)).toBe(true);
  });

  it("사용량이 증가하거나 그대로면 regression이 아니다", () => {
    const previous = details([{ id: "session", usedPercent: 56, resetAt: "2:10pm (Asia/Seoul)" }]);
    expect(detectUsageRegression(previous, details([{ id: "session", usedPercent: 61, resetAt: "2:10pm (Asia/Seoul)" }]))).toBe(false);
    expect(detectUsageRegression(previous, details([{ id: "session", usedPercent: 56, resetAt: "2:10pm (Asia/Seoul)" }]))).toBe(false);
  });

  it("리셋 시각이 달라졌으면 창이 실제로 넘어간 것이므로 사용량 감소를 정상으로 본다", () => {
    const previous = details([{ id: "session", usedPercent: 96, resetAt: "2:10pm (Asia/Seoul)" }]);
    const nextWindow = details([{ id: "session", usedPercent: 1, resetAt: "7:10pm (Asia/Seoul)" }]);
    expect(detectUsageRegression(previous, nextWindow)).toBe(false);
  });

  // 실측: CLI가 같은 창의 리셋 시각을 조회 시점에 따라 "2:09pm"↔"2:10pm"처럼 1분 다르게 보여준다.
  // 문자열 완전 일치로 창을 구분하면 이 표기 오차 때문에 옛 스냅샷(86%→66% 후퇴)이 "다른 창"으로
  // 오판돼 그대로 통과했다 — 몇 분 이내 오차는 같은 창으로 보고 후퇴를 잡아야 한다.
  it("리셋 시각이 1분 오차로 다르게 표기돼도 같은 창으로 보고 후퇴를 감지한다", () => {
    const previous = details([{ id: "session", usedPercent: 86, resetAt: "2:10pm (Asia/Seoul)" }]);
    const jittered = details([{ id: "session", usedPercent: 66, resetAt: "2:09pm (Asia/Seoul)" }]);
    expect(detectUsageRegression(previous, jittered)).toBe(true);
  });

  it("날짜가 붙은 주간 창도 분 단위 표기 오차(12:59am↔1am)는 같은 창으로 본다", () => {
    const previous = details([{ id: "weekly_all", usedPercent: 9, resetAt: "Jul 11, 1am (Asia/Seoul)" }]);
    const jittered = details([{ id: "weekly_all", usedPercent: 3, resetAt: "Jul 11, 12:59am (Asia/Seoul)" }]);
    expect(detectUsageRegression(previous, jittered)).toBe(true);
  });

  it("주간 창의 날짜 자체가 바뀌었으면(실제 주간 리셋) 감소를 정상으로 본다", () => {
    const previous = details([{ id: "weekly_all", usedPercent: 97, resetAt: "Jul 11, 1am (Asia/Seoul)" }]);
    const nextWeek = details([{ id: "weekly_all", usedPercent: 2, resetAt: "Jul 18, 1am (Asia/Seoul)" }]);
    expect(detectUsageRegression(previous, nextWeek)).toBe(false);
  });

  it("이전 기록이 없거나 details가 비어 있으면 regression이 아니다", () => {
    expect(detectUsageRegression(null, details([{ id: "session", usedPercent: 5, resetAt: "2:10pm" }]))).toBe(false);
    expect(detectUsageRegression(details([{ id: "session", usedPercent: 5, resetAt: "2:10pm" }]), null)).toBe(false);
    expect(detectUsageRegression("깨진 JSON", details([{ id: "session", usedPercent: 5, resetAt: "2:10pm" }]))).toBe(false);
  });

  it("같은 날짜에서 주간이 0%면 바로 채택하지 않고 2회 뒤 PTY 재시작 후 확정한다", () => {
    const previous = details([
      { id: "session", usedPercent: 1, resetAt: "3:49am (Asia/Seoul)" },
      { id: "weekly_all", usedPercent: 21, resetAt: "Sep 5, 12:59am (Asia/Seoul)" },
    ]);
    const parsed = {
      data_status: "fresh" as const,
      used_percent: 0,
      remaining_percent: 100,
      reset_at: "1:50pm (Asia/Seoul)",
      details_json: details([
        { id: "session", usedPercent: 0, resetAt: "1:50pm (Asia/Seoul)" },
        { id: "weekly_all", usedPercent: 0, resetAt: "Sep 5, 1am (Asia/Seoul)" },
      ]),
    };
    const idle = { streak: 0, recycled: false };
    const first = decideFreshUsageAdoption(parsed, previous, "session", idle);
    expect(first.kind).toBe("hold-zero");
    if (first.kind !== "hold-zero") throw new Error("expected hold-zero");
    expect(first.recycle).toBe(false);
    expect(JSON.parse(first.record.details_json!).windows).toEqual([
      { id: "session", label: "session", remainingPercent: null, usedPercent: 0, resetAt: "1:50pm (Asia/Seoul)" },
      { id: "weekly_all", label: "weekly_all", remainingPercent: null, usedPercent: 21, resetAt: "Sep 5, 12:59am (Asia/Seoul)" },
    ]);

    const second = decideFreshUsageAdoption(parsed, first.record.details_json, "session", first.zeroConfirm);
    expect(second).toMatchObject({ kind: "hold-zero", recycle: true, zeroConfirm: { streak: 2, recycled: true } });

    const confirmed = decideFreshUsageAdoption(parsed, first.record.details_json, "session", { streak: 2, recycled: true });
    expect(confirmed).toEqual({ kind: "adopt", record: parsed, zeroConfirm: { streak: 0, recycled: false } });
  });

  it("대표 세션 창이 같은 리셋에서 0이 아닌 값으로 줄면 스냅샷 전체를 거절한다", () => {
    const previous = details([{ id: "session", usedPercent: 56, resetAt: "2:10pm (Asia/Seoul)" }]);
    const parsed = { data_status: "fresh" as const, details_json: details([{ id: "session", usedPercent: 26, resetAt: "2:10pm (Asia/Seoul)" }]) };
    expect(decideFreshUsageAdoption(parsed, previous, "session", { streak: 0, recycled: false })).toEqual({
      kind: "reject",
      zeroConfirm: { streak: 0, recycled: false },
    });
  });
});

describe("Codex 초기화권 사용량 상세 병합", () => {
  it("상세 조회는 최초 1회와 24시간이 지난 뒤에만 수행한다", () => {
    const now = Date.parse("2026-08-11T02:00:00.000Z");
    expect(isUsageDetailsDue(undefined, now)).toBe(true);
    expect(isUsageDetailsDue(now - 23 * 60 * 60_000, now)).toBe(false);
    expect(isUsageDetailsDue(now - 24 * 60 * 60_000, now)).toBe(true);
  });

  it("새 초기화권 정보를 기존 사용량 창과 함께 저장한다", () => {
    const merged = mergeCodexResetCredits(
      JSON.stringify({ windows: [{ id: "weekly" }] }),
      { availableCount: 2, expiresAt: "2026-08-12T17:28:18.000Z" },
    );

    expect(JSON.parse(merged!)).toEqual({
      windows: [{ id: "weekly" }],
      rateLimitResetCredits: { availableCount: 2, expiresAt: "2026-08-12T17:28:18.000Z" },
    });
  });

  it("일시 조회 실패 시 직전 초기화권 정보를 유지한다", () => {
    const previous = JSON.stringify({ rateLimitResetCredits: { availableCount: 1, expiresAt: "2026-08-12T17:28:18.000Z" } });
    const merged = mergeCodexResetCredits(JSON.stringify({ windows: [] }), null, previous);

    expect(JSON.parse(merged!).rateLimitResetCredits).toEqual({ availableCount: 1, expiresAt: "2026-08-12T17:28:18.000Z" });
  });

  it("새 응답이 같은 개수만 주면 TUI 또는 직전 정상 기한을 보존한다", () => {
    const previous = JSON.stringify({ rateLimitResetCredits: { availableCount: 1, expiresAt: "2026-08-12T17:28:18.000Z" } });
    const current = JSON.stringify({ windows: [], rateLimitResetCredits: { availableCount: 1, expiresAt: null } });
    const merged = mergeCodexResetCredits(current, { availableCount: 1, expiresAt: null }, previous);

    expect(JSON.parse(merged!).rateLimitResetCredits).toEqual({ availableCount: 1, expiresAt: "2026-08-12T17:28:18.000Z" });
  });

  it("초기화권 개수가 바뀌면 이전 개수의 기한은 이어받지 않는다", () => {
    const previous = JSON.stringify({ rateLimitResetCredits: { availableCount: 1, expiresAt: "2026-08-12T17:28:18.000Z" } });
    const merged = mergeCodexResetCredits(JSON.stringify({ windows: [] }), { availableCount: 0, expiresAt: null }, previous);

    expect(JSON.parse(merged!).rateLimitResetCredits).toEqual({ availableCount: 0, expiresAt: null });
  });
});

describe("reconcileStaleClaudeSessionWindow", () => {
  // 실제 운영 중 재현된 문제: 세션 리셋 시각이 지나도 Claude CLI가 "Current session" 블록을 통째로
  // 안 보여주는 게 아니라, 리셋 전 마지막 스냅샷(옛 퍼센트·옛 리셋 시각)을 계속 그대로 돌려준다.
  // parseUsage 자체는 이미 이걸 stale로 잡아내지만(위 "세션 리셋 시각이 이미 지났으면..." 테스트),
  // stale이어도 화면엔 그 오래된 숫자가 그대로 남아 사실상 안 바뀌는 것처럼 보였다.
  it("리셋 시각이 2분 이상 지난 세션 창은 0%·5시간 뒤 재리셋으로 바꾸고 fresh로 되돌린다", () => {
    const now = new Date("2026-07-09T01:24:00.000Z"); // 서울 기준 오전 10:24
    const parsed = new ClaudeAdapter("/tmp/x.json", {}).parseUsage(`Current session
15% 15% used
Resets 3:40am (Asia/Seoul)
Current week (all models)
97% 97% used
Resets Jul 11, 12:59am (Asia/Seoul)`, now);
    expect(parsed.data_status).toBe("stale");

    const reconciled = reconcileStaleClaudeSessionWindow(parsed, now);
    expect(reconciled.data_status).toBe("fresh");
    const windows = JSON.parse(reconciled.details_json!).windows;
    expect(windows[0]).toMatchObject({ id: "session", usedPercent: 0, remainingPercent: 100 });
    // 서울 기준 3:40am + 5시간 = 8:40am.
    expect(windows[0].resetAt).toBe("8:40am (Asia/Seoul)");
    // 화면의 primary 표시(맨 앞 창)도 세션 창이라 함께 갱신돼야 한다.
    expect(reconciled.used_percent).toBe(0);
    expect(reconciled.remaining_percent).toBe(100);
    expect(reconciled.reset_at).toBe("8:40am (Asia/Seoul)");
  });

  it("리셋 시각이 아직 2분 여유 안이면(반영 지연 가능성) 그대로 둔다", () => {
    const now = new Date("2026-07-09T01:24:00.000Z"); // 서울 기준 오전 10:24
    const parsed = new ClaudeAdapter("/tmp/x.json", {}).parseUsage(`Current session
15% 15% used
Resets 10:23am (Asia/Seoul)
Current week (all models)
97% 97% used
Resets Jul 11, 12:59am (Asia/Seoul)`, now);
    const reconciled = reconcileStaleClaudeSessionWindow(parsed, now);
    expect(reconciled).toEqual(parsed);
  });

  it("자정을 넘겨 곧 돌아올 새벽 리셋 시각(예: 12:40am)은 이미 지난 옛 스냅샷으로 오판해 0%로 덮어쓰지 않는다", () => {
    // 실사용 재현: 저녁 9시 45분에 "12:40am 리셋" 원본을 받으면, todayResetTime이 이걸 "오늘 자정
    // 직후(00:40)"로 계산해 21시간 전으로 보고 무조건 "옛 스냅샷"이라며 방금 받은 진짜 최신 값
    // (47% 사용)을 0%로 덮어썼다. 실제로는 오늘 밤 자정을 넘겨 약 3시간 뒤 돌아올 리셋이다.
    const now = new Date("2026-07-13T12:45:45.000Z"); // 서울 기준 오후 9:45:45
    const parsed = new ClaudeAdapter("/tmp/x.json", {}).parseUsage(`Current session
47% 47% used
Resets 12:40am (Asia/Seoul)
Current week (all models)
47% 47% used
Resets Jul 18, 1am (Asia/Seoul)`, now);
    const reconciled = reconcileStaleClaudeSessionWindow(parsed, now);
    expect(reconciled).toEqual(parsed);
    const windows = JSON.parse(reconciled.details_json!).windows;
    expect(windows[0]).toMatchObject({ id: "session", usedPercent: 47, resetAt: "12:40am (Asia/Seoul)" });
  });

  it("정말 몇 시간~반나절 전에 지난 리셋 시각은(24시간 롤포워드해도 5시간 윈도우 밖) 그대로 0%로 보정한다", () => {
    // 자정 넘김 오판 방지 로직을 추가했다고 진짜 오래 지난 stale 케이스까지 통과시키면 안 된다 —
    // 위 "리셋 시각이 2분 이상 지난 세션 창" 테스트와 같은 종류지만 자정을 넘기지 않는 오후 시각으로도
    // 회귀를 확인한다.
    const now = new Date("2026-07-13T12:45:45.000Z"); // 서울 기준 오후 9:45:45
    const parsed = new ClaudeAdapter("/tmp/x.json", {}).parseUsage(`Current session
15% 15% used
Resets 3:40pm (Asia/Seoul)
Current week (all models)
97% 97% used
Resets Jul 18, 1am (Asia/Seoul)`, now);
    const reconciled = reconcileStaleClaudeSessionWindow(parsed, now);
    expect(reconciled.data_status).toBe("fresh");
    const windows = JSON.parse(reconciled.details_json!).windows;
    expect(windows[0]).toMatchObject({ id: "session", usedPercent: 0, remainingPercent: 100 });
    // 서울 기준 3:40pm + 5시간 = 8:40pm.
    expect(windows[0].resetAt).toBe("8:40pm (Asia/Seoul)");
  });

  it("세션 리셋이 아직 안 지나 fresh인 경우엔 손대지 않는다", () => {
    const now = new Date("2026-07-09T01:24:00.000Z");
    const parsed = new ClaudeAdapter("/tmp/x.json", {}).parseUsage(`Current session
5% 5% used
Resets 3:09pm (Asia/Seoul)
Current week (all models)
97% 97% used
Resets Jul 11, 12:59am (Asia/Seoul)`, now);
    expect(parsed.data_status).toBe("fresh");
    expect(reconcileStaleClaudeSessionWindow(parsed, now)).toEqual(parsed);
  });

  it("새 화면에 세션 Resets가 없고 직전 리셋이 지났으면 저장 창을 0%로 보정한다", () => {
    const now = new Date("2026-09-01T13:21:00.000Z"); // 서울 기준 오후 10:21
    const parsed = new ClaudeAdapter("/tmp/x.json", {}).parseUsage(`Current session
0% 0% used
Current week (all models)
21% 21% used
Resets Sep 5, 1am (Asia/Seoul)`, now);
    const previous = JSON.stringify({ windows: [
      { id: "session", label: "Current session", usedPercent: 14, remainingPercent: 86, resetAt: "8:50pm (Asia/Seoul)" },
      { id: "weekly_all", label: "Current week (all models)", usedPercent: 21, remainingPercent: 79, resetAt: "Sep 5, 1am (Asia/Seoul)" },
    ] });

    const reconciled = reconcileStaleClaudeSessionWindow(parsed, now, previous);
    expect(reconciled).toMatchObject({ data_status: "fresh", used_percent: 0, remaining_percent: 100, error_code: null, reset_at: "1:50am (Asia/Seoul)" });
    expect(JSON.parse(reconciled.details_json!).windows).toEqual([
      { id: "session", label: "Current session", usedPercent: 0, remainingPercent: 100, resetAt: "1:50am (Asia/Seoul)" },
      { id: "weekly_all", label: "Current week (all models)", usedPercent: 21, remainingPercent: 79, resetAt: "Sep 5, 1am (Asia/Seoul)" },
    ]);
  });

  it("직전 세션 리셋이 아직이면 Resets 없는 0%로 저장 값을 덮지 않는다", () => {
    const now = new Date("2026-08-30T23:30:33.000Z");
    const parsed = new ClaudeAdapter("/tmp/x.json", {}).parseUsage(`Current session
0% 0% used
Current week (all models)
4% 4% used
Resets Sep 5, 1am (Asia/Seoul)`, now);
    const previous = JSON.stringify({ windows: [
      { id: "session", label: "Current session", usedPercent: 25, remainingPercent: 75, resetAt: "Aug 31, 3:00am (Asia/Seoul)" },
    ] });

    expect(reconcileStaleClaudeSessionWindow(parsed, now, previous)).toEqual(parsed);
    expect(parsed.used_percent).toBeNull();
  });
});

// Claude CLI는 정각 리셋을 "6pm"처럼 분 없이 찍는데, 예전 정규식이 분을 필수로 요구해 이 표기를
// 통째로 못 읽었다. 그 탓에 옛 스냅샷 방어 로직 3개가 정각 표기에서만 무력화돼, 5시간 롤링 창인데
// 8시간 뒤인 리셋 시각이 fresh로 채택됐다(실사용 재현 — #53).
describe("정각 리셋 표기 파싱", () => {
  const now = new Date("2026-08-22T00:57:00.000Z"); // 서울 기준 오전 9:57

  it("분이 없는 정각 표기도 시각으로 읽는다", () => {
    // getHours()는 실행 환경의 로컬 타임존으로 표시해 KST에서만 18이 나오고 UTC CI에서는 9가 된다.
    // 파싱 결과 자체는 타임존과 무관한 같은 절대 시각이므로 ISO로 비교한다(서울 18시 = 09:00Z).
    expect(todayResetTime("6pm (Asia/Seoul)", now)?.toISOString()).toBe("2026-08-22T09:00:00.000Z");
    expect(todayResetTime("3am (Asia/Seoul)", now)?.toISOString()).toBe("2026-08-21T18:00:00.000Z");
    expect(parseResetTime("1pm (Asia/Seoul)", now)?.toISOString()).toBe("2026-08-22T04:00:00.000Z");
  });

  it("정각 표기도 콜론이 있는 표기와 같은 판정을 받는다", () => {
    const session = (resetAt: string): string => JSON.stringify({ windows: [{ id: "session", label: "Current session", usedPercent: 89, remainingPercent: 11, resetAt }] });
    // 09:57 기준 6pm은 8시간 뒤라 5시간 롤링 창에서는 나올 수 없는 값이다.
    expect(isImplausibleClaudeSessionReset(session("6pm (Asia/Seoul)"), now)).toBe(true);
    expect(isImplausibleClaudeSessionReset(session("6:00pm (Asia/Seoul)"), now)).toBe(true);
    // 창 안에 있는 값은 그대로 통과해야 한다.
    expect(isImplausibleClaudeSessionReset(session("2pm (Asia/Seoul)"), now)).toBe(false);
  });

  it("정각 표기가 이미 지났으면 stale로 잡는다", () => {
    expect(isExpiredResetTime("3am (Asia/Seoul)", now)).toBe(true);
    expect(isExpiredResetTime("2pm (Asia/Seoul)", now)).toBe(false);
  });

  // 날짜가 붙은 문구는 시:분만 보고 오늘/내일로 추측하면 CLI가 명시한 날짜를 무시하게 되므로,
  // 정각 단독 매치를 허용하지 않던 기존 동작을 그대로 유지해야 한다.
  it("날짜가 붙은 문구는 기존대로 시:분 전용 파싱을 유지한다", () => {
    expect(todayResetTime("Aug 29, 1am (Asia/Seoul)", now)).toBeNull();
    expect(parseResetTime("Aug 29, 1am (Asia/Seoul)", now)).toBeNull();
    expect(isExpiredResetTime("Aug 22, 1am (Asia/Seoul)", now)).toBe(false);
  });

  it("실제로 파싱된 정각 세션 창을 화면에서 끝까지 통과시킨다", () => {
    // 사용자 스냅샷에서 그대로 옮긴 화면(16시간 된 PTY가 돌려준 옛 값).
    const parsed = new ClaudeAdapter("/tmp/x.json", {}).parseUsage(`Current session
89% 89% used
Resets 6pm (Asia/Seoul)
Current week (all models)
80% 80% used
Resets Aug 22, 1am (Asia/Seoul)`, now);
    expect(parsed.reset_at).toBe("6pm (Asia/Seoul)");
    expect(isImplausibleClaudeSessionReset(parsed.details_json, now)).toBe(true);
  });
});

// 조회 전용 PTY를 오래 켜두면 Claude CLI가 시작 시점 캐시를 돌려주는 게 실측됐다(#52).
// 캐시가 묵기 전에 새 프로세스로 갈아타는 판정이다.
describe("조회 PTY 수명 판정", () => {
  const now = new Date("2026-08-22T01:00:00.000Z").getTime();
  const hoursAgo = (hours: number): number => now - hours * 60 * 60_000;

  it("수명 안쪽이면 그대로 쓴다", () => {
    expect(isMonitorTerminalAged(hoursAgo(0), now)).toBe(false);
    expect(isMonitorTerminalAged(hoursAgo(2.9), now)).toBe(false);
  });

  it("수명을 넘기면 갈아탈 대상으로 본다", () => {
    expect(isMonitorTerminalAged(hoursAgo(3), now)).toBe(true);
    // 실제 문제가 재현된 16시간짜리 PTY.
    expect(isMonitorTerminalAged(hoursAgo(16), now)).toBe(true);
  });

  it("아직 뜬 적 없으면 판정 대상이 아니다", () => {
    expect(isMonitorTerminalAged(undefined, now)).toBe(false);
  });
});

describe("Claude usage fallback 백오프", () => {
  it("상세 조회 fallback만 2·4·8·15분으로 자동 조회 간격을 벌린다", () => {
    expect(isClaudeUsageFallbackError("usage_seeded_headers_throttled")).toBe(true);
    expect(isClaudeUsageFallbackError("usage_seeded_persisted_refresh_failed")).toBe(true);
    expect(isClaudeUsageFallbackError("usage_refreshing")).toBe(false);
    expect(isClaudeUsageFallbackError("auth_required")).toBe(false);
    expect(claudeUsageBackoffMs(1)).toBe(2 * 60_000);
    expect(claudeUsageBackoffMs(2)).toBe(4 * 60_000);
    expect(claudeUsageBackoffMs(3)).toBe(8 * 60_000);
    expect(claudeUsageBackoffMs(4)).toBe(15 * 60_000);
    expect(claudeUsageBackoffMs(20)).toBe(15 * 60_000);
  });
});

describe("빈 사용량 창 최소 턴 판정", () => {
  it("Claude 세션 창이 없거나 0%면 활성화한다", () => {
    const weeklyOnly = details([{ id: "weekly_all", usedPercent: 22, resetAt: "Aug 15, 1am" }]);
    const zeroSession = details([{ id: "session", usedPercent: 0, resetAt: "5:00pm" }]);

    expect(detectUsageKeepaliveReason("claude", null, weeklyOnly)).toBe("claude_session_missing");
    expect(detectUsageKeepaliveReason("claude", null, zeroSession)).toBe("claude_session_zero");
    expect(detectUsageKeepaliveReason("claude", null, details([{ id: "session", usedPercent: 0, resetAt: null }]))).toBe("claude_session_zero");
    expect(detectUsageKeepaliveReason("claude", null, details([{ id: "session", usedPercent: 1, resetAt: "5:00pm" }]))).toBeNull();
  });

  it("Claude 세션이 사라지면 직전 초기화 시각에서 현재 창 키를 복원한다", () => {
    const now = new Date("2026-08-11T13:41:00.000Z");
    const previous = details([{ id: "session", usedPercent: 1, resetAt: "10:40pm (Asia/Seoul)" }]);
    const weeklyOnly = details([{ id: "weekly_all", usedPercent: 22, resetAt: "Aug 15, 1am (Asia/Seoul)" }]);

    const trigger = detectUsageKeepaliveTrigger("claude", previous, weeklyOnly, now);

    expect(trigger?.reason).toBe("claude_session_missing");
    expect(JSON.parse(trigger!.windowKey!)).toEqual([{ id: "session", resetAt: "2026-08-11T18:40:00.000Z" }]);
  });

  // 사용자의 정책에 따라 5시간과 주간 초기화를 모두 활성화하되, 실행 폭주는 별도 상한이 막는다.
  it("Codex는 5시간 또는 주간 창이 0%인 동안 계속 활성화한다", () => {
    const before = details([{ id: "five_hour", usedPercent: 18, resetAt: "12:00" }]);
    const reset = details([{ id: "five_hour", usedPercent: 0, resetAt: "17:00" }]);

    expect(detectUsageKeepaliveReason("codex", before, reset)).toBe("codex_reset_zero");
    // 이미 0%가 이어지는 상태에서도, 직전 값을 몰라도 계속 활성화되어야 재시도가 가능하다.
    expect(detectUsageKeepaliveReason("codex", reset, reset)).toBe("codex_reset_zero");
    expect(detectUsageKeepaliveReason("codex", null, reset)).toBe("codex_reset_zero");
    // 사용량이 잡히면(=고정 성공) 더는 활성화되지 않는다.
    expect(detectUsageKeepaliveReason("codex", reset, before)).toBeNull();
    expect(detectUsageKeepaliveReason("codex", null, details([{ id: "weekly", usedPercent: 0, resetAt: "Aug 29" }]))).toBe("codex_reset_zero");
  });

  it("Codex 5시간·주간 창이 동시에 0%여도 keepalive 작업 하나만 만든다", () => {
    const reset = details([
      { id: "five_hour", usedPercent: 0, resetAt: "14:01" },
      { id: "weekly", usedPercent: 0, resetAt: "09:01 on 4 Sep" },
    ]);

    expect(detectUsageKeepaliveTrigger("codex", reset, reset)).toEqual({ reason: "codex_reset_zero", windowKey: null });
  });

  it("Codex 양수→0% 새 초기화는 직전 null 키 쿨다운을 넘는 창 키를 만든다", () => {
    const now = new Date("2026-08-30T01:24:52.000Z");
    const before = details([
      { id: "weekly", usedPercent: 57, resetAt: "03:50 on 4 Sep" },
      { id: "five_hour", usedPercent: 1, resetAt: "10:24" },
    ]);
    const reset = details([
      { id: "weekly", usedPercent: 0, resetAt: "06:23 on 6 Sep" },
      { id: "five_hour", usedPercent: 0, resetAt: "11:23" },
    ]);

    const trigger = detectUsageKeepaliveTrigger("codex", before, reset, now);

    expect(trigger?.reason).toBe("codex_reset_zero");
    expect(JSON.parse(trigger!.windowKey!)).toEqual([
      { id: "five_hour", resetAt: "2026-08-30T02:23:00.000Z" },
      { id: "weekly", resetAt: "2026-09-05T21:23:00.000Z" },
    ]);
    expect(isUsageKeepaliveDue("2026-08-29T20:27:07.000Z", null, trigger?.windowKey, now)).toBe(true);
    expect(detectUsageKeepaliveTrigger("codex", reset, reset, now)?.windowKey).toBeNull();
  });

  // 0% 창은 리셋 시각이 계속 밀려 창 키를 만들 수 없다. 키를 비워야 isUsageKeepaliveDue가
  // 5시간 쿨다운으로 재시도 간격을 잡는다.
  it("Codex 주간 0% 창도 창 키 없이 활성화해 쿨다운으로 재시도 간격을 둔다", () => {
    const reset = details([{ id: "weekly", usedPercent: 0, resetAt: "11:20 on 29 Aug" }]);
    const trigger = detectUsageKeepaliveTrigger("codex", reset, reset, new Date("2026-08-22T02:20:00.000Z"));

    expect(trigger?.reason).toBe("codex_reset_zero");
    expect(trigger?.windowKey).toBeNull();
    // 키가 없으면 마지막 전송으로부터 5시간이 지나야 다시 보낸다.
    expect(isUsageKeepaliveDue("2026-08-22T02:00:00.000Z", null, null, new Date("2026-08-22T03:00:00.000Z"))).toBe(false);
    expect(isUsageKeepaliveDue("2026-08-22T02:00:00.000Z", null, null, new Date("2026-08-22T08:00:00.000Z"))).toBe(true);
  });

  it("Grok 주간 한도가 양수에서 0%가 되어도 keepalive를 타지 않는다", () => {
    const before = details([{ id: "weekly", usedPercent: 18, resetAt: "Aug 22" }]);
    const reset = details([{ id: "weekly", usedPercent: 0, resetAt: "Aug 29" }]);

    expect(detectUsageKeepaliveReason("grok", before, reset)).toBeNull();
    expect(detectUsageKeepaliveTrigger("grok", before, reset)).toBeNull();
  });

  it("같은 초기화 창은 막고 다른 창은 5시간 안이어도 허용한다", () => {
    const now = new Date("2026-08-11T10:00:00.000Z");
    const previousWindow = JSON.stringify([{ id: "session", resetAt: "2026-08-11T13:40:00.000Z" }]);
    const sameWindowWithDisplayDrift = JSON.stringify([{ id: "session", resetAt: "2026-08-11T13:49:00.000Z" }]);
    const nextWindow = JSON.stringify([{ id: "session", resetAt: "2026-08-11T18:40:00.000Z" }]);

    expect(isSameUsageKeepaliveWindow(previousWindow, sameWindowWithDisplayDrift)).toBe(true);
    expect(isUsageKeepaliveDue(null, null, previousWindow, now)).toBe(true);
    expect(isUsageKeepaliveDue("2026-08-11T04:00:00.000Z", previousWindow, sameWindowWithDisplayDrift, now)).toBe(false);
    expect(isUsageKeepaliveDue("2026-08-11T09:59:00.000Z", previousWindow, nextWindow, now)).toBe(true);
  });

  it("창을 식별할 수 없을 때만 기존 5시간 제한을 사용한다", () => {
    const now = new Date("2026-08-11T10:00:00.000Z");

    expect(isUsageKeepaliveDue("2026-08-11T05:00:01.000Z", null, null, now)).toBe(false);
    expect(isUsageKeepaliveDue("2026-08-11T05:00:00.000Z", null, null, now)).toBe(true);
  });
});
