import { describe, expect, it } from "vitest";
import {
  buildClaudePrintArgs,
  ClaudePrintRuntime,
  normalizeClaudePrintEvent,
} from "../src/server/experiments/claude-print-runtime";
import type { RuntimeRunInput } from "../src/server/experiments/agent-runtime";
import { parseExperimentVariantConfig } from "../src/shared/experiments";

// Claude argv 테스트에 필요한 완전한 실행 입력을 만든다.
function runInput(overrides: { skills?: "all" | "none" | "selected"; sandbox?: "read-only" | "workspace-write" | "danger-full-access" } = {}): RuntimeRunInput {
  const skills = overrides.skills ?? "none";
  const sandbox = overrides.sandbox ?? "workspace-write";
  return {
    runId: "run-claude-1",
    workingDirectory: "/tmp/project",
    prompt: "기능을 구현해",
    config: parseExperimentVariantConfig({
      schemaVersion: 1,
      runtime: { provider: "claude", model: "opus", reasoningEffort: "high", sandbox, maxTurns: 8 },
      skills: { mode: skills, enabled: skills === "selected" ? ["review"] : [], disabled: [] },
      harness: { type: "single", maxIterations: 3, maxNoImprovement: 1 },
      budget: { maxSeconds: 600, maxTokens: 10_000, maxCostUsd: 3.5 },
    }),
    snapshot: {
      provider: "claude", cliVersion: "2.1.231", resolvedModel: "opus",
      toolProfile: { transport: "print-stream-json", sessionId: "11111111-1111-4111-8111-111111111111", supportsMaxTurns: true },
      permissionProfile: { sandbox, permissionMode: sandbox === "read-only" ? "plan" : "acceptEdits" },
      skillManifest: [], preparedAt: "2026-08-13T00:00:00.000Z",
    },
    outputSchema: { type: "object", properties: { answer: { type: "string" } } },
  };
}

describe("Claude print 런타임", () => {
  it("새 실행과 resume의 JSONL·권한·예산·maxTurns argv를 구분한다", () => {
    const fresh = buildClaudePrintArgs(runInput());
    expect(fresh.slice(0, 4)).toEqual(["-p", "--output-format", "stream-json", "--verbose"]);
    expect(fresh).toContain("--session-id");
    expect(fresh).toContain("--permission-mode");
    expect(fresh).toContain("acceptEdits");
    expect(fresh).toContain("--max-turns");
    expect(fresh).toContain("8");
    expect(fresh).toContain("--max-budget-usd");
    expect(fresh).toContain("--disable-slash-commands");
    expect(fresh).not.toContain("기능을 구현해");

    const resumed = buildClaudePrintArgs(runInput({ skills: "all", sandbox: "danger-full-access" }), "session-old");
    expect(resumed).toContain("--resume");
    expect(resumed).toContain("session-old");
    expect(resumed).not.toContain("--session-id");
    expect(resumed).toContain("--dangerously-skip-permissions");
    expect(resumed).not.toContain("--disable-slash-commands");
  });

  it("read-only는 native plan으로 기록하고 선택 스킬의 허위 격리를 거부한다", () => {
    expect(buildClaudePrintArgs(runInput({ sandbox: "read-only" }))).toContain("plan");
    expect(() => buildClaudePrintArgs(runInput({ skills: "selected" }))).toThrow("개별 스킬");
    const unsupported = runInput();
    unsupported.snapshot.toolProfile.supportsMaxTurns = false;
    expect(() => buildClaudePrintArgs(unsupported)).toThrow("maxTurns");
  });

  it("clean/installed baseline에 같은 pinned overlay 전달 경계를 사용한다", () => {
    const clean = runInput({ skills: "none" });
    clean.config.skills = {
      mode: "none", enabled: [], disabled: [], profile: "isolated_overlay", baseline: "clean",
      additions: ["lab:review"], comparisonId: "claude-default", activation: "native",
    };
    clean.snapshot.skillOverlay = {
      profile: "isolated_overlay", baseline: "clean", comparisonId: "claude-default",
      activation: "native",
      bundleRoot: "/tmp/bundle", pluginManifest: "/tmp/bundle/.claude-plugin/plugin.json",
      baselineSkills: [],
      additions: [{ id: "lab:review", name: "review", source: "project_lab", directory: "/tmp/bundle/skills/01-review" }], files: [], digest: "a".repeat(64),
    };
    const installed = structuredClone(clean);
    installed.config.skills.mode = "all";
    installed.config.skills.baseline = "installed";
    installed.snapshot.skillOverlay!.baseline = "installed";

    const cleanArgs = buildClaudePrintArgs(clean);
    const installedArgs = buildClaudePrintArgs(installed);

    expect(cleanArgs).toContain("--setting-sources");
    expect(cleanArgs[cleanArgs.indexOf("--setting-sources") + 1]).toBe("");
    expect(installedArgs[installedArgs.indexOf("--setting-sources") + 1]).toBe("");
    for (const args of [cleanArgs, installedArgs]) {
      expect(args).toContain("--strict-mcp-config");
      expect(args).toContain("--plugin-dir");
      expect(args).toContain("/tmp/bundle");
      expect(args).not.toContain("--append-system-prompt-file");
      expect(args).not.toContain("--disable-slash-commands");
    }
  });

  it("prepare에서 실제 capability와 UUID·native permission provenance를 고정한다", async () => {
    const runtime = new ClaudePrintRuntime({
      readVersion: async () => "2.1.231",
      detectMaxTurns: async () => true,
      skillManifest: async () => [{ id: "review", path: "/skills/review/SKILL.md", sha256: "a".repeat(64) }],
    });
    const input = runInput({ skills: "all", sandbox: "read-only" });
    const snapshot = await runtime.prepare(input);
    expect(snapshot).toMatchObject({
      provider: "claude", cliVersion: "2.1.231", resolvedModel: "opus",
      toolProfile: { transport: "print-stream-json", supportsMaxTurns: true, skillIsolation: "native-all" },
      permissionProfile: { sandbox: "read-only", permissionMode: "plan" },
      skillManifest: [{ id: "review" }],
    });
    expect(snapshot.toolProfile.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("init·텍스트·도구 시작/결과의 상관관계를 공통 이벤트로 보존한다", () => {
    const at = "2026-08-13T00:00:00.000Z";
    const init = { type: "system", subtype: "init", session_id: "session-1", model: "opus", tools: ["Read"] };
    expect(normalizeClaudePrintEvent(init, at)).toEqual([
      { type: "started", providerRunId: "session-1", details: init, occurredAt: at },
    ]);
    expect(normalizeClaudePrintEvent({
      type: "assistant", parent_tool_use_id: "parent-1",
      message: { content: [{ type: "text", text: "확인 중" }, { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "a.ts" } }] },
    }, at)).toEqual([
      { type: "message", role: "assistant", text: "확인 중", occurredAt: at, parentToolCallId: "parent-1" },
      { type: "tool_started", name: "Read", payload: { file_path: "a.ts" }, toolCallId: "tool-1", parentToolCallId: "parent-1", occurredAt: at },
    ]);
    expect(normalizeClaudePrintEvent({
      type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "파일 내용" }] },
    }, at)[0]).toMatchObject({ type: "tool_finished", toolCallId: "tool-1", payload: { content: "파일 내용" } });
  });

  it("캐시 생성·읽기와 파생 합계·비용을 분리하고 성공을 완료 처리한다", () => {
    const at = "2026-08-13T00:00:00.000Z";
    const raw = {
      type: "result", subtype: "success", is_error: false, session_id: "session-1", result: "완료",
      total_cost_usd: 0.25,
      usage: { input_tokens: 2, cache_creation_input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 3 },
    };
    expect(normalizeClaudePrintEvent(raw, at)).toEqual([
      { type: "usage", usage: {
        inputTokens: 2, cachedInputTokens: null, cacheCreationInputTokens: 10, cacheReadInputTokens: 20,
        outputTokens: 3, reasoningOutputTokens: null, totalTokens: 35, totalTokensSource: "derived", costUsd: 0.25,
      }, occurredAt: at },
      { type: "completed", result: raw, occurredAt: at },
    ]);
  });

  it("Claude 종료 subtype을 max turn·cost·runtime 오류로 구분한다", () => {
    expect(normalizeClaudePrintEvent({ type: "result", subtype: "error_max_turns", is_error: true, result: "turn 초과" })[0])
      .toMatchObject({ type: "failed", reason: "max_turns", error: "turn 초과" });
    expect(normalizeClaudePrintEvent({ type: "result", subtype: "error_max_budget", is_error: true })[0])
      .toMatchObject({ type: "failed", reason: "cost_budget" });
    expect(normalizeClaudePrintEvent({ type: "result", subtype: "error_during_execution", is_error: true })[0])
      .toMatchObject({ type: "failed", reason: "runtime_error" });
  });
});

describe("Claude result subtype 매핑", () => {
  const at = "2026-08-15T00:00:00.000Z";

  it("설치된 CLI가 실제로 내보내는 error 계열 subtype을 종료 이유로 옮긴다", () => {
    // Claude Code 2.1.232 번들 실측: error, error_during_execution, error_max_budget_usd,
    // error_max_structured_output_retries, error_max_turns.
    const failure = (subtype: string) => normalizeClaudePrintEvent({
      type: "result", subtype, is_error: true, result: "중단됨",
    }, at).find((event) => event.type === "failed");

    expect(failure("error_max_turns")).toMatchObject({ reason: "max_turns" });
    // 예전 코드는 error_max_budget을 찾아 이 값이 runtime_error로 떨어졌다.
    expect(failure("error_max_budget_usd")).toMatchObject({ reason: "cost_budget" });
    expect(failure("error_during_execution")).toMatchObject({ reason: "runtime_error" });
    expect(failure("error_max_structured_output_retries")).toMatchObject({ reason: "runtime_error" });
  });

  it("성공 subtype은 완료로 남기고 is_error가 참이면 실패로 본다", () => {
    expect(normalizeClaudePrintEvent({ type: "result", subtype: "success", result: "완료" }, at)
      .some((event) => event.type === "completed")).toBe(true);
    expect(normalizeClaudePrintEvent({ type: "result", subtype: "success", is_error: true, result: "완료" }, at)
      .some((event) => event.type === "failed")).toBe(true);
  });
});

describe("검증 명령 도구 허용", () => {
  it("선언된 명령만 allowedTools로 올리고 없으면 넣지 않는다", () => {
    const config = {
      schemaVersion: 1 as const,
      runtime: { provider: "claude" as const, accountId: null, model: "claude-sonnet-5", reasoningEffort: "medium", sandbox: "workspace-write" as const, maxTurns: null },
      skills: { mode: "all" as const, enabled: [], disabled: [], profile: "native" as const, baseline: "installed" as const, additions: [], comparisonId: null, activation: "native" as const },
      harness: { type: "single" as const, maxIterations: 1, minimumScore: null, maxNoImprovement: 1, workerCount: 2, secondaryRuntime: null },
      hooks: [], budget: { maxSeconds: 60, maxTokens: null, maxCostUsd: null },
    };
    const snapshot = {
      provider: "claude" as const, cliVersion: "2.1.232", resolvedModel: "claude-sonnet-5",
      toolProfile: { sessionId: "11111111-1111-4111-8111-111111111111" }, permissionProfile: {}, skillManifest: [], preparedAt: "2026-08-15T00:00:00.000Z",
    };
    const base = { runId: "run-1", workingDirectory: "/tmp/x", prompt: "작업", config, snapshot };

    // 승인 주체가 없는 -p 실행에서 acceptEdits는 Bash를 전부 거부하므로 선언 명령만 열어준다.
    const withCommand = buildClaudePrintArgs({ ...base, allowedCommands: [["node", "--test", "test/scheduler.test.js"]] });
    const index = withCommand.indexOf("--allowedTools");
    expect(index).toBeGreaterThan(-1);
    expect(withCommand[index + 1]).toBe("Bash(node --test test/scheduler.test.js:*)");

    expect(buildClaudePrintArgs(base)).not.toContain("--allowedTools");
    expect(buildClaudePrintArgs({ ...base, allowedCommands: [[]] })).not.toContain("--allowedTools");
  });
});
