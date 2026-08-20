export const EXPERIMENT_HOOK_EVENTS = [
  "before_run", "after_run", "before_node", "after_node", "before_tool", "after_tool",
  "before_evaluate", "after_evaluate", "on_checkpoint", "on_budget", "on_error",
] as const;

export type ExperimentHookEvent = typeof EXPERIMENT_HOOK_EVENTS[number];
export type ExperimentHookMode = "observe" | "transform" | "validate" | "block";
export type ExperimentHookFailurePolicy = "fail_run" | "warn" | "ignore";

export interface ExperimentHookContext {
  event: ExperimentHookEvent;
  runId: string;
  nodeId: string | null;
  payload: Readonly<Record<string, unknown>>;
}

export interface ExperimentHookResult {
  payload?: Record<string, unknown>;
  valid?: boolean;
  blocked?: boolean;
  reason?: string;
}

export interface ExperimentHookRegistration {
  id: string;
  event: ExperimentHookEvent;
  mode: ExperimentHookMode;
  timeoutMs?: number;
  failurePolicy?: ExperimentHookFailurePolicy;
  handler(context: ExperimentHookContext): Promise<ExperimentHookResult | void> | ExperimentHookResult | void;
}

export interface ExperimentHookExecution {
  hookId: string;
  event: ExperimentHookEvent;
  mode: ExperimentHookMode;
  status: "completed" | "warned" | "ignored";
  durationMs: number;
  error: string | null;
}

export interface ExperimentHookEmission {
  payload: Record<string, unknown>;
  warnings: string[];
  executions: ExperimentHookExecution[];
}

// validate 훅이 명시적으로 입력을 거부했음을 실행 오류와 구분한다.
export class HookValidationError extends Error {
  constructor(public readonly hookId: string, message: string) {
    super(message);
    this.name = "HookValidationError";
  }
}

// block 훅이 정책상 실행을 중단했음을 런타임 오류와 구분한다.
export class HookBlockedError extends Error {
  constructor(public readonly hookId: string, message: string) {
    super(message);
    this.name = "HookBlockedError";
  }
}

// fail_run 정책 훅의 실행 실패와 타임아웃을 원래 원인과 함께 표시한다.
export class HookExecutionError extends Error {
  constructor(public readonly hookId: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HookExecutionError";
  }
}

// JSON 호환 payload를 복제해 훅 사이의 객체 참조 공유를 차단한다.
function clonePayload(payload: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(payload);
}

// 관찰자에게 전달할 객체를 재귀 동결해 중첩 상태 변경도 즉시 실패하게 한다.
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

// 훅 Promise에 개별 제한 시간을 적용하고 완료되면 timer를 정리한다.
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, hookId: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`훅 ${hookId} 실행 시간이 ${timeoutMs}ms를 초과했습니다.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// 실행별 훅을 안정된 등록 순서로 호출하고 명시적 mode만 payload에 영향을 주게 한다.
export class ExperimentHookBus {
  private readonly registrations: ExperimentHookRegistration[] = [];

  // 중복 ID와 비정상 timeout을 거부하고 훅을 마지막 순서에 등록한다.
  register(registration: ExperimentHookRegistration): void {
    const id = registration.id.trim();
    if (!id || id.length > 200) throw new Error("훅 ID는 1자 이상 200자 이하여야 합니다.");
    if (this.registrations.some((entry) => entry.id === id)) throw new Error(`이미 등록된 훅 ID입니다: ${id}`);
    if (this.registrations.length >= 100) throw new Error("실행 하나에는 최대 100개의 훅만 등록할 수 있습니다.");
    const timeoutMs = registration.timeoutMs ?? 5_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("훅 제한 시간은 1~60000ms여야 합니다.");
    this.registrations.push({ ...registration, id, timeoutMs, failurePolicy: registration.failurePolicy ?? "fail_run" });
  }

  // 이벤트에 등록된 훅을 순서대로 실행해 최종 payload와 관측 기록을 반환한다.
  async emit(input: {
    event: ExperimentHookEvent;
    runId: string;
    nodeId?: string | null;
    payload?: Record<string, unknown>;
  }): Promise<ExperimentHookEmission> {
    let payload = clonePayload(input.payload ?? {});
    const warnings: string[] = [];
    const executions: ExperimentHookExecution[] = [];
    for (const registration of this.registrations.filter((entry) => entry.event === input.event)) {
      const startedAt = Date.now();
      try {
        const context: ExperimentHookContext = {
          event: input.event,
          runId: input.runId,
          nodeId: input.nodeId ?? null,
          payload: deepFreeze(clonePayload(payload)),
        };
        const result = await withTimeout(
          Promise.resolve(registration.handler(context)), registration.timeoutMs!, registration.id,
        );
        if (registration.mode === "transform" && result?.payload) payload = clonePayload(result.payload);
        if (registration.mode === "validate" && result?.valid === false) {
          throw new HookValidationError(registration.id, result.reason || `훅 ${registration.id} 검증을 통과하지 못했습니다.`);
        }
        if (registration.mode === "block" && result?.blocked === true) {
          throw new HookBlockedError(registration.id, result.reason || `훅 ${registration.id} 정책이 실행을 차단했습니다.`);
        }
        executions.push({
          hookId: registration.id, event: input.event, mode: registration.mode,
          status: "completed", durationMs: Date.now() - startedAt, error: null,
        });
      } catch (error) {
        if (error instanceof HookValidationError || error instanceof HookBlockedError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        const policy = registration.failurePolicy!;
        if (policy === "fail_run") throw new HookExecutionError(registration.id, message, { cause: error });
        if (policy === "warn") warnings.push(`${registration.id}: ${message}`);
        executions.push({
          hookId: registration.id, event: input.event, mode: registration.mode,
          status: policy === "warn" ? "warned" : "ignored", durationMs: Date.now() - startedAt, error: message,
        });
      }
    }
    return { payload, warnings, executions };
  }
}
