import { describe, expect, it } from "vitest";
import { buildGrokPrintArgs } from "../src/server/experiments/grok-print-runtime";
import { normalizeClaudePrintEvent } from "../src/server/experiments/claude-print-runtime";
import type { RuntimeRunInput } from "../src/server/experiments/agent-runtime";
import { parseExperimentVariantConfig } from "../src/shared/experiments";

// Grok argv 테스트에 필요한 완전한 실행 입력을 만든다.
function runInput(overrides: { skills?: "all"; sandbox?: "read-only" | "workspace-write" | "danger-full-access" } = {}): RuntimeRunInput {
  const skills = overrides.skills ?? "all";
  const sandbox = overrides.sandbox ?? "workspace-write";
  return {
    runId: "run-grok-1",
    workingDirectory: "/tmp/project",
    prompt: "기능을 구현해",
    config: parseExperimentVariantConfig({
      schemaVersion: 1,
      runtime: { provider: "grok", model: "grok-4.6", reasoningEffort: "high", sandbox, maxTurns: 8 },
      skills: { mode: skills, enabled: [], disabled: [] },
      harness: { type: "single", maxIterations: 3, maxNoImprovement: 1 },
      budget: { maxSeconds: 600, maxTokens: 10_000, maxCostUsd: 3.5 },
    }),
    snapshot: {
      provider: "grok", cliVersion: "grok 1.0.5", resolvedModel: "grok-4.6",
      toolProfile: { transport: "headless-streaming-messages-json", sessionId: "11111111-1111-4111-8111-111111111111", supportsMaxTurns: true },
      permissionProfile: { sandbox, permissionMode: sandbox === "read-only" ? "plan" : "acceptEdits" },
      skillManifest: [], preparedAt: "2026-08-21T00:00:00.000Z",
    },
    allowedCommands: [["npm", "test"]],
    outputSchema: { type: "object", properties: { answer: { type: "string" } } },
  };
}

describe("Grok headless 런타임", () => {
  it("프롬프트를 argv로 넘기고 새 실행·resume의 세션 인자를 구분한다", () => {
    const fresh = buildGrokPrintArgs(runInput());
    // Grok headless는 stdin 파이프를 받지 않아 프롬프트가 반드시 argv에 있어야 한다(Claude와 반대).
    expect(fresh.slice(0, 4)).toEqual(["-p", "기능을 구현해", "--output-format", "streaming-messages-json"]);
    expect(fresh).toContain("--session-id");
    expect(fresh).toContain("11111111-1111-4111-8111-111111111111");
    expect(fresh).toContain("--model");
    expect(fresh).toContain("grok-4.6");
    expect(fresh).toContain("--reasoning-effort");
    expect(fresh[fresh.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    // fixture 검증 명령은 Claude Code 문법 그대로 Grok 권한 규칙에 실린다.
    expect(fresh[fresh.indexOf("--allow") + 1]).toBe("Bash(npm test:*)");
    expect(fresh[fresh.indexOf("--max-turns") + 1]).toBe("8");
    // Grok에는 비용 상한 옵션이 없어 CLI 인자로 새지 않아야 한다(WAM 예산 정책이 대신 강제한다).
    expect(fresh).not.toContain("--max-budget-usd");

    const resumed = buildGrokPrintArgs(runInput(), "session-old");
    expect(resumed).toContain("--resume");
    expect(resumed).toContain("session-old");
    expect(resumed).not.toContain("--session-id");
  });

  it("샌드박스를 native 권한 모드로 옮긴다", () => {
    expect(buildGrokPrintArgs(runInput({ sandbox: "read-only" }))).toContain("plan");
    expect(buildGrokPrintArgs(runInput({ sandbox: "danger-full-access" }))).toContain("bypassPermissions");
  });

  it("격리할 수 없는 스킬 조건은 저장 경계에서 먼저 막고 런타임도 방어한다", () => {
    // 저장 경계: graph의 secondary가 Grok인 경우까지 포함해 조합 자체를 거부한다.
    const config = (skills: Record<string, unknown>, secondaryProvider?: string) => () => parseExperimentVariantConfig({
      schemaVersion: 1,
      runtime: { provider: secondaryProvider ? "claude" : "grok", model: "m", reasoningEffort: "high", sandbox: "workspace-write" },
      skills,
      harness: secondaryProvider
        ? { type: "orchestrator_worker", maxIterations: 3, maxNoImprovement: 1, secondaryRuntime: { provider: secondaryProvider, model: "grok-4.6" } }
        : { type: "single", maxIterations: 3, maxNoImprovement: 1 },
      budget: { maxSeconds: 600 },
    });
    expect(config({ mode: "none", enabled: [], disabled: [] })).toThrow("스킬 격리를 지원하지 않습니다");
    expect(config({ mode: "selected", enabled: ["review"], disabled: [] })).toThrow("스킬 격리를 지원하지 않습니다");
    expect(config({ mode: "none", enabled: [], disabled: [] }, "grok")).toThrow("스킬 격리를 지원하지 않습니다");
    expect(config({ mode: "all", enabled: [], disabled: ["review"] })).toThrow("스킬 격리를 지원하지 않습니다");
    expect(config({ mode: "all", enabled: [], disabled: [] })).not.toThrow();

    // 런타임 방어: 검증을 거치지 않은 설정이 들어와도 조용히 스킬 켜진 채 실행하지 않는다.
    const bypassed = runInput({ skills: "all" });
    bypassed.config.skills = { ...bypassed.config.skills, mode: "none" };
    expect(() => buildGrokPrintArgs(bypassed)).toThrow("끄는 옵션");
    const selected = runInput({ skills: "all" });
    selected.config.skills = { ...selected.config.skills, mode: "selected", enabled: ["review"] };
    expect(() => buildGrokPrintArgs(selected)).toThrow("개별 스킬");
  });

  it("스킬 overlay는 baseline과 무관하게 거부한다 — headless는 --plugin-dir를 받지 않는다", () => {
    // 실측: `grok -p ping --plugin-dir /tmp` → error: unexpected argument '--plugin-dir' found (exit 2).
    // 이 플래그는 `grok agent` 전용이라, argv에 실으면 실행이 시작조차 되지 않는다.
    const overlay = {
      profile: "isolated_overlay" as const, baseline: "installed" as const, comparisonId: "grok-default", activation: "native" as const,
      bundleRoot: "/tmp/bundles/abc", pluginManifest: "/tmp/bundles/abc/.claude-plugin/plugin.json",
      baselineSkills: [], additions: [], files: [], digest: "digest",
    };
    for (const baseline of ["installed", "clean"] as const) {
      const input = runInput({ skills: "all" });
      input.snapshot.skillOverlay = { ...overlay, baseline };
      expect(() => buildGrokPrintArgs(input)).toThrow("overlay 주입을 지원하지 않습니다");
    }
    // overlay가 없는 기본 경로에는 지원하지 않는 플래그가 절대 실리지 않아야 한다.
    expect(buildGrokPrintArgs(runInput({ skills: "all" }))).not.toContain("--plugin-dir");
  });

  it("샌드박스를 강제할 수 있을 때만 --sandbox를 걸고 없으면 권한 모드로만 돈다", () => {
    // Claude와 달리 Grok에는 실제 OS 샌드박스가 있다(--sandbox workspace|read-only|strict|off).
    // 다만 Linux에서 bubblewrap이 없으면 Grok이 실행을 거부하므로(실측: "bwrap exec failed ...
    // Refusing to start with denied paths unprotected") 무조건 붙이면 그런 호스트에서 실험이 전부 죽는다.
    const enforce = (sandbox: "read-only" | "workspace-write" | "danger-full-access") => {
      const input = runInput({ sandbox });
      input.snapshot.toolProfile.supportsSandbox = true;
      return buildGrokPrintArgs(input);
    };
    expect(enforce("read-only")[enforce("read-only").indexOf("--sandbox") + 1]).toBe("read-only");
    expect(enforce("workspace-write")[enforce("workspace-write").indexOf("--sandbox") + 1]).toBe("workspace");
    expect(enforce("danger-full-access")[enforce("danger-full-access").indexOf("--sandbox") + 1]).toBe("off");

    const unsupported = runInput({ sandbox: "read-only" });
    unsupported.snapshot.toolProfile.supportsSandbox = false;
    expect(buildGrokPrintArgs(unsupported)).not.toContain("--sandbox");
    expect(buildGrokPrintArgs(unsupported)).toContain("plan");
  });

  it("Grok streaming-messages-json을 Claude stream-json과 같은 이벤트로 정규화한다", () => {
    // 실측한 실제 grok 1.0.5 출력이다. wire format이 같아 정규화기를 공유하되 오류 문구만 공급자 이름을 따른다.
    const init = normalizeClaudePrintEvent({
      type: "system", subtype: "init", session_id: "01a02227-1d9d-7fa1-a446-5c6873529ff9", model: "grok-4.6",
    }, "2026-08-21T00:00:00.000Z", "Grok");
    expect(init).toEqual([{ type: "started", providerRunId: "01a02227-1d9d-7fa1-a446-5c6873529ff9", details: expect.any(Object), occurredAt: "2026-08-21T00:00:00.000Z" }]);

    const assistant = normalizeClaudePrintEvent({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "속으로 생각" }, { type: "text", text: "OK" }] },
      session_id: "01a02227",
    }, "2026-08-21T00:00:01.000Z", "Grok");
    expect(assistant).toEqual([{ type: "message", role: "assistant", text: "OK", occurredAt: "2026-08-21T00:00:01.000Z", parentToolCallId: null }]);

    const result = normalizeClaudePrintEvent({
      type: "result", subtype: "success", is_error: false, result: "OK", total_cost_usd: 0.00408782,
      usage: { input_tokens: 10472, output_tokens: 37, cache_read_input_tokens: 5760, cache_creation_input_tokens: 0 },
    }, "2026-08-21T00:00:02.000Z", "Grok");
    expect(result[0]).toMatchObject({ type: "usage", usage: { inputTokens: 10472, outputTokens: 37, cacheReadInputTokens: 5760, costUsd: 0.00408782 } });
    expect(result[1]).toMatchObject({ type: "completed" });

    const failed = normalizeClaudePrintEvent({ type: "result", subtype: "error_max_turns", is_error: true }, "2026-08-21T00:00:03.000Z", "Grok");
    expect(failed.at(-1)).toMatchObject({ type: "failed", reason: "max_turns", error: expect.stringContaining("Grok 실행이") });
  });
});
