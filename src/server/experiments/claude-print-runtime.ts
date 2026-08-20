import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  type AgentRuntime,
  type ExperimentSkillOverlaySnapshot,
  type RuntimeEvent,
  type RuntimePrepareInput,
  type RuntimeResumeInput,
  type RuntimeRunInput,
  type RuntimeSnapshot,
  type RuntimeUsageSnapshot,
} from "./agent-runtime";
import { JsonlProcessExitError, JsonlProcessRunner } from "./jsonl-process";

const execFileAsync = promisify(execFile);

export interface ClaudeSkillManifestEntry {
  id: string;
  path: string;
  sha256: string;
}

export interface ClaudePrintRuntimeOptions {
  executable?: string;
  environment?: NodeJS.ProcessEnv;
  inheritProcessEnvironment?: boolean;
  processRunner?: JsonlProcessRunner;
  readVersion?: () => Promise<string>;
  detectMaxTurns?: () => Promise<boolean>;
  skillManifest?: (input: RuntimePrepareInput) => Promise<ClaudeSkillManifestEntry[]>;
  skillOverlay?: (input: RuntimePrepareInput) => Promise<ExperimentSkillOverlaySnapshot | null>;
  verifySkillOverlay?: (snapshot: ExperimentSkillOverlaySnapshot) => void;
}

// JSONL 중첩 값을 배열과 구분해 안전한 객체로 좁힌다.
function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

// 공급자 숫자를 음수·NaN 없이 nullable 정수로 정규화한다.
function usageNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

// 도구 상관관계 ID를 빈 문자열 없이 보존한다.
function eventId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

// Claude usage의 캐시 생성·읽기를 분리하고 전체 토큰은 파생값임을 명시한다.
function claudeUsage(value: unknown, cost: unknown): RuntimeUsageSnapshot | null {
  const usage = objectValue(value);
  const costUsd = typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null;
  if (!usage && costUsd === null) return null;
  const inputTokens = usageNumber(usage?.input_tokens);
  const cacheCreationInputTokens = usageNumber(usage?.cache_creation_input_tokens);
  const cacheReadInputTokens = usageNumber(usage?.cache_read_input_tokens);
  const outputTokens = usageNumber(usage?.output_tokens);
  const known = [inputTokens, cacheCreationInputTokens, cacheReadInputTokens, outputTokens];
  const totalTokens = known.every((entry) => entry !== null)
    ? known.reduce<number>((sum, entry) => sum + (entry ?? 0), 0)
    : null;
  return {
    inputTokens,
    cachedInputTokens: null,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    outputTokens,
    reasoningOutputTokens: null,
    totalTokens,
    totalTokensSource: totalTokens === null ? null : "derived",
    costUsd,
  };
}

// Claude native 권한 모드를 WAM 샌드박스 선택에 대응시킨다.
function permissionMode(input: RuntimeRunInput): "plan" | "acceptEdits" | "bypassPermissions" {
  if (input.config.runtime.sandbox === "read-only") return "plan";
  if (input.config.runtime.sandbox === "danger-full-access") return "bypassPermissions";
  return "acceptEdits";
}

// 선택 스킬처럼 Claude CLI가 정확히 격리할 수 없는 조건을 조용히 왜곡하지 않고 거부한다.
function appendSkillArgs(args: string[], input: RuntimeRunInput): void {
  if (input.snapshot.skillOverlay) {
    args.push("--setting-sources", "");
    args.push("--strict-mcp-config");
    args.push("--plugin-dir", input.snapshot.skillOverlay.bundleRoot);
    return;
  }
  if (input.config.skills.mode === "none") {
    args.push("--disable-slash-commands");
    return;
  }
  if (input.config.skills.mode === "selected" || input.config.skills.disabled.length > 0) {
    throw new Error("현재 Claude CLI는 개별 스킬 활성화·비활성화를 격리하지 못합니다. skills.mode는 all 또는 none을 사용하세요.");
  }
}

// Claude print 새 실행·resume의 구조화 JSONL argv를 재현 가능하게 만든다.
export function buildClaudePrintArgs(input: RuntimeRunInput, resumeSessionId?: string): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  else {
    const sessionId = eventId(input.snapshot.toolProfile.sessionId);
    if (!sessionId) throw new Error("Claude 새 실행에는 준비 단계의 sessionId가 필요합니다.");
    args.push("--session-id", sessionId);
  }
  if (input.config.runtime.model) args.push("--model", input.config.runtime.model);
  if (input.config.runtime.reasoningEffort) args.push("--effort", input.config.runtime.reasoningEffort);
  // 승인 주체가 없는 -p 실행에서 acceptEdits는 Bash를 전부 거부한다("This command requires approval").
  // 선언된 검증 명령만 도구 허용 목록에 올려 에이전트가 테스트를 돌릴 수 있게 한다.
  for (const command of input.allowedCommands ?? []) {
    if (command.length) args.push("--allowedTools", `Bash(${command.join(" ")}:*)`);
  }
  const mode = permissionMode(input);
  if (mode === "bypassPermissions") args.push("--dangerously-skip-permissions");
  else args.push("--permission-mode", mode);
  if (input.config.runtime.maxTurns !== null) {
    if (input.snapshot.toolProfile.supportsMaxTurns !== true) {
      throw new Error("현재 Claude CLI는 runtime.maxTurns를 지원하지 않습니다.");
    }
    args.push("--max-turns", String(input.config.runtime.maxTurns));
  }
  if (input.config.budget.maxCostUsd !== null) args.push("--max-budget-usd", String(input.config.budget.maxCostUsd));
  if (input.outputSchema) args.push("--json-schema", JSON.stringify(input.outputSchema));
  appendSkillArgs(args, input);
  return args;
}

// content 블록의 문자열·객체 결과를 이벤트 payload에 넣을 수 있는 객체로 통일한다.
function resultPayload(block: Record<string, unknown>): Record<string, unknown> {
  const content = block.content;
  return objectValue(content) ?? { ...block, content };
}

// Claude stream-json 한 레코드를 공급자 중립 이벤트로 변환한다.
export function normalizeClaudePrintEvent(raw: Record<string, unknown>, occurredAt = new Date().toISOString()): RuntimeEvent[] {
  const type = typeof raw.type === "string" ? raw.type : "";
  const parentToolCallId = eventId(raw.parent_tool_use_id);
  if (type === "system") {
    if (raw.subtype === "init") {
      return [{ type: "started", providerRunId: eventId(raw.session_id), details: raw, occurredAt }];
    }
    return [{ type: "message", role: "system", text: JSON.stringify(raw), occurredAt, parentToolCallId }];
  }
  if (type === "assistant" || type === "user") {
    const message = objectValue(raw.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    const events: RuntimeEvent[] = [];
    for (const entry of content) {
      const block = objectValue(entry);
      if (!block) continue;
      if (block.type === "text" && typeof block.text === "string" && block.text) {
        events.push({ type: "message", role: type, text: block.text, occurredAt, parentToolCallId });
      } else if (block.type === "tool_use") {
        events.push({
          type: "tool_started",
          name: typeof block.name === "string" ? block.name : "tool_use",
          payload: objectValue(block.input) ?? {},
          toolCallId: eventId(block.id), parentToolCallId, occurredAt,
        });
      } else if (block.type === "tool_result") {
        events.push({
          type: "tool_finished", name: "tool_result", payload: resultPayload(block),
          toolCallId: eventId(block.tool_use_id), parentToolCallId, occurredAt,
        });
      }
    }
    return events;
  }
  if (type === "result") {
    const events: RuntimeEvent[] = [];
    const usage = claudeUsage(raw.usage, raw.total_cost_usd);
    if (usage) events.push({ type: "usage", usage, occurredAt });
    const subtype = typeof raw.subtype === "string" ? raw.subtype : "";
    if (subtype === "success" && raw.is_error !== true) {
      events.push({ type: "completed", result: raw, occurredAt });
    } else {
      // 실측(Claude Code 2.1.232 번들): error 계열 subtype은 error, error_during_execution,
      // error_max_budget_usd, error_max_structured_output_retries, error_max_turns 다섯이다.
      // 예전 코드가 찾던 error_max_budget은 번들에 존재하지 않아 CLI 예산 초과가 runtime_error로
      // 기록됐다. 예전 이름도 함께 받아 버전 차이에 안전하게 둔다.
      const reason = subtype === "error_max_turns" ? "max_turns"
        : subtype === "error_max_budget_usd" || subtype === "error_max_budget" ? "cost_budget"
          : "runtime_error";
      const error = typeof raw.result === "string" && raw.result.trim()
        ? raw.result
        : `Claude 실행이 ${subtype || "unknown"} 상태로 종료됐습니다.`;
      events.push({ type: "failed", error, reason, occurredAt });
    }
    return events;
  }
  // partial stream_event는 완성 블록과 중복되므로 기본 프로필에서는 저장하지 않는다.
  return [];
}

// Claude Code print stream-json을 AgentRuntime 계약으로 실행한다.
export class ClaudePrintRuntime implements AgentRuntime {
  private readonly executable: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly inheritProcessEnvironment: boolean;
  private readonly runner: JsonlProcessRunner;
  private readonly readVersion: () => Promise<string>;
  private readonly detectMaxTurns: () => Promise<boolean>;
  private readonly skillManifest: (input: RuntimePrepareInput) => Promise<ClaudeSkillManifestEntry[]>;
  private readonly skillOverlay: (input: RuntimePrepareInput) => Promise<ExperimentSkillOverlaySnapshot | null>;
  private readonly verifySkillOverlay: (snapshot: ExperimentSkillOverlaySnapshot) => void;

  constructor(options: ClaudePrintRuntimeOptions = {}) {
    this.executable = options.executable ?? "claude";
    this.environment = options.environment ?? {};
    this.inheritProcessEnvironment = options.inheritProcessEnvironment ?? true;
    this.runner = options.processRunner ?? new JsonlProcessRunner();
    this.readVersion = options.readVersion ?? (async () => {
      const env = this.inheritProcessEnvironment ? { ...process.env, ...this.environment } : this.environment;
      const result = await execFileAsync(this.executable, ["--version"], { timeout: 15_000, env });
      return result.stdout.trim();
    });
    this.detectMaxTurns = options.detectMaxTurns ?? (async () => {
      try {
        const env = this.inheritProcessEnvironment ? { ...process.env, ...this.environment } : this.environment;
        const result = await execFileAsync(this.executable, ["--help"], { timeout: 15_000, env });
        return /(^|\s)--max-turns(?:\s|[<[])/m.test(result.stdout);
      } catch {
        return false;
      }
    });
    this.skillManifest = options.skillManifest ?? (async () => []);
    this.skillOverlay = options.skillOverlay ?? (async () => null);
    this.verifySkillOverlay = options.verifySkillOverlay ?? (() => undefined);
  }

  // CLI capability·모델·권한·스킬 manifest와 새 session UUID를 실행 전에 고정한다.
  async prepare(input: RuntimePrepareInput): Promise<RuntimeSnapshot> {
    const [cliVersion, supportsMaxTurns, skillManifest, skillOverlay] = await Promise.all([
      this.readVersion(), this.detectMaxTurns(), this.skillManifest(input), this.skillOverlay(input),
    ]);
    const sandbox = input.config.runtime.sandbox;
    return {
      provider: "claude",
      cliVersion,
      resolvedModel: input.config.runtime.model,
      toolProfile: {
        transport: "print-stream-json",
        sessionId: crypto.randomUUID(),
        supportsMaxTurns,
        skillIsolation: skillOverlay
          ? `${skillOverlay.baseline}-plus-pinned-overlay:${skillOverlay.activation}`
          : input.config.skills.mode === "none" ? "disable-all" : input.config.skills.mode === "all" ? "native-all" : "unsupported-selected",
      },
      permissionProfile: {
        sandbox,
        permissionMode: sandbox === "read-only" ? "plan" : sandbox === "danger-full-access" ? "bypassPermissions" : "acceptEdits",
      },
      skillManifest,
      skillOverlay,
      preparedAt: new Date().toISOString(),
    };
  }

  // 새 Claude print 실행의 stream-json을 정규화해 방출한다.
  async *run(input: RuntimeRunInput, signal: AbortSignal): AsyncIterable<RuntimeEvent> {
    yield* this.stream(input, signal);
  }

  // 저장된 Claude session ID에 새 prompt를 보내 같은 계약으로 재개한다.
  async *resume(input: RuntimeResumeInput, signal: AbortSignal): AsyncIterable<RuntimeEvent> {
    yield* this.stream(input, signal, input.providerRunId);
  }

  // 실행 중인 Claude 프로세스의 단계적 종료를 시작한다.
  async cancel(runId: string): Promise<void> {
    this.runner.cancel(runId);
  }

  // 새 실행과 resume의 공통 자식 프로세스·오류 경계를 제공한다.
  private async *stream(input: RuntimeRunInput, signal: AbortSignal, resumeSessionId?: string): AsyncIterable<RuntimeEvent> {
    let failure: unknown = null;
    try {
      for await (const raw of this.runner.run({
        runId: input.runId,
        command: this.executable,
        args: buildClaudePrintArgs(input, resumeSessionId),
        cwd: input.workingDirectory,
        env: this.environment,
        inheritProcessEnv: this.inheritProcessEnvironment,
        stdin: input.prompt,
      }, signal)) {
        for (const event of normalizeClaudePrintEvent(raw)) yield event;
      }
    } catch (error) {
      failure = error;
    } finally {
      if (input.snapshot.skillOverlay) {
        try { this.verifySkillOverlay(input.snapshot.skillOverlay); } catch (error) { failure ??= error; }
      }
    }
    if (failure) {
      const message = failure instanceof JsonlProcessExitError && failure.stderr.trim()
        ? `${failure.message}: ${failure.stderr.trim()}`
        : failure instanceof Error ? failure.message : String(failure);
      yield {
        type: "failed", error: message,
        reason: failure instanceof JsonlProcessExitError && failure.cancelled ? "cancelled" : "runtime_error",
        occurredAt: new Date().toISOString(),
      };
    }
  }
}
