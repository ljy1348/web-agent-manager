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
} from "./agent-runtime";
import { normalizeClaudePrintEvent } from "./claude-print-runtime";
import { JsonlProcessExitError, JsonlProcessRunner } from "./jsonl-process";
import { detectOsSandboxSupport } from "./os-sandbox";

const execFileAsync = promisify(execFile);

export interface GrokSkillManifestEntry {
  id: string;
  path: string;
  sha256: string;
}

export interface GrokPrintRuntimeOptions {
  executable?: string;
  environment?: NodeJS.ProcessEnv;
  inheritProcessEnvironment?: boolean;
  processRunner?: JsonlProcessRunner;
  readVersion?: () => Promise<string>;
  detectSandbox?: () => Promise<boolean>;
  skillManifest?: (input: RuntimePrepareInput) => Promise<GrokSkillManifestEntry[]>;
  skillOverlay?: (input: RuntimePrepareInput) => Promise<ExperimentSkillOverlaySnapshot | null>;
  verifySkillOverlay?: (snapshot: ExperimentSkillOverlaySnapshot) => void;
}

// 값이 있는 문자열만 남긴다.
function eventId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

// WAM 샌드박스 선택을 Grok native 권한 모드에 대응시킨다(값 이름은 Claude와 같다).
function permissionMode(input: RuntimeRunInput): "plan" | "acceptEdits" | "bypassPermissions" {
  if (input.config.runtime.sandbox === "read-only") return "plan";
  if (input.config.runtime.sandbox === "danger-full-access") return "bypassPermissions";
  return "acceptEdits";
}

// Grok은 Claude와 달리 실제 OS 샌드박스 프로파일(`--sandbox workspace|read-only|strict|off`)을 가진다.
// 권한 모드만 걸고 끝내면 read-only 조건이 파일 쓰기를 실제로 막지 못하므로 둘 다 건다.
function sandboxProfile(input: RuntimeRunInput): "read-only" | "workspace" | "off" {
  if (input.config.runtime.sandbox === "read-only") return "read-only";
  if (input.config.runtime.sandbox === "danger-full-access") return "off";
  return "workspace";
}

// Grok CLI가 정확히 격리할 수 없는 스킬 조건을 조용히 왜곡하지 않고 거부한다.
function appendSkillArgs(args: string[], input: RuntimeRunInput): void {
  if (input.snapshot.skillOverlay) {
    // `--plugin-dir`는 `grok agent`(SDK용 stdio 서버) 전용이고 headless `-p` 실행은 받지 않는다.
    // 실측: `grok -p ping --plugin-dir /tmp` → `error: unexpected argument '--plugin-dir' found`(exit 2).
    // 발견된 스킬을 끄는 수단(`--setting-sources` 상당)도 없어 pinned overlay를 정확히 재현할 방법이
    // 지금은 없다. 조용히 다른 스킬셋으로 실행하면 비교 자체가 무의미해지므로 실행 전에 거부한다.
    // TODO: headless가 받는 스킬 주입 수단(`grok agent` 계약 포함)이 확인되면 여기서 다시 지원한다.
    throw new Error("현재 Grok headless 실행은 스킬 overlay 주입을 지원하지 않습니다(--plugin-dir는 grok agent 전용). 격리 스킬 비교는 Codex·Claude를 사용하세요.");
  }
  if (input.config.skills.mode === "none") {
    throw new Error("현재 Grok CLI는 발견된 스킬을 끄는 옵션을 제공하지 않습니다. skills.mode는 all을 사용하세요.");
  }
  if (input.config.skills.mode === "selected" || input.config.skills.disabled.length > 0) {
    throw new Error("현재 Grok CLI는 개별 스킬 활성화·비활성화를 격리하지 못합니다. skills.mode는 all을 사용하세요.");
  }
}

// Grok headless 새 실행·resume의 구조화 JSONL argv를 재현 가능하게 만든다.
export function buildGrokPrintArgs(input: RuntimeRunInput, resumeSessionId?: string): string[] {
  // Grok headless는 stdin 파이프를 받지 않고(실측: `No such device or address`) `-p`로만 프롬프트를 받는다.
  // streaming-messages-json은 Anthropic Messages wire format이라 Claude stream-json 정규화기를 그대로 쓴다.
  const args = ["-p", input.prompt, "--output-format", "streaming-messages-json"];
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  else {
    const sessionId = eventId(input.snapshot.toolProfile.sessionId);
    if (!sessionId) throw new Error("Grok 새 실행에는 준비 단계의 sessionId가 필요합니다.");
    args.push("--session-id", sessionId);
  }
  if (input.config.runtime.model) args.push("--model", input.config.runtime.model);
  if (input.config.runtime.reasoningEffort) args.push("--reasoning-effort", input.config.runtime.reasoningEffort);
  // 승인 주체가 없는 headless 실행에서도 fixture가 선언한 검증 명령은 돌 수 있어야 한다.
  // Grok은 Claude Code 문법(`Bash(cmd:*)`)의 권한 규칙을 그대로 받는다.
  for (const command of input.allowedCommands ?? []) {
    if (command.length) args.push("--allow", `Bash(${command.join(" ")}:*)`);
  }
  args.push("--permission-mode", permissionMode(input));
  // 샌드박스는 강제할 수 있을 때만 건다. Linux에서 bubblewrap이 없으면 Grok은 실행을 시작하지 않고
  // 거부한다(실측: "bwrap exec failed ... Refusing to start with denied paths unprotected"). 무조건
  // 붙이면 그런 호스트에서는 실험이 통째로 못 돈다. 강제 가능 여부는 준비 단계에서 판정해 스냅샷에 남는다.
  if (input.snapshot.toolProfile.supportsSandbox === true) args.push("--sandbox", sandboxProfile(input));
  // Claude와 달리 `--max-turns`는 CLI 기본 옵션이라 capability 탐지가 필요 없다.
  if (input.config.runtime.maxTurns !== null) args.push("--max-turns", String(input.config.runtime.maxTurns));
  if (input.outputSchema) args.push("--json-schema", JSON.stringify(input.outputSchema));
  appendSkillArgs(args, input);
  return args;
}

// Grok headless streaming-messages-json을 AgentRuntime 계약으로 실행한다.
export class GrokPrintRuntime implements AgentRuntime {
  private readonly executable: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly inheritProcessEnvironment: boolean;
  private readonly runner: JsonlProcessRunner;
  private readonly readVersion: () => Promise<string>;
  private readonly detectSandbox: () => Promise<boolean>;
  private readonly skillManifest: (input: RuntimePrepareInput) => Promise<GrokSkillManifestEntry[]>;
  private readonly skillOverlay: (input: RuntimePrepareInput) => Promise<ExperimentSkillOverlaySnapshot | null>;
  private readonly verifySkillOverlay: (snapshot: ExperimentSkillOverlaySnapshot) => void;

  constructor(options: GrokPrintRuntimeOptions = {}) {
    this.executable = options.executable ?? "grok";
    this.environment = options.environment ?? {};
    this.inheritProcessEnvironment = options.inheritProcessEnvironment ?? true;
    this.runner = options.processRunner ?? new JsonlProcessRunner();
    this.readVersion = options.readVersion ?? (async () => {
      const env = this.inheritProcessEnvironment ? { ...process.env, ...this.environment } : this.environment;
      const result = await execFileAsync(this.executable, ["--version"], { timeout: 15_000, env });
      return result.stdout.trim();
    });
    // PATH에 bwrap이 있어도 유저 네임스페이스가 막히면 샌드박스 초기화가 실패한다. 실제 생성으로 판정한다.
    this.detectSandbox = options.detectSandbox ?? detectOsSandboxSupport;
    this.skillManifest = options.skillManifest ?? (async () => []);
    this.skillOverlay = options.skillOverlay ?? (async () => null);
    this.verifySkillOverlay = options.verifySkillOverlay ?? (() => undefined);
  }

  // CLI 버전·모델·권한·스킬 manifest와 새 session UUID를 실행 전에 고정한다.
  async prepare(input: RuntimePrepareInput): Promise<RuntimeSnapshot> {
    const [cliVersion, supportsSandbox, skillManifest, skillOverlay] = await Promise.all([
      this.readVersion(), this.detectSandbox(), this.skillManifest(input), this.skillOverlay(input),
    ]);
    const sandbox = input.config.runtime.sandbox;
    return {
      provider: "grok",
      cliVersion,
      resolvedModel: input.config.runtime.model,
      toolProfile: {
        transport: "headless-streaming-messages-json",
        sessionId: crypto.randomUUID(),
        supportsMaxTurns: true,
        supportsSandbox,
        // Grok에는 `--max-budget-usd`가 없어 비용 상한은 CLI가 아니라 WAM의 RuntimeBudgetPolicy만 강제한다.
        // 실행 도중 중단이 아니라 usage 보고 시점 판정이라는 차이를 스냅샷에 남긴다.
        costBudgetEnforcement: "wam-only",
        // overlay는 실행 단계에서 거부되므로 스냅샷에도 지원하지 않는 조건임을 그대로 남긴다.
        skillIsolation: skillOverlay ? "unsupported-overlay"
          : input.config.skills.mode === "all" ? "native-all" : "unsupported",
      },
      permissionProfile: {
        sandbox,
        permissionMode: sandbox === "read-only" ? "plan" : sandbox === "danger-full-access" ? "bypassPermissions" : "acceptEdits",
        // 강제 수단이 없으면 권한 모드만으로 돈다는 사실을 실행 provenance에 그대로 남긴다.
        sandboxProfile: supportsSandbox ? (sandbox === "read-only" ? "read-only" : sandbox === "danger-full-access" ? "off" : "workspace") : null,
        enforcement: supportsSandbox ? "grok-os-sandbox-and-permission-mode" : "permission-mode-only",
      },
      skillManifest,
      skillOverlay,
      preparedAt: new Date().toISOString(),
    };
  }

  // 새 Grok headless 실행의 JSONL을 정규화해 방출한다.
  async *run(input: RuntimeRunInput, signal: AbortSignal): AsyncIterable<RuntimeEvent> {
    yield* this.stream(input, signal);
  }

  // 저장된 Grok session ID에 새 prompt를 보내 같은 계약으로 재개한다.
  async *resume(input: RuntimeResumeInput, signal: AbortSignal): AsyncIterable<RuntimeEvent> {
    yield* this.stream(input, signal, input.providerRunId);
  }

  // 실행 중인 Grok 프로세스의 단계적 종료를 시작한다.
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
        args: buildGrokPrintArgs(input, resumeSessionId),
        cwd: input.workingDirectory,
        env: this.environment,
        inheritProcessEnv: this.inheritProcessEnvironment,
      }, signal)) {
        for (const event of normalizeClaudePrintEvent(raw, undefined, "Grok")) yield event;
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
