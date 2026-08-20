import crypto from "node:crypto";
import type { AppDatabase } from "../core/database";
import type { DeterministicCheckStatus } from "../experiments/deterministic-check";
import {
  parseExperimentDesign,
  parseExperimentFixtureInput,
  parseExperimentTaskKind,
  parseExperimentVariantConfig,
  type ExperimentDesign,
  type ExperimentFixtureInput,
  type ExperimentFixtureSizeClass,
  type ExperimentFixtureStatus,
  type ExperimentTaskKind,
  type ExperimentCheckpointRecord,
  type ExperimentEventRecord,
  type ExperimentRunStatus,
  type ExperimentStatus,
  type ExperimentTerminationReason,
  type ExperimentVariantConfig,
} from "../../shared/experiments";

export interface ExperimentRecord {
  id: string;
  projectId: number;
  createdBy: number | null;
  name: string;
  command: string;
  design: ExperimentDesign;
  rubric: Record<string, unknown>;
  suiteId: string | null;
  taskKind: ExperimentTaskKind | null;
  fixtureId: string | null;
  status: ExperimentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ExperimentVariantRecord {
  id: string;
  experimentId: string;
  name: string;
  ordinal: number;
  config: ExperimentVariantConfig;
  createdAt: string;
  updatedAt: string;
}

export interface ExperimentRunRecord {
  id: string;
  experimentId: string;
  variantId: string;
  attempt: number;
  status: ExperimentRunStatus;
  configSnapshot: ExperimentVariantConfig;
  environmentSnapshot: Record<string, unknown>;
  baselineCommit: string | null;
  workingDirectory: string | null;
  providerRunId: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  totalTokensSource: "reported" | "derived" | null;
  costUsd: number | null;
  terminationReason: ExperimentTerminationReason | null;
  error: string | null;
  waitedSeconds: number;
  waitCount: number;
  checkStatus: DeterministicCheckStatus | null;
  checkExitCode: number | null;
  checkDurationMs: number | null;
  checkOutput: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExperimentNodeRecord {
  id: string;
  runId: string;
  parentNodeId: string | null;
  role: string;
  ordinal: number;
  attempt: number;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  provider: "codex" | "claude" | null;
  model: string | null;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  totalTokensSource: "reported" | "derived" | null;
  costUsd: number | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExperimentJudgmentRecord {
  id: string;
  evaluationId: string;
  callId: string | null;
  idempotencyKey: string | null;
  runId: string;
  evaluatorLabel: string;
  evaluatorKind: "agent" | "human" | "deterministic";
  evaluatorProvider: "codex" | "claude" | null;
  evaluatorModel: string | null;
  evaluatorFamily: string | null;
  subjectProvider: "codex" | "claude" | null;
  subjectModel: string | null;
  subjectFamily: string | null;
  sameFamily: boolean;
  blindLabel: string | null;
  presentationOrder: number | null;
  score: number | null;
  confidence: number | null;
  rank: number | null;
  result: Record<string, unknown>;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  totalTokensSource: "reported" | "derived" | null;
  costUsd: number | null;
  durationMs: number | null;
  createdAt: string;
}

export type ExperimentEvaluationStatus = "queued" | "running" | "completed" | "partial" | "failed" | "cancelled";
export type ExperimentEvaluationCallStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface ExperimentEvaluationSubjectRecord {
  runId: string;
  blindLabel: string;
  presentationOrder: number;
}

export interface ExperimentEvaluationRecord {
  id: string;
  experimentId: string;
  method: "deterministic" | "rubric" | "pairwise";
  status: ExperimentEvaluationStatus;
  rubric: Record<string, unknown>;
  blindMap: Record<string, unknown>;
  subjects: ExperimentEvaluationSubjectRecord[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface ExperimentEvaluationCallRecord {
  id: string;
  evaluationId: string;
  idempotencyKey: string;
  evaluatorLabel: string;
  evaluatorProvider: "codex" | "claude";
  evaluatorModel: string | null;
  evaluatorFamily: string | null;
  evaluatorAccountId: number | null;
  evaluatorCliVersion: string | null;
  status: ExperimentEvaluationCallStatus;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  totalTokensSource: "reported" | "derived" | null;
  costUsd: number | null;
  durationMs: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface ExperimentFixtureRecord extends ExperimentFixtureInput {
  id: string;
  status: ExperimentFixtureStatus;
  gate: Record<string, unknown>;
  mirrorPath: string | null;
  createdAt: string;
  updatedAt: string;
}

interface FixtureRow {
  id: string;
  name: string;
  url: string;
  pinned_commit: string;
  size_class: ExperimentFixtureSizeClass;
  language: string | null;
  license: string | null;
  lines_of_code: number | null;
  setup_command_json: string;
  test_command_json: string;
  status: ExperimentFixtureStatus;
  gate_json: string;
  mirror_path: string | null;
  created_at: string;
  updated_at: string;
}

export type ExperimentPlanStage = "screening" | "grid" | "confirmation";
export type ExperimentPlanStatus = "queued" | "running" | "completed" | "cancelled";
export type ExperimentPlanItemStatus = "queued" | "running" | "completed" | "failed" | "skipped";

export interface ExperimentRunPlanItemRecord {
  id: string;
  planId: string;
  variantId: string;
  ordinal: number;
  repetition: number;
  status: ExperimentPlanItemStatus;
  runId: string | null;
  error: string | null;
}

export interface ExperimentRunPlanRecord {
  id: string;
  experimentId: string;
  stage: ExperimentPlanStage;
  repetitions: number;
  status: ExperimentPlanStatus;
  baselineCommit: string | null;
  items: ExperimentRunPlanItemRecord[];
  createdAt: string;
  updatedAt: string;
}

interface PlanRow {
  id: string;
  experiment_id: string;
  stage: ExperimentPlanStage;
  repetitions: number;
  status: ExperimentPlanStatus;
  baseline_commit: string | null;
  created_at: string;
  updated_at: string;
}

interface PlanItemRow {
  id: string;
  plan_id: string;
  variant_id: string;
  ordinal: number;
  repetition: number;
  status: ExperimentPlanItemStatus;
  run_id: string | null;
  error: string | null;
}

interface ExperimentRow {
  id: string;
  project_id: number;
  created_by: number | null;
  name: string;
  command: string;
  design_json: string;
  rubric_json: string;
  suite_id: string | null;
  task_kind: ExperimentTaskKind | null;
  fixture_id: string | null;
  status: ExperimentStatus;
  created_at: string;
  updated_at: string;
}

interface VariantRow {
  id: string;
  experiment_id: string;
  name: string;
  ordinal: number;
  config_json: string;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  experiment_id: string;
  variant_id: string;
  attempt: number;
  status: ExperimentRunStatus;
  config_snapshot_json: string;
  environment_snapshot_json: string;
  baseline_commit: string | null;
  working_directory: string | null;
  provider_run_id: string | null;
  input_tokens: number;
  cached_input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
  total_tokens_source: "reported" | "derived" | null;
  cost_usd: number | null;
  termination_reason: ExperimentTerminationReason | null;
  error: string | null;
  waited_seconds: number;
  wait_count: number;
  check_status: DeterministicCheckStatus | null;
  check_exit_code: number | null;
  check_duration_ms: number | null;
  check_output: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: string;
  run_id: string;
  sequence: number;
  idempotency_key: string;
  type: string;
  payload_json: string;
  created_at: string;
}

interface NodeRow {
  id: string;
  run_id: string;
  parent_node_id: string | null;
  role: string;
  ordinal: number;
  attempt: number;
  status: ExperimentNodeRecord["status"];
  provider: "codex" | "claude" | null;
  model: string | null;
  input_json: string;
  output_json: string | null;
  input_tokens: number;
  cached_input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
  total_tokens_source: "reported" | "derived" | null;
  cost_usd: number | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CheckpointRow {
  run_id: string;
  node_id: string | null;
  event_sequence: number;
  state_json: string;
  artifacts_json: string;
  created_at: string;
  updated_at: string;
}

interface JudgmentRow {
  id: string;
  evaluation_id: string;
  call_id: string | null;
  idempotency_key: string | null;
  run_id: string;
  evaluator_label: string;
  evaluator_kind: ExperimentJudgmentRecord["evaluatorKind"];
  evaluator_provider: "codex" | "claude" | null;
  evaluator_model: string | null;
  evaluator_family: string | null;
  subject_provider: "codex" | "claude" | null;
  subject_model: string | null;
  subject_family: string | null;
  same_family: number;
  blind_label: string | null;
  presentation_order: number | null;
  score: number | null;
  confidence: number | null;
  rank: number | null;
  result_json: string;
  input_tokens: number;
  cached_input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
  total_tokens_source: "reported" | "derived" | null;
  cost_usd: number | null;
  duration_ms: number | null;
  created_at: string;
}

interface EvaluationRow {
  id: string;
  experiment_id: string;
  method: ExperimentEvaluationRecord["method"];
  status: ExperimentEvaluationStatus;
  rubric_json: string;
  blind_map_json: string;
  error: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

interface EvaluationCallRow {
  id: string;
  evaluation_id: string;
  idempotency_key: string;
  evaluator_label: string;
  evaluator_provider: "codex" | "claude";
  evaluator_model: string | null;
  evaluator_family: string | null;
  evaluator_account_id: number | null;
  evaluator_cli_version: string | null;
  status: ExperimentEvaluationCallStatus;
  input_tokens: number;
  cached_input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
  total_tokens_source: "reported" | "derived" | null;
  cost_usd: number | null;
  duration_ms: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

interface EvaluationSubjectRow {
  evaluation_id: string;
  run_id: string;
  blind_label: string;
  presentation_order: number;
}

const TERMINAL_STATUSES = new Set<ExperimentRunStatus>(["completed", "failed", "cancelled", "budget_exceeded"]);
const MAX_INLINE_EVENT_BYTES = 256 * 1024;
const RUN_TRANSITIONS: Record<ExperimentRunStatus, ReadonlySet<ExperimentRunStatus>> = {
  queued: new Set(["preparing", "cancelled"]),
  preparing: new Set(["running", "failed", "cancelled", "budget_exceeded"]),
  running: new Set(["paused", "evaluating", "completed", "failed", "cancelled", "budget_exceeded"]),
  paused: new Set(["running", "failed", "cancelled", "budget_exceeded"]),
  evaluating: new Set(["completed", "failed", "cancelled", "budget_exceeded"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  budget_exceeded: new Set(),
};

// DB의 JSON 객체를 읽고 손상된 원장 값을 즉시 드러낸다.
function parseObjectJson(value: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} JSON이 객체가 아닙니다.`);
  return parsed as Record<string, unknown>;
}

// DB의 JSON 문자열 배열을 체크포인트 산출물 ID로 검증한다.
function parseStringArrayJson(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) throw new Error("체크포인트 산출물 JSON이 올바르지 않습니다.");
  return parsed;
}

// 필수 문자열 입력을 공백 제거 후 길이 제한으로 검증한다.
function requiredString(value: string, maximum: number, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new Error(`${label}은 1자 이상 ${maximum}자 이하여야 합니다.`);
  return normalized;
}

// 선택 문자열 입력을 길이 제한에 맞게 정규화한다.
function nullableString(value: string | null | undefined, maximum: number, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredString(value, maximum, label);
}

// nullable usage 관측값을 음수·소수·NaN 없이 검증한다.
function nullableUsageNumber(value: number | null | undefined, label: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}은 0 이상의 안전한 정수여야 합니다.`);
  return value;
}

// nullable 비용 관측값을 음수·NaN 없이 검증한다.
function nullableUsageCost(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || value < 0) throw new Error("비용은 0 이상의 유한한 숫자여야 합니다.");
  return value;
}

// nullable 평가 수치를 유한한 지정 범위로 검증한다.
function nullableRangeNumber(value: number | null | undefined, minimum: number, maximum: number, label: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${label}은 ${minimum}~${maximum} 범위여야 합니다.`);
  return value;
}

// SQLite 실험 행을 API 공통 레코드로 변환한다.
// SQLite fixture 행을 공통 레코드로 복원한다. 명령은 argv 배열로만 보관한다.
function fixtureRecord(row: FixtureRow): ExperimentFixtureRecord {
  return {
    id: row.id, name: row.name, url: row.url, pinnedCommit: row.pinned_commit,
    sizeClass: row.size_class, language: row.language, license: row.license, linesOfCode: row.lines_of_code,
    setupCommand: JSON.parse(row.setup_command_json) as string[],
    testCommand: JSON.parse(row.test_command_json) as string[],
    status: row.status, gate: parseObjectJson(row.gate_json, "fixture 게이트"), mirrorPath: row.mirror_path,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function experimentRecord(row: ExperimentRow): ExperimentRecord {
  return {
    id: row.id, projectId: row.project_id, createdBy: row.created_by, name: row.name, command: row.command,
    design: parseExperimentDesign(JSON.parse(row.design_json)), rubric: parseObjectJson(row.rubric_json, "평가 기준"),
    suiteId: row.suite_id, taskKind: row.task_kind, fixtureId: row.fixture_id, status: row.status,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

// SQLite 변형 행의 버전 설정을 검증해 공통 레코드로 변환한다.
function variantRecord(row: VariantRow): ExperimentVariantRecord {
  return {
    id: row.id, experimentId: row.experiment_id, name: row.name, ordinal: row.ordinal,
    config: parseExperimentVariantConfig(JSON.parse(row.config_json)),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

// SQLite 실행 행과 설정 스냅샷을 공통 레코드로 변환한다.
function runRecord(row: RunRow): ExperimentRunRecord {
  return {
    id: row.id, experimentId: row.experiment_id, variantId: row.variant_id, attempt: row.attempt, status: row.status,
    configSnapshot: parseExperimentVariantConfig(JSON.parse(row.config_snapshot_json)),
    environmentSnapshot: parseObjectJson(row.environment_snapshot_json, "실행 환경 스냅샷"),
    baselineCommit: row.baseline_commit, workingDirectory: row.working_directory, providerRunId: row.provider_run_id,
    inputTokens: row.input_tokens, cachedInputTokens: row.cached_input_tokens,
    cacheCreationInputTokens: row.cache_creation_input_tokens, cacheReadInputTokens: row.cache_read_input_tokens,
    outputTokens: row.output_tokens, reasoningOutputTokens: row.reasoning_output_tokens, totalTokens: row.total_tokens,
    totalTokensSource: row.total_tokens_source, costUsd: row.cost_usd,
    terminationReason: row.termination_reason, error: row.error,
    waitedSeconds: row.waited_seconds, waitCount: row.wait_count,
    checkStatus: row.check_status, checkExitCode: row.check_exit_code,
    checkDurationMs: row.check_duration_ms, checkOutput: row.check_output,
    startedAt: row.started_at, finishedAt: row.finished_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

// SQLite 이벤트 행의 payload를 복원한다.
function eventRecord(row: EventRow): ExperimentEventRecord {
  return {
    id: row.id, runId: row.run_id, sequence: row.sequence, idempotencyKey: row.idempotency_key,
    type: row.type, payload: parseObjectJson(row.payload_json, "실험 이벤트"), createdAt: row.created_at,
  };
}

// SQLite node 행의 입력·출력 JSON과 usage를 공통 레코드로 복원한다.
function nodeRecord(row: NodeRow): ExperimentNodeRecord {
  return {
    id: row.id, runId: row.run_id, parentNodeId: row.parent_node_id, role: row.role, ordinal: row.ordinal,
    attempt: row.attempt, status: row.status, provider: row.provider, model: row.model,
    input: parseObjectJson(row.input_json, "노드 입력"), output: row.output_json ? parseObjectJson(row.output_json, "노드 출력") : null,
    inputTokens: row.input_tokens, cachedInputTokens: row.cached_input_tokens,
    cacheCreationInputTokens: row.cache_creation_input_tokens, cacheReadInputTokens: row.cache_read_input_tokens,
    outputTokens: row.output_tokens, reasoningOutputTokens: row.reasoning_output_tokens,
    totalTokens: row.total_tokens, totalTokensSource: row.total_tokens_source, costUsd: row.cost_usd,
    error: row.error, startedAt: row.started_at, finishedAt: row.finished_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

// SQLite 체크포인트 행의 그래프 상태와 산출물 참조를 복원한다.
function checkpointRecord(row: CheckpointRow): ExperimentCheckpointRecord {
  return {
    runId: row.run_id, nodeId: row.node_id, eventSequence: row.event_sequence,
    state: parseObjectJson(row.state_json, "체크포인트 상태"), artifacts: parseStringArrayJson(row.artifacts_json),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

// SQLite 심사 행의 evaluator·subject provenance와 결과 JSON을 API 레코드로 복원한다.
function judgmentRecord(row: JudgmentRow): ExperimentJudgmentRecord {
  return {
    id: row.id, evaluationId: row.evaluation_id, callId: row.call_id,
    idempotencyKey: row.idempotency_key, runId: row.run_id,
    evaluatorLabel: row.evaluator_label, evaluatorKind: row.evaluator_kind,
    evaluatorProvider: row.evaluator_provider, evaluatorModel: row.evaluator_model, evaluatorFamily: row.evaluator_family,
    subjectProvider: row.subject_provider, subjectModel: row.subject_model, subjectFamily: row.subject_family,
    sameFamily: row.same_family === 1, blindLabel: row.blind_label, presentationOrder: row.presentation_order,
    score: row.score, confidence: row.confidence, rank: row.rank,
    result: parseObjectJson(row.result_json, "심사 결과"),
    inputTokens: row.input_tokens, cachedInputTokens: row.cached_input_tokens,
    cacheCreationInputTokens: row.cache_creation_input_tokens, cacheReadInputTokens: row.cache_read_input_tokens,
    outputTokens: row.output_tokens, reasoningOutputTokens: row.reasoning_output_tokens,
    totalTokens: row.total_tokens, totalTokensSource: row.total_tokens_source, costUsd: row.cost_usd,
    durationMs: row.duration_ms, createdAt: row.created_at,
  };
}

// SQLite 평가 행에 별도 subject 관계를 결합해 API 레코드로 복원한다.
function evaluationRecord(row: EvaluationRow, subjects: ExperimentEvaluationSubjectRecord[]): ExperimentEvaluationRecord {
  return {
    id: row.id, experimentId: row.experiment_id, method: row.method, status: row.status,
    rubric: parseObjectJson(row.rubric_json, "평가 루브릭"), blindMap: parseObjectJson(row.blind_map_json, "블라인드 매핑"),
    subjects, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at, finishedAt: row.finished_at,
  };
}

// SQLite evaluator 호출 행을 usage·실패 provenance가 포함된 API 레코드로 복원한다.
function evaluationCallRecord(row: EvaluationCallRow): ExperimentEvaluationCallRecord {
  return {
    id: row.id, evaluationId: row.evaluation_id, idempotencyKey: row.idempotency_key,
    evaluatorLabel: row.evaluator_label, evaluatorProvider: row.evaluator_provider,
    evaluatorModel: row.evaluator_model, evaluatorFamily: row.evaluator_family,
    evaluatorAccountId: row.evaluator_account_id, evaluatorCliVersion: row.evaluator_cli_version,
    status: row.status, inputTokens: row.input_tokens, cachedInputTokens: row.cached_input_tokens,
    cacheCreationInputTokens: row.cache_creation_input_tokens, cacheReadInputTokens: row.cache_read_input_tokens,
    outputTokens: row.output_tokens, reasoningOutputTokens: row.reasoning_output_tokens,
    totalTokens: row.total_tokens, totalTokensSource: row.total_tokens_source, costUsd: row.cost_usd,
    durationMs: row.duration_ms, error: row.error, createdAt: row.created_at,
    updatedAt: row.updated_at, finishedAt: row.finished_at,
  };
}

// 실험 정의·실행 상태·append-only 이벤트·최신 체크포인트를 한 SQLite 원장으로 관리한다.
export class ExperimentRepository {
  constructor(private readonly database: AppDatabase) {}

  // 이전 서버 프로세스가 남긴 비terminal run을 재시작 시 명시적 runtime 실패로 종결한다.
  failInterruptedRuns(error = "서버 재시작으로 실험 실행이 중단됐습니다."): number {
    const result = this.database.prepare(`
      UPDATE experiment_runs SET
        status = 'failed', termination_reason = 'runtime_error', error = ?,
        finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
      WHERE status IN ('queued', 'preparing', 'running', 'paused', 'evaluating')
    `).run(requiredString(error, 20_000, "중단 실행 오류"));
    return result.changes;
  }

  // 이전 서버가 남긴 비terminal 평가와 호출을 실패로 종결해 영구 queued 상태를 막는다.
  failInterruptedEvaluations(error = "서버 재시작으로 평가가 중단됐습니다."): number {
    return this.database.transaction(() => {
      this.database.prepare(`
        UPDATE experiment_evaluation_calls SET status = 'failed', error = ?,
          finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE status IN ('queued', 'running')
      `).run(error);
      return this.database.prepare(`
        UPDATE experiment_evaluations SET status = 'failed', error = ?,
          finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE status IN ('queued', 'running')
      `).run(error).changes;
    })();
  }

  // 프로젝트에 공통 명령과 평가 기준을 가진 실험을 만든다.
  // 반복 실행을 arm 교차 순서로 미리 펼쳐 큐로 만든다. 무작위가 아니라 회전 교차라서 같은 arm이
  // 항상 먼저 도는 순서 효과를 없애면서도 순서를 재현할 수 있다.
  createRunPlan(input: { experimentId: string; stage: ExperimentPlanStage; repetitions: number; baselineCommit?: string | null }): ExperimentRunPlanRecord {
    const experiment = this.getExperiment(input.experimentId);
    if (!experiment) throw new Error("실험을 찾을 수 없습니다.");
    if (!["screening", "grid", "confirmation"].includes(input.stage)) throw new Error("지원하지 않는 실행 계획 단계입니다.");
    if (!Number.isInteger(input.repetitions) || input.repetitions < 1 || input.repetitions > 100) {
      throw new Error("반복 횟수는 1~100 범위의 정수여야 합니다.");
    }
    const variants = this.listVariants(input.experimentId);
    if (!variants.length) throw new Error("실행 계획에는 Variant가 하나 이상 필요합니다.");
    const id = crypto.randomUUID();
    const insertPlan = this.database.prepare("INSERT INTO experiment_run_plans(id, experiment_id, stage, repetitions, baseline_commit) VALUES (?, ?, ?, ?, ?)");
    const insertItem = this.database.prepare(`
      INSERT INTO experiment_run_plan_items(id, plan_id, variant_id, ordinal, repetition) VALUES (?, ?, ?, ?, ?)
    `);
    this.database.transaction(() => {
      insertPlan.run(id, input.experimentId, input.stage, input.repetitions, input.baselineCommit ?? null);
      let ordinal = 0;
      for (let repetition = 0; repetition < input.repetitions; repetition += 1) {
        // 회전 교차: 반복 회차마다 시작 arm을 한 칸씩 민다.
        for (let index = 0; index < variants.length; index += 1) {
          const variant = variants[(index + repetition) % variants.length];
          insertItem.run(crypto.randomUUID(), id, variant.id, ordinal, repetition);
          ordinal += 1;
        }
      }
    })();
    return this.getRunPlan(id)!;
  }

  getRunPlan(id: string): ExperimentRunPlanRecord | null {
    const row = this.database.prepare("SELECT * FROM experiment_run_plans WHERE id = ?").get(id) as PlanRow | undefined;
    if (!row) return null;
    const items = this.database.prepare("SELECT * FROM experiment_run_plan_items WHERE plan_id = ? ORDER BY ordinal").all(id) as PlanItemRow[];
    return {
      id: row.id, experimentId: row.experiment_id, stage: row.stage, repetitions: row.repetitions, status: row.status,
      baselineCommit: row.baseline_commit,
      items: items.map((item) => ({
        id: item.id, planId: item.plan_id, variantId: item.variant_id, ordinal: item.ordinal,
        repetition: item.repetition, status: item.status, runId: item.run_id, error: item.error,
      })),
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  listRunPlans(experimentId: string): ExperimentRunPlanRecord[] {
    const rows = this.database.prepare("SELECT id FROM experiment_run_plans WHERE experiment_id = ? ORDER BY created_at DESC").all(experimentId) as Array<{ id: string }>;
    return rows.map((row) => this.getRunPlan(row.id)!);
  }

  // 아직 실행하지 않은 첫 항목을 순서대로 하나만 준다. 중간 실패가 큐를 멈추지 않는다.
  nextQueuedPlanItem(planId: string): ExperimentRunPlanItemRecord | null {
    const plan = this.getRunPlan(planId);
    if (!plan || plan.status === "cancelled") return null;
    return plan.items.find((item) => item.status === "queued") ?? null;
  }

  updatePlanItem(itemId: string, input: { status: ExperimentPlanItemStatus; runId?: string | null; error?: string | null }): ExperimentRunPlanItemRecord {
    this.database.prepare(`
      UPDATE experiment_run_plan_items
      SET status = ?, run_id = COALESCE(?, run_id), error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(input.status, input.runId ?? null, nullableString(input.error, 5_000, "실행 계획 오류"), itemId);
    const row = this.database.prepare("SELECT * FROM experiment_run_plan_items WHERE id = ?").get(itemId) as PlanItemRow | undefined;
    if (!row) throw new Error("실행 계획 항목을 찾을 수 없습니다.");
    return {
      id: row.id, planId: row.plan_id, variantId: row.variant_id, ordinal: row.ordinal,
      repetition: row.repetition, status: row.status, runId: row.run_id, error: row.error,
    };
  }

  setRunPlanStatus(planId: string, status: ExperimentPlanStatus): ExperimentRunPlanRecord {
    this.database.prepare("UPDATE experiment_run_plans SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(status, planId);
    const plan = this.getRunPlan(planId);
    if (!plan) throw new Error("실행 계획을 찾을 수 없습니다.");
    return plan;
  }

  // 같은 비교군을 여러 상황(과제 유형·저장소·명세 명확도)에서 돌리기 위한 상위 묶음을 만든다.
  // 셀 하나(= 실험 하나)의 결과만으로는 "어디엔 뭐가 좋다"를 말할 수 없기 때문에 필요하다.
  createSuite(input: { projectId: number; name: string; note?: string | null }): { id: string; projectId: number; name: string; note: string | null } {
    if (!Number.isInteger(input.projectId) || input.projectId < 1) throw new Error("유효한 프로젝트 ID가 필요합니다.");
    const id = crypto.randomUUID();
    this.database.prepare("INSERT INTO experiment_suites(id, project_id, name, note) VALUES (?, ?, ?, ?)")
      .run(id, input.projectId, requiredString(input.name, 200, "스위트 이름"), nullableString(input.note ?? null, 2_000, "스위트 메모"));
    return { id, projectId: input.projectId, name: input.name, note: input.note ?? null };
  }

  listSuiteExperiments(suiteId: string): ExperimentRecord[] {
    const rows = this.database.prepare("SELECT * FROM experiments WHERE suite_id = ? ORDER BY created_at").all(suiteId) as ExperimentRow[];
    return rows.map(experimentRecord);
  }

  getSuite(id: string): { id: string; projectId: number; name: string; note: string | null } | null {
    const row = this.database.prepare("SELECT id, project_id AS projectId, name, note FROM experiment_suites WHERE id = ?")
      .get(id) as { id: string; projectId: number; name: string; note: string | null } | undefined;
    return row ?? null;
  }

  // 외부 공개 저장소 fixture를 등록한다. 적격성 게이트를 통과하기 전에는 draft로 남아 실험 대상이 될 수 없다.
  createFixture(input: unknown): ExperimentFixtureRecord {
    const parsed = parseExperimentFixtureInput(input);
    const id = crypto.randomUUID();
    this.database.prepare(`
      INSERT INTO experiment_fixtures(id, name, url, pinned_commit, size_class, language, license, lines_of_code, setup_command_json, test_command_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, parsed.name, parsed.url, parsed.pinnedCommit, parsed.sizeClass, parsed.language, parsed.license,
      parsed.linesOfCode, JSON.stringify(parsed.setupCommand), JSON.stringify(parsed.testCommand),
    );
    return this.getFixture(id)!;
  }

  getFixture(id: string): ExperimentFixtureRecord | null {
    const row = this.database.prepare("SELECT * FROM experiment_fixtures WHERE id = ?").get(id) as FixtureRow | undefined;
    return row ? fixtureRecord(row) : null;
  }

  listFixtures(): ExperimentFixtureRecord[] {
    const rows = this.database.prepare("SELECT * FROM experiment_fixtures ORDER BY size_class, name").all() as FixtureRow[];
    return rows.map(fixtureRecord);
  }

  // 적격성 게이트 판정 결과를 기록한다. 통과하면 ready, 실패하면 rejected로 고정해 재시도를 막는다.
  recordFixtureGate(id: string, passed: boolean, gate: Record<string, unknown>): ExperimentFixtureRecord {
    if (!this.getFixture(id)) throw new Error("저장소 fixture를 찾을 수 없습니다.");
    this.database.prepare("UPDATE experiment_fixtures SET status = ?, gate_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(passed ? "ready" : "rejected", JSON.stringify(gate), id);
    return this.getFixture(id)!;
  }

  // 준비된 bare mirror 경로를 고정한다. 이후 run worktree는 모두 이 mirror에서 만든다.
  recordFixtureMirror(id: string, mirrorPath: string): ExperimentFixtureRecord {
    if (!this.getFixture(id)) throw new Error("저장소 fixture를 찾을 수 없습니다.");
    this.database.prepare("UPDATE experiment_fixtures SET mirror_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(requiredString(mirrorPath, 1_000, "fixture mirror 경로"), id);
    return this.getFixture(id)!;
  }

  createExperiment(input: {
    projectId: number;
    createdBy?: number | null;
    name: string;
    command: string;
    design?: unknown;
    rubric?: Record<string, unknown>;
    taskKind?: unknown;
    fixtureId?: string | null;
    suiteId?: string | null;
  }): ExperimentRecord {
    if (!Number.isInteger(input.projectId) || input.projectId < 1) throw new Error("유효한 프로젝트 ID가 필요합니다.");
    const id = crypto.randomUUID();
    const design = parseExperimentDesign(input.design ?? {
      schemaVersion: 1, hypothesis: null, controlledVariables: [], treatmentVariables: [], repetitions: 1, randomizeOrder: true,
    });
    this.database.prepare(`
      INSERT INTO experiments(id, project_id, created_by, name, command, design_json, rubric_json, task_kind, fixture_id, suite_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.projectId, input.createdBy ?? null, requiredString(input.name, 200, "실험 이름"),
      requiredString(input.command, 100_000, "실험 명령"), JSON.stringify(design), JSON.stringify(input.rubric ?? {}),
      parseExperimentTaskKind(input.taskKind), input.fixtureId ?? null, input.suiteId ?? null,
    );
    return this.getExperiment(id)!;
  }

  // ID로 실험을 읽으며 존재하지 않으면 null을 반환한다.
  getExperiment(id: string): ExperimentRecord | null {
    const row = this.database.prepare("SELECT * FROM experiments WHERE id = ?").get(id) as ExperimentRow | undefined;
    return row ? experimentRecord(row) : null;
  }

  // 프로젝트의 실험을 최근 수정 순으로 반환한다.
  listExperiments(projectId: number): ExperimentRecord[] {
    const rows = this.database.prepare("SELECT * FROM experiments WHERE project_id = ? ORDER BY updated_at DESC, created_at DESC")
      .all(projectId) as ExperimentRow[];
    return rows.map(experimentRecord);
  }

  // 검증된 실행 조건을 실험의 순서 있는 변형으로 추가한다.
  createVariant(input: {
    experimentId: string;
    name: string;
    config: unknown;
    ordinal?: number;
  }): ExperimentVariantRecord {
    if (!this.getExperiment(input.experimentId)) throw new Error("실험을 찾을 수 없습니다.");
    const config = parseExperimentVariantConfig(input.config);
    const ordinal = input.ordinal ?? 0;
    if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal > 10_000) throw new Error("변형 순서가 올바르지 않습니다.");
    const id = crypto.randomUUID();
    this.database.prepare(`
      INSERT INTO experiment_variants(id, experiment_id, name, ordinal, config_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, input.experimentId, requiredString(input.name, 200, "변형 이름"), ordinal, JSON.stringify(config));
    return this.getVariant(id)!;
  }

  // ID로 실험 변형과 검증된 설정을 읽는다.
  getVariant(id: string): ExperimentVariantRecord | null {
    const row = this.database.prepare("SELECT * FROM experiment_variants WHERE id = ?").get(id) as VariantRow | undefined;
    return row ? variantRecord(row) : null;
  }

  // 실험의 변형을 사용자 지정 순서와 생성 순서대로 반환한다.
  listVariants(experimentId: string): ExperimentVariantRecord[] {
    const rows = this.database.prepare("SELECT * FROM experiment_variants WHERE experiment_id = ? ORDER BY ordinal, created_at")
      .all(experimentId) as VariantRow[];
    return rows.map(variantRecord);
  }

  // 변형의 현재 설정을 실행 시점 스냅샷으로 고정해 다음 시도 번호의 run을 만든다.
  createRun(input: {
    variantId: string;
    configSnapshot?: unknown;
    environmentSnapshot?: Record<string, unknown>;
    baselineCommit?: string | null;
    workingDirectory?: string | null;
  }): ExperimentRunRecord {
    const variant = this.getVariant(input.variantId);
    if (!variant) throw new Error("실험 변형을 찾을 수 없습니다.");
    const snapshot = input.configSnapshot === undefined
      ? variant.config
      : parseExperimentVariantConfig(input.configSnapshot);
    const id = crypto.randomUUID();
    const attempt = this.database.transaction(() => {
      const latest = this.database.prepare("SELECT COALESCE(MAX(attempt), 0) AS attempt FROM experiment_runs WHERE variant_id = ?")
        .get(input.variantId) as { attempt: number };
      const nextAttempt = latest.attempt + 1;
      this.database.prepare(`
        INSERT INTO experiment_runs(
          id, experiment_id, variant_id, attempt, config_snapshot_json, environment_snapshot_json,
          baseline_commit, working_directory
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, variant.experimentId, variant.id, nextAttempt, JSON.stringify(snapshot), JSON.stringify(input.environmentSnapshot ?? {}),
        nullableString(input.baselineCommit, 200, "기준 커밋"),
        nullableString(input.workingDirectory, 4_096, "작업 디렉터리"),
      );
      return nextAttempt;
    })();
    const run = this.getRun(id);
    if (!run || run.attempt !== attempt) throw new Error("실험 실행을 생성하지 못했습니다.");
    return run;
  }

  // ID로 실행과 당시 설정 스냅샷을 읽는다.
  getRun(id: string): ExperimentRunRecord | null {
    const row = this.database.prepare("SELECT * FROM experiment_runs WHERE id = ?").get(id) as RunRow | undefined;
    return row ? runRecord(row) : null;
  }

  // 실험 또는 변형의 run을 최근 생성 순으로 반환한다.
  listRuns(input: { experimentId?: string; variantId?: string; limit?: number }): ExperimentRunRecord[] {
    if (!input.experimentId && !input.variantId) throw new Error("실험 또는 변형 ID가 필요합니다.");
    const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)));
    const rows = input.variantId
      ? this.database.prepare("SELECT * FROM experiment_runs WHERE variant_id = ? ORDER BY created_at DESC LIMIT ?").all(input.variantId, limit)
      : this.database.prepare("SELECT * FROM experiment_runs WHERE experiment_id = ? ORDER BY created_at DESC LIMIT ?").all(input.experimentId, limit);
    return (rows as RunRow[]).map(runRecord);
  }

  // 한 run에 순서가 고정된 에이전트 호출 node를 추가한다.
  createNode(input: {
    runId: string;
    parentNodeId?: string | null;
    role: string;
    provider?: "codex" | "claude" | null;
    model?: string | null;
    payload?: Record<string, unknown>;
  }): ExperimentNodeRecord {
    const run = this.getRun(input.runId);
    if (!run) throw new Error("실험 실행을 찾을 수 없습니다.");
    if (run.status !== "preparing" && run.status !== "running") throw new Error("노드는 준비 또는 실행 중인 run에만 추가할 수 있습니다.");
    if (input.parentNodeId) {
      const parent = this.getNode(input.parentNodeId);
      if (!parent || parent.runId !== input.runId) throw new Error("부모 노드가 이 실행에 속하지 않습니다.");
    }
    const payloadJson = JSON.stringify(input.payload ?? {});
    if (Buffer.byteLength(payloadJson, "utf8") > MAX_INLINE_EVENT_BYTES) throw new Error("노드 입력은 256KiB를 초과할 수 없습니다.");
    const id = crypto.randomUUID();
    this.database.transaction(() => {
      const latest = this.database.prepare("SELECT COALESCE(MAX(ordinal), 0) AS ordinal FROM experiment_nodes WHERE run_id = ?")
        .get(input.runId) as { ordinal: number };
      this.database.prepare(`
        INSERT INTO experiment_nodes(id, run_id, parent_node_id, role, ordinal, provider, model, input_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, input.runId, input.parentNodeId ?? null, requiredString(input.role, 200, "노드 역할"), latest.ordinal + 1,
        input.provider ?? null, nullableString(input.model, 500, "노드 모델"), payloadJson,
      );
    })();
    return this.getNode(id)!;
  }

  // ID로 에이전트 호출 node를 읽는다.
  getNode(id: string): ExperimentNodeRecord | null {
    const row = this.database.prepare("SELECT * FROM experiment_nodes WHERE id = ?").get(id) as NodeRow | undefined;
    return row ? nodeRecord(row) : null;
  }

  // run의 agent node를 실행 순서대로 반환한다.
  listNodes(runId: string): ExperimentNodeRecord[] {
    const rows = this.database.prepare("SELECT * FROM experiment_nodes WHERE run_id = ? ORDER BY ordinal, attempt")
      .all(runId) as NodeRow[];
    return rows.map(nodeRecord);
  }

  // run을 평가한 모든 자동·사람·결정적 심사의 provenance를 생성 순서대로 반환한다.
  listJudgments(runId: string): ExperimentJudgmentRecord[] {
    const rows = this.database.prepare("SELECT * FROM experiment_judgments WHERE run_id = ? ORDER BY created_at, presentation_order, id")
      .all(runId) as JudgmentRow[];
    return rows.map(judgmentRecord);
  }

  // 한 실험의 대상 run·블라인드 순서를 고정한 평가 라운드를 transaction으로 만든다.
  createEvaluation(input: {
    experimentId: string;
    method: ExperimentEvaluationRecord["method"];
    rubric: Record<string, unknown>;
    subjects: ExperimentEvaluationSubjectRecord[];
  }): ExperimentEvaluationRecord {
    const experiment = this.getExperiment(input.experimentId);
    if (!experiment) throw new Error("실험을 찾을 수 없습니다.");
    if (!["deterministic", "rubric", "pairwise"].includes(input.method)) throw new Error("평가 방식이 올바르지 않습니다.");
    if (!Array.isArray(input.subjects) || input.subjects.length < 1 || input.subjects.length > 100) throw new Error("평가 대상은 1~100개가 필요합니다.");
    const runIds = new Set<string>();
    const labels = new Set<string>();
    const orders = new Set<number>();
    const subjects = input.subjects.map((subject) => {
      const run = this.getRun(subject.runId);
      if (!run || run.experimentId !== input.experimentId) throw new Error("평가 대상 run이 이 실험에 속하지 않습니다.");
      const blindLabel = requiredString(subject.blindLabel, 200, "블라인드 라벨");
      if (!Number.isInteger(subject.presentationOrder) || subject.presentationOrder < 1 || subject.presentationOrder > input.subjects.length) {
        throw new Error("평가 대상 제시 순서가 올바르지 않습니다.");
      }
      if (runIds.has(run.id) || labels.has(blindLabel) || orders.has(subject.presentationOrder)) throw new Error("평가 대상 run·라벨·순서는 중복될 수 없습니다.");
      runIds.add(run.id); labels.add(blindLabel); orders.add(subject.presentationOrder);
      return { runId: run.id, blindLabel, presentationOrder: subject.presentationOrder };
    });
    const rubricJson = JSON.stringify(input.rubric ?? {});
    if (Buffer.byteLength(rubricJson, "utf8") > MAX_INLINE_EVENT_BYTES) throw new Error("평가 루브릭은 256KiB를 초과할 수 없습니다.");
    const blindMap = Object.fromEntries(subjects.map((subject) => [subject.blindLabel, subject.runId]));
    const id = crypto.randomUUID();
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO experiment_evaluations(id, experiment_id, method, rubric_json, blind_map_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, experiment.id, input.method, rubricJson, JSON.stringify(blindMap));
      const insert = this.database.prepare(`
        INSERT INTO experiment_evaluation_subjects(evaluation_id, run_id, blind_label, presentation_order)
        VALUES (?, ?, ?, ?)
      `);
      for (const subject of subjects) insert.run(id, subject.runId, subject.blindLabel, subject.presentationOrder);
    })();
    return this.getEvaluation(id)!;
  }

  // ID로 평가 라운드와 대상 관계를 함께 읽는다.
  getEvaluation(id: string): ExperimentEvaluationRecord | null {
    const row = this.database.prepare("SELECT * FROM experiment_evaluations WHERE id = ?").get(id) as EvaluationRow | undefined;
    if (!row) return null;
    const subjects = this.database.prepare(`
      SELECT * FROM experiment_evaluation_subjects WHERE evaluation_id = ? ORDER BY presentation_order
    `).all(id) as EvaluationSubjectRow[];
    return evaluationRecord(row, subjects.map((subject) => ({
      runId: subject.run_id, blindLabel: subject.blind_label, presentationOrder: subject.presentation_order,
    })));
  }

  // run 또는 실험에 속한 평가 라운드를 최근 생성 순으로 반환한다.
  listEvaluations(input: { runId?: string; experimentId?: string; limit?: number }): ExperimentEvaluationRecord[] {
    if (!input.runId && !input.experimentId) throw new Error("평가 조회에는 run 또는 실험 ID가 필요합니다.");
    const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)));
    const rows = input.runId
      ? this.database.prepare(`
        SELECT e.* FROM experiment_evaluations e
        JOIN experiment_evaluation_subjects s ON s.evaluation_id = e.id
        WHERE s.run_id = ? ORDER BY e.created_at DESC LIMIT ?
      `).all(input.runId, limit)
      : this.database.prepare("SELECT * FROM experiment_evaluations WHERE experiment_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(input.experimentId, limit);
    return (rows as EvaluationRow[]).map((row) => this.getEvaluation(row.id)!);
  }

  // 평가 상태를 허용된 단방향으로 전이하고 terminal 시각을 고정한다.
  transitionEvaluation(evaluationId: string, status: ExperimentEvaluationStatus, error: string | null = null): ExperimentEvaluationRecord {
    const current = this.getEvaluation(evaluationId);
    if (!current) throw new Error("평가 라운드를 찾을 수 없습니다.");
    const transitions: Record<ExperimentEvaluationStatus, Set<ExperimentEvaluationStatus>> = {
      queued: new Set(["running", "cancelled"]),
      running: new Set(["completed", "partial", "failed", "cancelled"]),
      completed: new Set(), partial: new Set(), failed: new Set(), cancelled: new Set(),
    };
    if (current.status === status) return current;
    if (!transitions[current.status].has(status)) throw new Error(`평가 상태를 ${current.status}에서 ${status}(으)로 바꿀 수 없습니다.`);
    const terminal = ["completed", "partial", "failed", "cancelled"].includes(status);
    const result = this.database.prepare(`
      UPDATE experiment_evaluations SET status = ?,
        error = ?,
        finished_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE finished_at END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = ?
    `).run(status, nullableString(error, 20_000, "평가 오류"), terminal ? 1 : 0, evaluationId, current.status);
    if (result.changes !== 1) throw new Error("다른 작업이 평가 상태를 먼저 변경했습니다.");
    return this.getEvaluation(evaluationId)!;
  }

  // evaluator 한 번의 CLI 호출을 결정적 키로 생성하거나 기존 행을 반환한다.
  createEvaluationCall(input: {
    evaluationId: string;
    idempotencyKey: string;
    evaluatorLabel: string;
    evaluatorProvider: "codex" | "claude";
    evaluatorModel?: string | null;
    evaluatorFamily?: string | null;
    evaluatorAccountId?: number | null;
  }): ExperimentEvaluationCallRecord {
    const evaluation = this.getEvaluation(input.evaluationId);
    if (!evaluation || evaluation.status !== "queued") throw new Error("queued 평가에만 evaluator 호출을 만들 수 있습니다.");
    const key = requiredString(input.idempotencyKey, 1_000, "평가 호출 멱등 키");
    const existing = this.database.prepare(`
      SELECT * FROM experiment_evaluation_calls WHERE evaluation_id = ? AND idempotency_key = ?
    `).get(evaluation.id, key) as EvaluationCallRow | undefined;
    if (existing) return evaluationCallRecord(existing);
    const id = crypto.randomUUID();
    this.database.prepare(`
      INSERT INTO experiment_evaluation_calls(
        id, evaluation_id, idempotency_key, evaluator_label, evaluator_provider,
        evaluator_model, evaluator_family, evaluator_account_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, evaluation.id, key, requiredString(input.evaluatorLabel, 500, "evaluator label"), input.evaluatorProvider,
      nullableString(input.evaluatorModel, 500, "evaluator 모델"),
      nullableString(input.evaluatorFamily, 500, "evaluator family"), input.evaluatorAccountId ?? null,
    );
    return this.getEvaluationCall(id)!;
  }

  // evaluator 호출 한 건을 ID로 조회한다.
  getEvaluationCall(id: string): ExperimentEvaluationCallRecord | null {
    const row = this.database.prepare("SELECT * FROM experiment_evaluation_calls WHERE id = ?").get(id) as EvaluationCallRow | undefined;
    return row ? evaluationCallRecord(row) : null;
  }

  // 평가 라운드에 속한 evaluator 호출을 생성 순서로 반환한다.
  listEvaluationCalls(evaluationId: string): ExperimentEvaluationCallRecord[] {
    return (this.database.prepare(`
      SELECT * FROM experiment_evaluation_calls WHERE evaluation_id = ? ORDER BY created_at, id
    `).all(evaluationId) as EvaluationCallRow[]).map(evaluationCallRecord);
  }

  // evaluator 호출의 상태와 최종 usage·오류를 원자적으로 확정한다.
  transitionEvaluationCall(input: {
    callId: string;
    status: ExperimentEvaluationCallStatus;
    evaluatorModel?: string | null;
    evaluatorCliVersion?: string | null;
    usage?: Partial<Pick<ExperimentEvaluationCallRecord, "inputTokens" | "cachedInputTokens" | "cacheCreationInputTokens" | "cacheReadInputTokens" | "outputTokens" | "reasoningOutputTokens" | "totalTokens" | "totalTokensSource" | "costUsd">>;
    durationMs?: number | null;
    error?: string | null;
  }): ExperimentEvaluationCallRecord {
    const current = this.getEvaluationCall(input.callId);
    if (!current) throw new Error("평가 호출을 찾을 수 없습니다.");
    const transitions: Record<ExperimentEvaluationCallStatus, Set<ExperimentEvaluationCallStatus>> = {
      queued: new Set(["running", "cancelled"]),
      running: new Set(["completed", "failed", "cancelled"]),
      completed: new Set(), failed: new Set(), cancelled: new Set(),
    };
    if (current.status === input.status) return current;
    if (!transitions[current.status].has(input.status)) throw new Error(`평가 호출을 ${current.status}에서 ${input.status}(으)로 바꿀 수 없습니다.`);
    const usage = input.usage ?? {};
    const totalTokensSource = usage.totalTokensSource ?? current.totalTokensSource;
    if (totalTokensSource !== null && totalTokensSource !== "reported" && totalTokensSource !== "derived") throw new Error("평가 호출 전체 토큰 출처가 올바르지 않습니다.");
    const terminal = input.status !== "running";
    const result = this.database.prepare(`
      UPDATE experiment_evaluation_calls SET status = ?, evaluator_model = COALESCE(?, evaluator_model),
        evaluator_cli_version = COALESCE(?, evaluator_cli_version),
        input_tokens = ?, cached_input_tokens = ?, cache_creation_input_tokens = ?, cache_read_input_tokens = ?,
        output_tokens = ?, reasoning_output_tokens = ?, total_tokens = ?, total_tokens_source = ?, cost_usd = ?,
        duration_ms = ?, error = ?, finished_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE finished_at END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = ?
    `).run(
      input.status, nullableString(input.evaluatorModel, 500, "evaluator 모델"),
      nullableString(input.evaluatorCliVersion, 500, "evaluator CLI 버전"),
      nullableUsageNumber(usage.inputTokens, "평가 호출 입력 토큰") ?? current.inputTokens,
      nullableUsageNumber(usage.cachedInputTokens, "평가 호출 캐시 입력 토큰") ?? current.cachedInputTokens,
      nullableUsageNumber(usage.cacheCreationInputTokens, "평가 호출 캐시 생성 토큰") ?? current.cacheCreationInputTokens,
      nullableUsageNumber(usage.cacheReadInputTokens, "평가 호출 캐시 읽기 토큰") ?? current.cacheReadInputTokens,
      nullableUsageNumber(usage.outputTokens, "평가 호출 출력 토큰") ?? current.outputTokens,
      nullableUsageNumber(usage.reasoningOutputTokens, "평가 호출 추론 토큰") ?? current.reasoningOutputTokens,
      nullableUsageNumber(usage.totalTokens, "평가 호출 전체 토큰") ?? current.totalTokens,
      totalTokensSource, nullableUsageCost(usage.costUsd) ?? current.costUsd,
      input.durationMs == null ? current.durationMs : nullableUsageNumber(input.durationMs, "평가 호출 시간"),
      nullableString(input.error, 20_000, "평가 호출 오류"), terminal ? 1 : 0, current.id, current.status,
    );
    if (result.changes !== 1) throw new Error("다른 작업이 평가 호출 상태를 먼저 변경했습니다.");
    return this.getEvaluationCall(current.id)!;
  }

  // evaluator 한 명의 구조화 판단과 피험/평가 provenance·usage를 중복 없이 저장한다.
  createJudgment(input: {
    evaluationId: string;
    callId?: string | null;
    idempotencyKey?: string | null;
    runId: string;
    evaluatorLabel: string;
    evaluatorKind?: ExperimentJudgmentRecord["evaluatorKind"];
    evaluatorProvider?: "codex" | "claude" | null;
    evaluatorModel?: string | null;
    evaluatorFamily?: string | null;
    subjectProvider?: "codex" | "claude" | null;
    subjectModel?: string | null;
    subjectFamily?: string | null;
    blindLabel?: string | null;
    presentationOrder?: number | null;
    score?: number | null;
    confidence?: number | null;
    rank?: number | null;
    result: Record<string, unknown>;
    usage?: Partial<Pick<ExperimentJudgmentRecord, "inputTokens" | "cachedInputTokens" | "cacheCreationInputTokens" | "cacheReadInputTokens" | "outputTokens" | "reasoningOutputTokens" | "totalTokens" | "totalTokensSource" | "costUsd">>;
    durationMs?: number | null;
  }): ExperimentJudgmentRecord {
    const evaluation = this.getEvaluation(input.evaluationId);
    if (!evaluation) throw new Error("평가 라운드를 찾을 수 없습니다.");
    if (evaluation.status !== "running") throw new Error("실행 중인 평가에만 judgment를 저장할 수 있습니다.");
    const subject = evaluation.subjects.find((entry) => entry.runId === input.runId);
    if (!subject) throw new Error("judgment 대상 run이 평가 라운드에 속하지 않습니다.");
    const label = requiredString(input.evaluatorLabel, 500, "evaluator label");
    const idempotencyKey = nullableString(input.idempotencyKey, 1_000, "judgment 멱등 키");
    if (idempotencyKey) {
      const existing = this.database.prepare(`
        SELECT * FROM experiment_judgments WHERE evaluation_id = ? AND idempotency_key = ?
      `).get(evaluation.id, idempotencyKey) as JudgmentRow | undefined;
      if (existing) return judgmentRecord(existing);
    }
    const call = input.callId ? this.getEvaluationCall(input.callId) : null;
    if (input.callId && (!call || call.evaluationId !== evaluation.id)) throw new Error("judgment 호출이 평가 라운드에 속하지 않습니다.");
    const duplicate = this.database.prepare(`
      SELECT id FROM experiment_judgments WHERE evaluation_id = ? AND run_id = ? AND evaluator_label = ?
    `).get(evaluation.id, input.runId, label);
    if (duplicate) throw new Error("같은 evaluator의 judgment가 이미 저장됐습니다.");
    const kind = input.evaluatorKind ?? "agent";
    if (!["agent", "human", "deterministic"].includes(kind)) throw new Error("evaluator 종류가 올바르지 않습니다.");
    const resultJson = JSON.stringify(input.result);
    if (Buffer.byteLength(resultJson, "utf8") > MAX_INLINE_EVENT_BYTES) throw new Error("심사 결과는 256KiB를 초과할 수 없습니다.");
    const score = nullableRangeNumber(input.score, 0, 1, "심사 점수");
    const confidence = nullableRangeNumber(input.confidence, 0, 1, "심사 신뢰도");
    const rank = input.rank == null ? null : nullableUsageNumber(input.rank, "심사 순위");
    if (rank === 0) throw new Error("심사 순위는 1 이상이어야 합니다.");
    const durationMs = input.durationMs == null ? null : nullableUsageNumber(input.durationMs, "심사 시간");
    const usage = input.usage ?? {};
    const totalTokensSource = usage.totalTokensSource ?? null;
    if (totalTokensSource !== null && totalTokensSource !== "reported" && totalTokensSource !== "derived") throw new Error("심사 전체 토큰 출처가 올바르지 않습니다.");
    const evaluatorFamily = nullableString(input.evaluatorFamily, 500, "evaluator family");
    const subjectFamily = nullableString(input.subjectFamily, 500, "피험 family");
    const id = crypto.randomUUID();
    this.database.prepare(`
      INSERT INTO experiment_judgments(
        id, evaluation_id, call_id, idempotency_key, run_id, evaluator_label, evaluator_kind,
        evaluator_provider, evaluator_model, evaluator_family,
        subject_provider, subject_model, subject_family, same_family,
        blind_label, presentation_order, score, confidence, rank, result_json,
        input_tokens, cached_input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
        output_tokens, reasoning_output_tokens, total_tokens, total_tokens_source, cost_usd, duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, evaluation.id, call?.id ?? null, idempotencyKey, input.runId, label, kind,
      input.evaluatorProvider ?? null, nullableString(input.evaluatorModel, 500, "evaluator 모델"), evaluatorFamily,
      input.subjectProvider ?? null, nullableString(input.subjectModel, 500, "피험 모델"), subjectFamily,
      evaluatorFamily !== null && subjectFamily !== null && evaluatorFamily === subjectFamily ? 1 : 0,
      input.blindLabel ?? subject.blindLabel, input.presentationOrder ?? subject.presentationOrder,
      score, confidence, rank, resultJson,
      nullableUsageNumber(usage.inputTokens, "심사 입력 토큰") ?? 0,
      nullableUsageNumber(usage.cachedInputTokens, "심사 캐시 입력 토큰") ?? 0,
      nullableUsageNumber(usage.cacheCreationInputTokens, "심사 캐시 생성 토큰") ?? 0,
      nullableUsageNumber(usage.cacheReadInputTokens, "심사 캐시 읽기 토큰") ?? 0,
      nullableUsageNumber(usage.outputTokens, "심사 출력 토큰") ?? 0,
      nullableUsageNumber(usage.reasoningOutputTokens, "심사 추론 토큰") ?? 0,
      nullableUsageNumber(usage.totalTokens, "심사 전체 토큰") ?? 0,
      totalTokensSource, nullableUsageCost(usage.costUsd), durationMs,
    );
    const stored = this.database.prepare("SELECT * FROM experiment_judgments WHERE id = ?").get(id) as JudgmentRow | undefined;
    if (!stored) throw new Error("심사 결과를 저장하지 못했습니다.");
    return judgmentRecord(stored);
  }

  // node 상태를 허용된 단방향으로 바꾸고 출력·오류와 시각을 함께 고정한다.
  transitionNode(input: {
    nodeId: string;
    status: ExperimentNodeRecord["status"];
    output?: Record<string, unknown> | null;
    error?: string | null;
  }): ExperimentNodeRecord {
    const current = this.getNode(input.nodeId);
    if (!current) throw new Error("실험 노드를 찾을 수 없습니다.");
    const transitions: Record<ExperimentNodeRecord["status"], Set<ExperimentNodeRecord["status"]>> = {
      queued: new Set(["running", "cancelled"]), running: new Set(["completed", "failed", "cancelled"]),
      completed: new Set(), failed: new Set(), cancelled: new Set(),
    };
    if (current.status === input.status) return current;
    if (!transitions[current.status].has(input.status)) throw new Error(`실험 노드 상태를 ${current.status}에서 ${input.status}(으)로 바꿀 수 없습니다.`);
    const terminal = ["completed", "failed", "cancelled"].includes(input.status);
    const outputJson = input.output == null ? null : JSON.stringify(input.output);
    if (outputJson && Buffer.byteLength(outputJson, "utf8") > MAX_INLINE_EVENT_BYTES) throw new Error("노드 출력은 256KiB를 초과할 수 없습니다.");
    this.database.prepare(`
      UPDATE experiment_nodes SET
        status = ?, output_json = CASE WHEN ? THEN ? ELSE output_json END,
        error = CASE WHEN ? THEN ? ELSE error END,
        started_at = CASE WHEN ? AND started_at IS NULL THEN CURRENT_TIMESTAMP ELSE started_at END,
        finished_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE finished_at END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      input.status, terminal ? 1 : 0, outputJson, terminal ? 1 : 0, nullableString(input.error, 20_000, "노드 오류"),
      input.status === "running" ? 1 : 0, terminal ? 1 : 0, input.nodeId,
    );
    return this.getNode(input.nodeId)!;
  }

  // node의 누적 usage를 run과 같은 단조·provenance 규칙으로 기록한다.
  recordNodeUsage(nodeId: string, usage: {
    inputTokens?: number | null;
    cachedInputTokens?: number | null;
    cacheCreationInputTokens?: number | null;
    cacheReadInputTokens?: number | null;
    outputTokens?: number | null;
    reasoningOutputTokens?: number | null;
    totalTokens?: number | null;
    totalTokensSource?: "reported" | "derived" | null;
    costUsd?: number | null;
  }): ExperimentNodeRecord {
    const current = this.getNode(nodeId);
    if (!current) throw new Error("실험 노드를 찾을 수 없습니다.");
    if (current.status !== "running") throw new Error("토큰 사용량은 실행 중인 노드에만 기록할 수 있습니다.");
    const values = [
      nullableUsageNumber(usage.inputTokens, "입력 토큰"), nullableUsageNumber(usage.cachedInputTokens, "캐시 입력 토큰"),
      nullableUsageNumber(usage.cacheCreationInputTokens, "캐시 생성 입력 토큰"), nullableUsageNumber(usage.cacheReadInputTokens, "캐시 읽기 입력 토큰"),
      nullableUsageNumber(usage.outputTokens, "출력 토큰"), nullableUsageNumber(usage.reasoningOutputTokens, "추론 출력 토큰"),
      nullableUsageNumber(usage.totalTokens, "전체 토큰"),
    ];
    const source = usage.totalTokensSource ?? null;
    const costUsd = nullableUsageCost(usage.costUsd);
    if (source !== null && source !== "reported" && source !== "derived") throw new Error("전체 토큰 출처가 올바르지 않습니다.");
    this.database.prepare(`
      UPDATE experiment_nodes SET
        input_tokens = CASE WHEN ? IS NULL THEN input_tokens ELSE MAX(input_tokens, ?) END,
        cached_input_tokens = CASE WHEN ? IS NULL THEN cached_input_tokens ELSE MAX(cached_input_tokens, ?) END,
        cache_creation_input_tokens = CASE WHEN ? IS NULL THEN cache_creation_input_tokens ELSE MAX(cache_creation_input_tokens, ?) END,
        cache_read_input_tokens = CASE WHEN ? IS NULL THEN cache_read_input_tokens ELSE MAX(cache_read_input_tokens, ?) END,
        output_tokens = CASE WHEN ? IS NULL THEN output_tokens ELSE MAX(output_tokens, ?) END,
        reasoning_output_tokens = CASE WHEN ? IS NULL THEN reasoning_output_tokens ELSE MAX(reasoning_output_tokens, ?) END,
        total_tokens = CASE WHEN ? IS NULL THEN total_tokens ELSE MAX(total_tokens, ?) END,
        total_tokens_source = CASE WHEN ? = 'reported' THEN 'reported' WHEN total_tokens_source IS NULL THEN ? ELSE total_tokens_source END,
        cost_usd = CASE WHEN ? IS NULL THEN cost_usd WHEN cost_usd IS NULL THEN ? ELSE MAX(cost_usd, ?) END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(...values.flatMap((value) => [value, value]), source, source, costUsd, costUsd, costUsd, nodeId);
    return this.getNode(nodeId)!;
  }

  // 준비 단계의 환경 provenance를 기존 키와 충돌하지 않게 불변 스냅샷에 합친다.
  mergeRunEnvironmentSnapshot(runId: string, snapshot: Record<string, unknown>): ExperimentRunRecord {
    const current = this.getRun(runId);
    if (!current) throw new Error("실험 실행을 찾을 수 없습니다.");
    if (current.status !== "preparing") throw new Error("실행 환경 스냅샷은 준비 단계에서만 고정할 수 있습니다.");
    const merged = { ...current.environmentSnapshot };
    for (const [key, value] of Object.entries(snapshot)) {
      if (Object.prototype.hasOwnProperty.call(merged, key) && JSON.stringify(merged[key]) !== JSON.stringify(value)) {
        throw new Error(`실행 환경 스냅샷 키를 덮어쓸 수 없습니다: ${key}`);
      }
      merged[key] = value;
    }
    this.database.prepare("UPDATE experiment_runs SET environment_snapshot_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(JSON.stringify(merged), runId);
    return this.getRun(runId)!;
  }

  // fixture가 선언한 검증 명령의 결과를 run에 고정한다. 완성도 비교에서 rubric보다 먼저 보는 값이다.
  recordDeterministicCheck(runId: string, result: {
    status: DeterministicCheckStatus;
    exitCode: number | null;
    durationMs: number;
    output: string;
  }): ExperimentRunRecord {
    if (!this.getRun(runId)) throw new Error("실험 실행을 찾을 수 없습니다.");
    this.database.prepare(`
      UPDATE experiment_runs
      SET check_status = ?, check_exit_code = ?, check_duration_ms = ?, check_output = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(result.status, result.exitCode, Math.max(0, Math.round(result.durationMs)), nullableString(result.output, 20_000, "검증 출력"), runId);
    return this.getRun(runId)!;
  }

  // 한도 대기 한 구간이 끝날 때마다 누적 대기 시간과 횟수를 더한다. 비교 지표의 실작업 시간은
  // 벽시계에서 이 값을 뺀 것이라, 대기가 시간 순위를 뒤집지 않게 한다.
  recordWait(runId: string, waitedSeconds: number): ExperimentRunRecord {
    if (!Number.isFinite(waitedSeconds) || waitedSeconds < 0) throw new Error("대기 시간은 0 이상의 숫자여야 합니다.");
    const current = this.getRun(runId);
    if (!current) throw new Error("실험 실행을 찾을 수 없습니다.");
    this.database.prepare(`
      UPDATE experiment_runs
      SET waited_seconds = waited_seconds + ?, wait_count = wait_count + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(waitedSeconds, runId);
    return this.getRun(runId)!;
  }

  // 공급자 thread/session ID를 최초 한 번만 고정하고 같은 값의 재기록은 허용한다.
  recordProviderRunId(runId: string, providerRunId: string): ExperimentRunRecord {
    const id = requiredString(providerRunId, 500, "공급자 실행 ID");
    const current = this.getRun(runId);
    if (!current) throw new Error("실험 실행을 찾을 수 없습니다.");
    if (current.status !== "running" && current.status !== "evaluating") {
      throw new Error("공급자 실행 ID는 실행 중에만 기록할 수 있습니다.");
    }
    if (current.providerRunId && current.providerRunId !== id) throw new Error("공급자 실행 ID를 다른 값으로 바꿀 수 없습니다.");
    if (!current.providerRunId) {
      this.database.prepare("UPDATE experiment_runs SET provider_run_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(id, runId);
    }
    return this.getRun(runId)!;
  }

  // 공급자가 보고한 누적 토큰 관측값을 미보고 null은 유지하고 각 항목의 최댓값으로 저장한다.
  recordRunUsage(runId: string, usage: {
    inputTokens?: number | null;
    cachedInputTokens?: number | null;
    cacheCreationInputTokens?: number | null;
    cacheReadInputTokens?: number | null;
    outputTokens?: number | null;
    reasoningOutputTokens?: number | null;
    totalTokens?: number | null;
    totalTokensSource?: "reported" | "derived" | null;
    costUsd?: number | null;
  }): ExperimentRunRecord {
    const current = this.getRun(runId);
    if (!current) throw new Error("실험 실행을 찾을 수 없습니다.");
    if (current.status !== "running" && current.status !== "evaluating") {
      throw new Error("토큰 사용량은 실행 또는 평가 중에만 기록할 수 있습니다.");
    }
    const values = [
      nullableUsageNumber(usage.inputTokens, "입력 토큰"),
      nullableUsageNumber(usage.cachedInputTokens, "캐시 입력 토큰"),
      nullableUsageNumber(usage.cacheCreationInputTokens, "캐시 생성 입력 토큰"),
      nullableUsageNumber(usage.cacheReadInputTokens, "캐시 읽기 입력 토큰"),
      nullableUsageNumber(usage.outputTokens, "출력 토큰"),
      nullableUsageNumber(usage.reasoningOutputTokens, "추론 출력 토큰"),
      nullableUsageNumber(usage.totalTokens, "전체 토큰"),
    ];
    const totalTokensSource = usage.totalTokensSource ?? null;
    const costUsd = nullableUsageCost(usage.costUsd);
    if (totalTokensSource !== null && totalTokensSource !== "reported" && totalTokensSource !== "derived") {
      throw new Error("전체 토큰 출처가 올바르지 않습니다.");
    }
    this.database.prepare(`
      UPDATE experiment_runs SET
        input_tokens = CASE WHEN ? IS NULL THEN input_tokens ELSE MAX(input_tokens, ?) END,
        cached_input_tokens = CASE WHEN ? IS NULL THEN cached_input_tokens ELSE MAX(cached_input_tokens, ?) END,
        cache_creation_input_tokens = CASE WHEN ? IS NULL THEN cache_creation_input_tokens ELSE MAX(cache_creation_input_tokens, ?) END,
        cache_read_input_tokens = CASE WHEN ? IS NULL THEN cache_read_input_tokens ELSE MAX(cache_read_input_tokens, ?) END,
        output_tokens = CASE WHEN ? IS NULL THEN output_tokens ELSE MAX(output_tokens, ?) END,
        reasoning_output_tokens = CASE WHEN ? IS NULL THEN reasoning_output_tokens ELSE MAX(reasoning_output_tokens, ?) END,
        total_tokens = CASE WHEN ? IS NULL THEN total_tokens ELSE MAX(total_tokens, ?) END,
        total_tokens_source = CASE
          WHEN ? = 'reported' THEN 'reported'
          WHEN total_tokens_source IS NULL THEN ?
          ELSE total_tokens_source
        END,
        cost_usd = CASE WHEN ? IS NULL THEN cost_usd WHEN cost_usd IS NULL THEN ? ELSE MAX(cost_usd, ?) END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(...values.flatMap((value) => [value, value]), totalTokensSource, totalTokensSource, costUsd, costUsd, costUsd, runId);
    return this.getRun(runId)!;
  }

  // 독립 Runtime을 여러 번 호출하는 그래프 run의 usage를 node 합계에서 다시 투영한다.
  refreshRunUsageFromNodes(runId: string): ExperimentRunRecord {
    const run = this.getRun(runId);
    if (!run || run.status !== "running") throw new Error("실행 중인 그래프 run만 node usage를 합산할 수 있습니다.");
    const nodes = this.listNodes(runId);
    const sum = (select: (node: ExperimentNodeRecord) => number) => nodes.reduce((total, node) => total + select(node), 0);
    const sources = nodes.map((node) => node.totalTokensSource).filter((value) => value !== null);
    const totalTokensSource = sources.length === 0 ? null : sources.every((value) => value === "reported") ? "reported" : "derived";
    const costUsd = nodes.length > 0 && nodes.every((node) => node.costUsd !== null)
      ? nodes.reduce((total, node) => total + (node.costUsd ?? 0), 0)
      : null;
    this.database.prepare(`
      UPDATE experiment_runs SET input_tokens = ?, cached_input_tokens = ?,
        cache_creation_input_tokens = ?, cache_read_input_tokens = ?, output_tokens = ?,
        reasoning_output_tokens = ?, total_tokens = ?, total_tokens_source = ?, cost_usd = ?,
        updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'
    `).run(
      sum((node) => node.inputTokens), sum((node) => node.cachedInputTokens),
      sum((node) => node.cacheCreationInputTokens), sum((node) => node.cacheReadInputTokens),
      sum((node) => node.outputTokens), sum((node) => node.reasoningOutputTokens),
      sum((node) => node.totalTokens), totalTokensSource, costUsd, runId,
    );
    return this.getRun(runId)!;
  }

  // 허용된 방향으로만 실행 상태를 전이하고 시작·종료 시각을 함께 기록한다.
  transitionRun(input: {
    runId: string;
    status: ExperimentRunStatus;
    terminationReason?: ExperimentTerminationReason | null;
    error?: string | null;
  }): ExperimentRunRecord {
    const current = this.getRun(input.runId);
    if (!current) throw new Error("실험 실행을 찾을 수 없습니다.");
    if (current.status === input.status) return current;
    if (!RUN_TRANSITIONS[current.status].has(input.status)) {
      throw new Error(`실험 실행 상태를 ${current.status}에서 ${input.status}(으)로 바꿀 수 없습니다.`);
    }
    const terminal = TERMINAL_STATUSES.has(input.status);
    const defaultReason: ExperimentTerminationReason | null = input.status === "completed"
      ? "success"
      : input.status === "cancelled"
        ? "cancelled"
        : input.status === "failed"
          ? "runtime_error"
          : null;
    if (input.status === "budget_exceeded" && !input.terminationReason) throw new Error("예산 초과 종료 이유가 필요합니다.");
    const result = this.database.prepare(`
      UPDATE experiment_runs SET
        status = ?,
        termination_reason = CASE WHEN ? THEN ? ELSE termination_reason END,
        error = CASE WHEN ? THEN ? ELSE error END,
        started_at = CASE WHEN ? AND started_at IS NULL THEN CURRENT_TIMESTAMP ELSE started_at END,
        finished_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE finished_at END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = ?
    `).run(
      input.status, terminal ? 1 : 0, input.terminationReason ?? defaultReason,
      terminal ? 1 : 0, nullableString(input.error, 20_000, "실행 오류"),
      input.status === "preparing" || input.status === "running" ? 1 : 0,
      terminal ? 1 : 0, input.runId, current.status,
    );
    if (result.changes !== 1) throw new Error("다른 작업이 실험 실행 상태를 먼저 변경했습니다.");
    return this.getRun(input.runId)!;
  }

  // 같은 멱등 키는 기존 이벤트를 반환하고 새 키만 다음 순번으로 append한다.
  appendEvent(input: {
    runId: string;
    idempotencyKey: string;
    type: string;
    payload?: Record<string, unknown>;
  }): { event: ExperimentEventRecord; inserted: boolean } {
    const key = requiredString(input.idempotencyKey, 500, "이벤트 멱등 키");
    const type = requiredString(input.type, 200, "이벤트 종류");
    const payloadJson = JSON.stringify(input.payload ?? {});
    if (Buffer.byteLength(payloadJson, "utf8") > MAX_INLINE_EVENT_BYTES) {
      throw new Error("실험 이벤트 본문은 256KiB를 초과할 수 없습니다. 큰 결과는 산출물로 저장해주세요.");
    }
    return this.database.transaction(() => {
      const existing = this.database.prepare("SELECT * FROM experiment_events WHERE run_id = ? AND idempotency_key = ?")
        .get(input.runId, key) as EventRow | undefined;
      if (existing) return { event: eventRecord(existing), inserted: false };
      if (!this.getRun(input.runId)) throw new Error("실험 실행을 찾을 수 없습니다.");
      const latest = this.database.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM experiment_events WHERE run_id = ?")
        .get(input.runId) as { sequence: number };
      const id = crypto.randomUUID();
      this.database.prepare(`
        INSERT INTO experiment_events(id, run_id, sequence, idempotency_key, type, payload_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, input.runId, latest.sequence + 1, key, type, payloadJson);
      const row = this.database.prepare("SELECT * FROM experiment_events WHERE id = ?").get(id) as EventRow;
      return { event: eventRecord(row), inserted: true };
    })();
  }

  // 실행 이벤트를 순번 오름차순으로 읽어 상태를 재투영할 수 있게 한다.
  listEvents(runId: string, afterSequence = 0, limit = 500): ExperimentEventRecord[] {
    const safeLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
    const safeSequence = Math.max(0, Math.trunc(afterSequence));
    const rows = this.database.prepare(`
      SELECT * FROM experiment_events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?
    `).all(runId, safeSequence, safeLimit) as EventRow[];
    return rows.map(eventRecord);
  }

  // 공급자 원본·도구 로그를 제외하고 마지막 assistant 텍스트만 평가 패킷용으로 읽는다.
  latestAssistantMessage(runId: string): string | null {
    const rows = this.database.prepare(`
      SELECT * FROM experiment_events
      WHERE run_id = ? AND type = 'runtime.message'
      ORDER BY sequence DESC LIMIT 100
    `).all(runId) as EventRow[];
    for (const row of rows) {
      const payload = eventRecord(row).payload;
      if (payload.role === "assistant" && typeof payload.text === "string" && payload.text.trim()) return payload.text;
    }
    return null;
  }

  // 완료된 이벤트 경계의 최신 그래프 상태를 저장하며 이전 순번으로의 회귀는 무시한다.
  saveCheckpoint(input: {
    runId: string;
    nodeId?: string | null;
    eventSequence: number;
    state: Record<string, unknown>;
    artifacts?: string[];
  }): ExperimentCheckpointRecord {
    if (!Number.isInteger(input.eventSequence) || input.eventSequence < 0) throw new Error("체크포인트 이벤트 순번이 올바르지 않습니다.");
    if (!this.getRun(input.runId)) throw new Error("실험 실행을 찾을 수 없습니다.");
    if (input.nodeId) {
      const node = this.database.prepare("SELECT run_id FROM experiment_nodes WHERE id = ?").get(input.nodeId) as { run_id: string } | undefined;
      if (!node || node.run_id !== input.runId) throw new Error("체크포인트 노드가 이 실행에 속하지 않습니다.");
    }
    const latestEvent = this.database.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM experiment_events WHERE run_id = ?")
      .get(input.runId) as { sequence: number };
    if (input.eventSequence > latestEvent.sequence) throw new Error("존재하지 않는 미래 이벤트에는 체크포인트를 저장할 수 없습니다.");
    const artifacts = [...new Set(input.artifacts ?? [])];
    if (!artifacts.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 500)) {
      throw new Error("체크포인트 산출물 ID가 올바르지 않습니다.");
    }
    this.database.prepare(`
      INSERT INTO experiment_checkpoints(run_id, node_id, event_sequence, state_json, artifacts_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        node_id = excluded.node_id,
        event_sequence = excluded.event_sequence,
        state_json = excluded.state_json,
        artifacts_json = excluded.artifacts_json,
        updated_at = CURRENT_TIMESTAMP
      WHERE excluded.event_sequence >= experiment_checkpoints.event_sequence
    `).run(input.runId, input.nodeId ?? null, input.eventSequence, JSON.stringify(input.state), JSON.stringify(artifacts));
    return this.getCheckpoint(input.runId)!;
  }

  // 실행의 가장 최근 확정 체크포인트를 읽는다.
  getCheckpoint(runId: string): ExperimentCheckpointRecord | null {
    const row = this.database.prepare("SELECT * FROM experiment_checkpoints WHERE run_id = ?").get(runId) as CheckpointRow | undefined;
    return row ? checkpointRecord(row) : null;
  }
}
