import { describe, expect, it } from "vitest";
import { claudeVersionSatisfies, parseClaudeModelSelector, parseClaudeOAuthUsage } from "../src/server/providers/claude-usage-collector";
import { parseCodexAppServerUsage, parseCodexModelList } from "../src/server/providers/codex-usage-collector";
import { parseGrokBillingUsage, parseGrokModelsOutput } from "../src/server/providers/grok-usage-collector";

function details(record: { details_json?: string | null }): Record<string, unknown> {
  return JSON.parse(record.details_json ?? "{}") as Record<string, unknown>;
}

describe("provider direct usage collectors", () => {
  it("Claude OAuth 사용량을 기존 session/weekly 창 계약으로 정규화한다", () => {
    const record = parseClaudeOAuthUsage({
      five_hour: { utilization: 21.5, resets_at: "2026-09-23T08:59:59.552Z" },
      seven_day: { used_percentage: 42, resets_at: "2026-09-28T09:00:00Z" },
      seven_day_sonnet: { used_percentage: 17, resets_at: "2026-09-28T09:00:00Z" },
    });

    expect(record.data_status).toBe("fresh");
    expect(record.used_percent).toBe(21.5);
    expect(details(record)).toMatchObject({
      source: "oauth",
      windows: [
        { id: "session", usedPercent: 21.5, resetAt: "2026-09-23T09:00:00.000Z" },
        { id: "weekly_all", usedPercent: 42 },
        { id: "weekly_sonnet", usedPercent: 17 },
      ],
    });
  });

  it("Claude OAuth의 동일 리셋 경계 밀리초 흔들림을 분 단위로 안정화한다", () => {
    const before = parseClaudeOAuthUsage({ five_hour: { utilization: 0, resets_at: "2026-09-23T08:59:59.552Z" } });
    const after = parseClaudeOAuthUsage({ five_hour: { utilization: 0, resets_at: "2026-09-23T09:00:00.305Z" } });

    expect(before.reset_at).toBe("2026-09-23T09:00:00.000Z");
    expect(after.reset_at).toBe(before.reset_at);
  });

  it("Codex app-server 사용량과 초기화권을 한 응답에서 정규화한다", () => {
    const record = parseCodexAppServerUsage({
      rateLimits: {
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 34, windowDurationMins: 10_080, resetsAt: 1_800_500_000 },
      },
      rateLimitResetCredits: {
        availableCount: 3,
        credits: [
          { id: "later", status: "available", expiresAt: 1_900_000_000 },
          { id: "first", status: "available", expiresAt: 1_850_000_000 },
        ],
      },
      planType: "pro",
    });

    expect(record.used_percent).toBe(12);
    expect(details(record)).toMatchObject({
      source: "app-server",
      windows: [
        { id: "weekly", usedPercent: 34 },
        { id: "five_hour", usedPercent: 12 },
      ],
      rateLimitResetCredits: { availableCount: 3, expiresAt: "2028-08-16T00:53:20.000Z" },
    });
  });

  it("Grok billing 응답의 주간 비율과 월 예산을 정규화한다", () => {
    const record = parseGrokBillingUsage({
      config: {
        creditUsagePercent: 25,
        currentPeriod: { end: "2026-09-30T00:00:00Z" },
        monthlyLimit: { val: "100" },
        used: { val: "40" },
        subscriptionTier: "SuperGrok",
      },
    });

    expect(record.used_percent).toBe(25);
    expect(details(record)).toMatchObject({
      source: "oauth",
      windows: [
        { id: "weekly", usedPercent: 25 },
        { id: "monthly", usedPercent: 40 },
      ],
    });
  });

  it("Grok 공식 TUI처럼 확정된 주간 period의 누락된 protobuf 0%를 복원한다", () => {
    const record = parseGrokBillingUsage({
      config: {
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: "2026-09-18T04:23:46.615580+00:00",
          end: "2026-09-25T04:23:46.615580+00:00",
        },
        billingPeriodStart: "2026-09-18T04:23:46.615580+00:00",
        billingPeriodEnd: "2026-09-25T04:23:46.615580+00:00",
      },
    });

    expect(record.used_percent).toBe(0);
    expect(details(record)).toMatchObject({ windows: [{ id: "weekly", usedPercent: 0, remainingPercent: 100 }] });
  });
});

describe("provider direct model option collectors", () => {
  it("Claude API catalog를 버전 하드코딩 없이 default·alias·exact 선택으로 변환한다", () => {
    const options = parseClaudeModelSelector({
      model_selector_state: [{ id: "cc", model: "claude-opus-5-5", thinking: { type: "effort", effort: "medium" } }],
      model_selector_config: [{ id: "cc", models: [
        { id: "claude-opus-5-5", name: "Opus 5.5", short_name: "Opus", section: "main", quick_select: true, min_claude_code_version: "2.1.280", thinking: { type: "effort", effort_options: [{ id: "low", name: "Low" }, { id: "max", name: "Max" }] } },
        { id: "claude-sonnet-5", name: "Sonnet 5", short_name: "Sonnet", section: "main", quick_select: true, thinking: { type: "effort", effort_options: [{ id: "high", name: "High" }] } },
        { id: "claude-nova-6", name: "Nova 6", short_name: "Nova", section: "main", quick_select: true },
        { id: "claude-opus-5", name: "Opus 5", short_name: "Opus", section: "overflow", thinking: { type: "effort", effort_options: [{ id: "high", name: "High" }] } },
        { id: "claude-future-9", name: "Future 9", short_name: "Future", section: "main", quick_select: true, min_claude_code_version: "9.0.0" },
      ] }],
    }, { model: "claude-opus-5", effortLevel: "high" }, "2.1.280");

    expect(options.models.map((model) => model.id)).toEqual(["default", "alias:opus", "alias:sonnet", "alias:nova", "exact:opus-5"]);
    expect(options.models.find((model) => model.id === "alias:opus")).toMatchObject({ resolvedModelId: "claude-opus-5-5", resolvedLabel: "Opus 5.5" });
    expect(options.models.find((model) => model.current)?.id).toBe("exact:opus-5");
    expect(options.efforts.map((effort) => effort.id)).toEqual(["low", "max", "high"]);
    expect(options.currentEffort).toBe("high");
  });

  it("Claude 최소 CLI 버전을 일반 숫자 버전 비교로 필터링한다", () => {
    expect(claudeVersionSatisfies("2.1.280", "2.1.280")).toBe(true);
    expect(claudeVersionSatisfies("2.2.0", "2.1.999")).toBe(true);
    expect(claudeVersionSatisfies("2.1.250", "2.1.251")).toBe(false);
  });

  it("Codex model/list의 모델·reasoning effort를 안정 ID로 변환한다", () => {
    const options = parseCodexModelList([
      {
        model: "gpt-5.3-codex",
        displayName: "GPT-5.3-Codex",
        isDefault: true,
        defaultReasoningEffort: "xhigh",
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "Balanced" },
          { reasoningEffort: "xhigh", description: "Deep" },
          { reasoningEffort: "ultra", description: "Not yet selectable through the TUI" },
        ],
      },
      { model: "hidden", hidden: true },
    ]);

    expect(options.currentModel).toBe("gpt-5.3-codex");
    expect(options.currentEffort).toBe("extra-high");
    expect(options.models.map((model) => model.id)).toEqual(["gpt-5.3-codex"]);
    expect(options.efforts.map((effort) => effort.id)).toEqual(["medium", "extra-high"]);
  });

  it("grok models 비대화형 출력을 모델 목록으로 변환한다", () => {
    const options = parseGrokModelsOutput(`You are logged in\nDefault model: grok-4.7\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.7-build-fast\n  - grok-4.6\n`);

    expect(options.currentModel).toBe("grok-4.7");
    expect(options.models.map((model) => model.id)).toEqual(["grok-4.7", "grok-4.7-build-fast", "grok-4.6"]);
    expect(options.models[0].current).toBe(true);
  });
});
