import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

export interface JsonlProcessInput {
  runId: string;
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  inheritProcessEnv?: boolean;
  stdin?: string;
  abortGraceMs?: number;
}

interface RunningProcess {
  child: ChildProcessWithoutNullStreams;
  forceTimer: NodeJS.Timeout | null;
  cancelled: boolean;
  processGroup: boolean;
}

// 단계적 종료 유예 시간을 공통 범위로 검증한다.
function validateGraceMs(graceMs: number): void {
  if (!Number.isInteger(graceMs) || graceMs < 0 || graceMs > 60_000) {
    throw new Error("CLI 종료 유예 시간은 0~60000ms여야 합니다.");
  }
}

// 구조화 CLI의 종료 코드·signal·제한된 stderr를 호출자에게 보존한다.
export class JsonlProcessExitError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly signal: NodeJS.Signals | null,
    public readonly stderr: string,
    public readonly cancelled: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "JsonlProcessExitError";
  }
}

// run ID와 CLI 인자가 비정상적으로 비어 있지 않은지 실행 전에 확인한다.
function validateInput(input: JsonlProcessInput): void {
  if (!input.runId.trim()) throw new Error("구조화 CLI 실행 ID가 필요합니다.");
  if (!input.command.trim()) throw new Error("구조화 CLI 명령이 필요합니다.");
  if (!input.cwd.trim()) throw new Error("구조화 CLI 작업 디렉터리가 필요합니다.");
  validateGraceMs(input.abortGraceMs ?? 5_000);
}

// stderr를 진단에 충분한 마지막 64KiB로 제한해 장기 실행 메모리 증가를 막는다.
function appendStderr(current: string, chunk: Buffer | string): string {
  const combined = current + chunk.toString();
  return combined.length > 65_536 ? combined.slice(-65_536) : combined;
}

// 구조화 CLI를 shell 없이 실행하고 stdout의 JSONL 객체를 순서대로 방출한다.
export class JsonlProcessRunner {
  private readonly running = new Map<string, RunningProcess>();

  // 한 run의 JSONL을 스트리밍하며 비정상 JSON·종료를 구조화 오류로 바꾼다.
  async *run(input: JsonlProcessInput, signal: AbortSignal): AsyncIterable<Record<string, unknown>> {
    validateInput(input);
    if (this.running.has(input.runId)) throw new Error(`이미 실행 중인 구조화 CLI run입니다: ${input.runId}`);
    if (signal.aborted) throw new JsonlProcessExitError("구조화 CLI 실행이 시작 전에 취소됐습니다.", null, null, "", true);
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.inheritProcessEnv === false ? input.env : { ...process.env, ...input.env },
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const state: RunningProcess = { child, forceTimer: null, cancelled: false, processGroup: process.platform !== "win32" };
    this.running.set(input.runId, state);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = appendStderr(stderr, chunk); });
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, exitSignal) => resolve({ code, signal: exitSignal }));
    });
    const abort = () => this.terminate(input.runId, input.abortGraceMs ?? 5_000);
    signal.addEventListener("abort", abort, { once: true });
    if (input.stdin !== undefined) child.stdin.end(input.stdin);
    else child.stdin.end();
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (error) {
          throw new JsonlProcessExitError("구조화 CLI가 JSONL이 아닌 stdout을 출력했습니다.", null, null, stderr, state.cancelled, { cause: error });
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new JsonlProcessExitError("구조화 CLI JSONL 레코드가 객체가 아닙니다.", null, null, stderr, state.cancelled);
        }
        yield parsed as Record<string, unknown>;
      }
      const result = await exit;
      if (state.cancelled || result.code !== 0) {
        throw new JsonlProcessExitError(
          state.cancelled ? "구조화 CLI 실행이 취소됐습니다." : `구조화 CLI가 종료 코드 ${result.code ?? "unknown"}(으)로 끝났습니다.`,
          result.code, result.signal, stderr, state.cancelled,
        );
      }
    } finally {
      lines.close();
      signal.removeEventListener("abort", abort);
      // 취소 시에는 부모가 먼저 끝나도 후손의 SIGTERM 정리 시간을 보장하도록 예약된 KILL 타이머를 유지한다.
      if (state.forceTimer && !state.cancelled) clearTimeout(state.forceTimer);
      this.running.delete(input.runId);
      if (!state.cancelled && child.exitCode === null && child.signalCode === null) this.signal(state, "SIGKILL");
    }
  }

  // 실행 중인 run에 SIGTERM을 보내고 유예 시간 뒤에만 SIGKILL로 정리한다.
  cancel(runId: string, graceMs = 5_000): boolean {
    validateGraceMs(graceMs);
    return this.terminate(runId, graceMs);
  }

  // 취소 상태를 표시하고 자식 프로세스의 단계적 종료를 시작한다.
  private terminate(runId: string, graceMs: number): boolean {
    const state = this.running.get(runId);
    if (!state || state.child.exitCode !== null || state.child.signalCode !== null) return false;
    state.cancelled = true;
    this.signal(state, "SIGTERM");
    if (graceMs === 0) this.signal(state, "SIGKILL");
    else if (!state.forceTimer) {
      state.forceTimer = setTimeout(() => {
        this.signal(state, "SIGKILL");
      }, graceMs);
      state.forceTimer.unref();
    }
    return true;
  }

  // POSIX에서는 CLI가 만든 모든 후손에, Windows에서는 직접 자식에 종료 신호를 보낸다.
  private signal(state: RunningProcess, signal: NodeJS.Signals): boolean {
    if (state.processGroup && state.child.pid) {
      try {
        process.kill(-state.child.pid, signal);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return state.child.kill(signal);
      }
    }
    return state.child.kill(signal);
  }
}
