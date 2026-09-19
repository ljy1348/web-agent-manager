import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../src/server/providers/codex";

// Pro Lite 계정의 실제 /status 화면이다. 플랜 한도는 주간 하나뿐이고, 그 아래 값 없는 헤더
// "GPT-5.3-Codex-Spark limit:" 다음에 그 모델 전용 5h·주간 한도가 따로 표시된다(#87).
const PRO_STATUS_SCREEN = [
  "╭─────────────────────────────────────────────────────────────────────────────────────────╮",
  "│  >_ OpenAI Codex (v0.153.4)                                                             │",
  "│                                                                                         │",
  "│  Model:                       gpt-6-astra (reasoning medium, summaries auto)            │",
  "│  Account:                     tester@example.com (Pro Lite)                             │",
  "│                                                                                         │",
  "│  Weekly limit:                [███████████████████░] 95% left (resets 15:02 on 17 Sep)  │",
  "│  GPT-5.3-Codex-Spark limit:                                                             │",
  "│  5h limit:                    [████████████████████] 100% left (resets 20:47)           │",
  "│  Weekly limit:                [████████████████████] 100% left (resets 14:48 on 17 Sep) │",
  "╰─────────────────────────────────────────────────────────────────────────────────────────╯",
].join("\n");

// 5시간 창이 플랜 한도에 함께 있던 기존 화면. 모델 전용 섹션이 없으므로 그대로 읽어야 한다.
const PLAN_STATUS_SCREEN = [
  "  Weekly limit:                [██████████░░░░░░░░░░] 50% left (resets 13:33 on 17 Sep)",
  "  5h limit:                    [████████████████░░░░] 80% left (resets 18:33)",
].join("\n");

// 플랜에 5시간 창이 다시 생기고 모델 전용 섹션도 함께 있는 화면. 헤더 위의 플랜 5시간은 읽고,
// 헤더 아래 모델 전용 5시간은 버려야 한다(나중에 플랜이 바뀌어도 주간에 고정되지 않는지 확인).
const PLAN_WITH_MODEL_SECTION_SCREEN = [
  "│  5h limit:                    [████████████████░░░░] 80% left (resets 18:33)            │",
  "│  Weekly limit:                [███████████████████░] 95% left (resets 15:02 on 17 Sep)  │",
  "│  GPT-5.3-Codex-Spark limit:                                                             │",
  "│  5h limit:                    [████████████████████] 100% left (resets 20:47)           │",
  "│  Weekly limit:                [████████████████████] 100% left (resets 14:48 on 17 Sep) │",
].join("\n");

describe("Codex 사용량 화면 파싱", () => {
  it("모델 전용 한도 섹션 아래의 창은 읽지 않는다", () => {
    const parsed = new CodexAdapter().parseUsage(PRO_STATUS_SCREEN, new Date("2026-09-10T06:05:00.000Z"));
    const windows = JSON.parse(parsed.details_json!).windows as { id: string; usedPercent: number; resetAt: string | null }[];

    expect(windows.map((window) => window.id)).toEqual(["weekly"]);
    expect(windows[0]).toMatchObject({ usedPercent: 5, resetAt: "15:02 on 17 Sep" });
    // 플랜에 5시간 창이 없으면 대표값은 주간으로 폴백해야 한다.
    expect(parsed.used_percent).toBe(5);
    expect(parsed.reset_at).toBe("15:02 on 17 Sep");
    expect(parsed.error_code).toBeNull();
  });

  it("모델 전용 섹션이 없는 화면은 5시간 창을 그대로 읽는다", () => {
    const parsed = new CodexAdapter().parseUsage(PLAN_STATUS_SCREEN, new Date("2026-09-10T06:05:00.000Z"));
    const windows = JSON.parse(parsed.details_json!).windows as { id: string; usedPercent: number; resetAt: string | null }[];

    expect(windows.map((window) => window.id).sort()).toEqual(["five_hour", "weekly"]);
    expect(windows.find((window) => window.id === "five_hour")).toMatchObject({ usedPercent: 20, resetAt: "18:33" });
    expect(parsed.used_percent).toBe(20);
  });

  it("플랜 5시간 창이 다시 생기면 모델 전용 섹션이 있어도 5시간을 대표값으로 읽는다", () => {
    const parsed = new CodexAdapter().parseUsage(PLAN_WITH_MODEL_SECTION_SCREEN, new Date("2026-09-10T06:05:00.000Z"));
    const windows = JSON.parse(parsed.details_json!).windows as { id: string; usedPercent: number; resetAt: string | null }[];

    expect(windows.map((window) => window.id).sort()).toEqual(["five_hour", "weekly"]);
    expect(windows.find((window) => window.id === "five_hour")).toMatchObject({ usedPercent: 20, resetAt: "18:33" });
    expect(windows.find((window) => window.id === "weekly")).toMatchObject({ usedPercent: 5, resetAt: "15:02 on 17 Sep" });
    expect(parsed.used_percent).toBe(20);
    expect(parsed.reset_at).toBe("18:33");
  });
});
