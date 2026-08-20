import path from "node:path";
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

export interface CodexSkillManifestEntry {
  id: string;
  path: string;
  sha256: string;
}

export interface CodexExecRuntimeOptions {
  executable?: string;
  environment?: NodeJS.ProcessEnv;
  inheritProcessEnvironment?: boolean;
  processRunner?: JsonlProcessRunner;
  readVersion?: () => Promise<string>;
  skillManifest?: (input: RuntimePrepareInput) => Promise<CodexSkillManifestEntry[]>;
  skillOverlay?: (input: RuntimePrepareInput) => Promise<ExperimentSkillOverlaySnapshot | null>;
  verifySkillOverlay?: (snapshot: ExperimentSkillOverlaySnapshot) => void;
}

// JSONL 중첩 값을 객체로 안전하게 좁힌다.
function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

// 구조화 usage 숫자를 음수·NaN 없이 보존하고 미보고 값은 null로 둔다.
function usageNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

// Codex usage 객체를 캐시·추론 포함 공통 nullable 스냅샷으로 변환한다.
function codexUsage(value: unknown): RuntimeUsageSnapshot | null {
  const usage = objectValue(value);
  if (!usage) return null;
  const inputTokens = usageNumber(usage.input_tokens ?? usage.inputTokens);
  const cachedInputTokens = usageNumber(usage.cached_input_tokens ?? usage.cachedInputTokens);
  const cacheCreationInputTokens = usageNumber(usage.cache_write_input_tokens ?? usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens);
  const cacheReadInputTokens = usageNumber(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens);
  const outputTokens = usageNumber(usage.output_tokens ?? usage.outputTokens);
  const reasoningOutputTokens = usageNumber(usage.reasoning_output_tokens ?? usage.reasoningOutputTokens);
  const reportedTotal = usageNumber(usage.total_tokens ?? usage.totalTokens);
  const totalTokens = reportedTotal ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  if ([inputTokens, cachedInputTokens, cacheCreationInputTokens, cacheReadInputTokens, outputTokens, reasoningOutputTokens, totalTokens].every((entry) => entry === null)) return null;
  return {
    inputTokens, cachedInputTokens, cacheCreationInputTokens, cacheReadInputTokens,
    outputTokens, reasoningOutputTokens, totalTokens,
    totalTokensSource: reportedTotal !== null ? "reported" : totalTokens !== null ? "derived" : null,
    costUsd: null,
  };
}

// 공급자 이벤트의 도구 상관관계 ID를 빈 문자열 없이 보존한다.
function eventId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

// TOML override에 넣을 문자열을 JSON 인코딩과 같은 이스케이프 규칙으로 안전하게 감싼다.
function tomlString(value: string): string {
  return JSON.stringify(value);
}

// 실행 스냅샷의 전체 스킬 manifest를 Codex skills.config TOML 배열로 만든다.
function skillConfigOverride(input: RuntimeRunInput): string | null {
  const manifest = input.snapshot.skillManifest;
  const enabled = new Set(input.config.skills.enabled);
  const disabled = new Set(input.config.skills.disabled);
  const entries = manifest.map((skill) => {
    const selected = enabled.has(skill.id) || enabled.has(skill.path);
    const explicitlyDisabled = disabled.has(skill.id) || disabled.has(skill.path);
    const baseline = input.snapshot.skillOverlay?.baseline;
    const isEnabled = baseline === "clean" || input.config.skills.mode === "none"
      ? false
      : baseline === "installed"
        ? !explicitlyDisabled
        : input.config.skills.mode === "selected"
          ? selected && !explicitlyDisabled
          : !explicitlyDisabled;
    return `{ path = ${tomlString(path.dirname(skill.path))}, enabled = ${isEnabled ? "true" : "false"} }`;
  });
  for (const addition of input.snapshot.skillOverlay?.additions ?? []) {
    entries.push(`{ path = ${tomlString(addition.directory)}, enabled = true }`);
  }
  if (!entries.length) return null;
  return `skills.config=[${entries.join(", ")}]`;
}

// 새 실행과 resume의 실제 Codex argv를 현재 CLI 도움말 계약에 맞게 구성한다.
export function buildCodexExecArgs(input: RuntimeRunInput, resumeSessionId?: string): string[] {
  if (resumeSessionId && input.snapshot.skillOverlay) throw new Error("Codex overlay run은 격리 스킬 설정을 보존할 수 없는 resume로 재개할 수 없습니다.");
  const args = ["exec", "--strict-config"];
  if (resumeSessionId) args.push("resume", resumeSessionId);
  args.push("--json");
  // 현재 Codex CLI의 resume 하위 명령에는 --color가 없으므로 새 실행에만 적용한다.
  if (!resumeSessionId) args.push("--color", "never");
  if (input.config.runtime.model) args.push("--model", input.config.runtime.model);
  if (resumeSessionId) args.push("--config", `sandbox_mode=${tomlString(input.config.runtime.sandbox)}`);
  else args.push("--sandbox", input.config.runtime.sandbox, "--cd", input.workingDirectory);
  if (input.config.runtime.reasoningEffort) {
    args.push("--config", `model_reasoning_effort=${tomlString(input.config.runtime.reasoningEffort)}`);
  }
  const skills = skillConfigOverride(input);
  if (skills) args.push("--config", skills);
  const schemaPath = typeof input.snapshot.toolProfile.outputSchemaPath === "string"
    ? input.snapshot.toolProfile.outputSchemaPath
    : null;
  if (input.outputSchema && !schemaPath) throw new Error("Codex 구조화 출력에는 준비 단계에서 만든 outputSchemaPath가 필요합니다.");
  if (schemaPath) args.push("--output-schema", schemaPath);
  // 긴 프롬프트를 argv와 프로세스 목록에 노출하지 않고 전체 stdin으로 전달한다.
  args.push("-");
  return args;
}

// Codex exec JSONL 한 레코드를 0개 이상의 공급자 중립 이벤트로 정규화한다.
export function normalizeCodexExecEvent(raw: Record<string, unknown>, occurredAt = new Date().toISOString()): RuntimeEvent[] {
  const type = typeof raw.type === "string" ? raw.type : "";
  if (type === "thread.started") {
    const providerRunId = typeof raw.thread_id === "string" ? raw.thread_id : typeof raw.threadId === "string" ? raw.threadId : null;
    return [{ type: "started", providerRunId, occurredAt }];
  }
  const item = objectValue(raw.item);
  const itemType = typeof item?.type === "string" ? item.type : "";
  if ((type === "item.started" || type === "item.completed") && item) {
    if (itemType === "agent_message") {
      if (type !== "item.completed") return [];
      const text = typeof item.text === "string" ? item.text : typeof item.content === "string" ? item.content : "";
      return text ? [{ type: "message", role: "assistant", text, occurredAt }] : [];
    }
    if (["command_execution", "file_change", "mcp_tool_call", "web_search", "plan_update"].includes(itemType)) {
      const name = typeof item.command === "string" ? item.command : typeof item.name === "string" ? item.name : itemType;
      return [{
        type: type === "item.started" ? "tool_started" : "tool_finished", name, payload: item, occurredAt,
        toolCallId: eventId(item.id), parentToolCallId: eventId(item.parent_id ?? item.parentId),
      }];
    }
    if (itemType === "error" && type === "item.completed") {
      const message = typeof item.message === "string" ? item.message : "Codex 실행 항목이 실패했습니다.";
      return [{ type: "failed", error: message, occurredAt }];
    }
  }
  if (type === "turn.completed") {
    const events: RuntimeEvent[] = [];
    const usage = codexUsage(raw.usage);
    if (usage) events.push({ type: "usage", usage, occurredAt });
    events.push({ type: "completed", result: raw, occurredAt });
    return events;
  }
  if (type === "turn.failed" || type === "error") {
    const error = objectValue(raw.error);
    const message = typeof error?.message === "string"
      ? error.message
      : typeof raw.message === "string" ? raw.message : "Codex 구조화 실행이 실패했습니다.";
    return [{ type: "failed", error: message, occurredAt }];
  }
  return [];
}

// Codex exec --json을 AgentRuntime 공통 이벤트 스트림으로 실행한다.
export class CodexExecRuntime implements AgentRuntime {
  private readonly executable: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly inheritProcessEnvironment: boolean;
  private readonly runner: JsonlProcessRunner;
  private readonly readVersion: () => Promise<string>;
  private readonly skillManifest: (input: RuntimePrepareInput) => Promise<CodexSkillManifestEntry[]>;
  private readonly skillOverlay: (input: RuntimePrepareInput) => Promise<ExperimentSkillOverlaySnapshot | null>;
  private readonly verifySkillOverlay: (snapshot: ExperimentSkillOverlaySnapshot) => void;

  constructor(options: CodexExecRuntimeOptions = {}) {
    this.executable = options.executable ?? "codex";
    this.environment = options.environment ?? {};
    this.inheritProcessEnvironment = options.inheritProcessEnvironment ?? true;
    this.runner = options.processRunner ?? new JsonlProcessRunner();
    this.readVersion = options.readVersion ?? (async () => {
      const env = this.inheritProcessEnvironment ? { ...process.env, ...this.environment } : this.environment;
      const result = await execFileAsync(this.executable, ["--version"], { timeout: 15_000, env });
      return result.stdout.trim();
    });
    this.skillManifest = options.skillManifest ?? (async () => []);
    this.skillOverlay = options.skillOverlay ?? (async () => null);
    this.verifySkillOverlay = options.verifySkillOverlay ?? (() => undefined);
  }

  // CLI 버전과 요청한 모델·권한·스킬 manifest를 실행 환경 스냅샷으로 고정한다.
  async prepare(input: RuntimePrepareInput): Promise<RuntimeSnapshot> {
    const [cliVersion, skillManifest, skillOverlay] = await Promise.all([
      this.readVersion(), this.skillManifest(input), this.skillOverlay(input),
    ]);
    return {
      provider: "codex",
      cliVersion,
      resolvedModel: input.config.runtime.model,
      toolProfile: { transport: "exec-jsonl", outputSchemaPath: null },
      permissionProfile: { sandbox: input.config.runtime.sandbox },
      skillManifest,
      skillOverlay,
      preparedAt: new Date().toISOString(),
    };
  }

  // 새 Codex 실행의 JSONL을 순서대로 정규화해 방출한다.
  async *run(input: RuntimeRunInput, signal: AbortSignal): AsyncIterable<RuntimeEvent> {
    yield* this.stream(input, signal);
  }

  // 저장된 Codex thread ID에 새 prompt를 보내 같은 계약으로 재개한다.
  async *resume(input: RuntimeResumeInput, signal: AbortSignal): AsyncIterable<RuntimeEvent> {
    yield* this.stream(input, signal, input.providerRunId);
  }

  // 실행 중인 Codex 자식 프로세스의 단계적 종료를 시작한다.
  async cancel(runId: string): Promise<void> {
    this.runner.cancel(runId);
  }

  // 새 실행과 resume가 공유하는 자식 프로세스·정규화 오류 경계를 제공한다.
  private async *stream(input: RuntimeRunInput, signal: AbortSignal, resumeSessionId?: string): AsyncIterable<RuntimeEvent> {
    let failure: unknown = null;
    try {
      for await (const raw of this.runner.run({
        runId: input.runId,
        command: this.executable,
        args: buildCodexExecArgs(input, resumeSessionId),
        cwd: input.workingDirectory,
        env: this.environment,
        inheritProcessEnv: this.inheritProcessEnvironment,
        stdin: input.prompt,
      }, signal)) {
        for (const event of normalizeCodexExecEvent(raw)) yield event;
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
      yield { type: "failed", error: message, occurredAt: new Date().toISOString() };
    }
  }
}
