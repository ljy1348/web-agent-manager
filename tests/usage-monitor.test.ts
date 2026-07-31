import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../src/server/providers/codex";
import { ClaudeAdapter } from "../src/server/providers/claude";
import { detectUsageRegression, reconcileStaleClaudeSessionWindow } from "../src/server/services/usage-monitor";

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
    expect(parsed.used_percent).toBe(25);
    expect(parsed.reset_at).toBe("19:05 on 9 Jul");
    expect(details.activity).toHaveLength(2);
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

  it("인증 요구 화면은 사용 불가로 표시한다", () => {
    const parsed = claude.parseUsage("Login required. Sign in to continue.");
    expect(parsed).toMatchObject({ data_status: "unavailable", error_code: "auth_required" });
  });

  it("파싱 실패 때는 이전 사용량 캐시를 덮지 않도록 details_json을 비워둔다", () => {
    const parsed = codex.parseUsage("temporary spinner without usage data");
    expect(parsed).toMatchObject({ data_status: "unavailable", error_code: "parse_failed" });
    expect(parsed.details_json).toBeNull();
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
});
