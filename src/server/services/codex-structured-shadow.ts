import crypto from "node:crypto";
import type { AppDatabase } from "../core/database";
import { CodexAppServerClient, CodexAppServerRpcError, codexAppServerClientVersion } from "../providers/codex-app-server";
import type { AgentAccountService } from "./agent-accounts";

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const TURN_PAGE_LIMIT = 100;

type ThreadStatus = "active" | "idle" | "notLoaded" | "systemError" | "unknown";
type ShadowComparison = "match" | "mismatch" | "inconclusive" | "error";
type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";
type TurnEventType = Exclude<TurnStatus, "inProgress"> | "started";

interface ShadowChatRow {
  id: number;
  provider_session_id: string;
  account_id: number | null;
  status: string;
  busy: number;
}

interface ParsedTurn {
  id: string;
  status: TurnStatus;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
}

interface ParsedTurnPage {
  turns: ParsedTurn[];
  rawCount: number;
  issues: string[];
  invalidTurns: number;
}

export interface CodexShadowObservation {
  id: string;
  chatId: number;
  sessionId: string;
  accountId: number | null;
  structuredStatus: ThreadStatus | null;
  structuredBusy: boolean | null;
  tuiStatus: string;
  tuiBusy: boolean;
  comparison: ShadowComparison;
  latencyMs: number;
  errorCode: string | null;
  observedAt: string;
}

export type CodexThreadReader = (
  environment: Record<string, string>,
  threadId: string,
  timeoutMs: number,
) => Promise<unknown>;

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function threadPayload(result: unknown): Record<string, unknown> | null {
  const root = object(result);
  const threadResult = object(root?.threadResult);
  return object(threadResult?.thread) ?? object(root?.thread);
}

function parseThreadStatus(result: unknown): { status: ThreadStatus; busy: boolean | null } {
  const status = object(threadPayload(result)?.status);
  const type = status?.type;
  if (type === "active") return { status: "active", busy: true };
  if (type === "idle") return { status: "idle", busy: false };
  if (type === "notLoaded" || type === "systemError") return { status: type, busy: null };
  return { status: "unknown", busy: null };
}

function unixSeconds(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 253_402_300_799) return null;
  return new Date(value * 1_000).toISOString();
}

function turnRows(result: unknown): unknown[] {
  const root = object(result);
  const page = object(root?.turnsResult);
  if (Array.isArray(page?.data)) return page.data;
  if (Array.isArray(root?.turns)) return root.turns;
  const thread = threadPayload(result);
  return Array.isArray(thread?.turns) ? thread.turns : [];
}

function parseTurnPage(result: unknown): ParsedTurnPage {
  const raw = turnRows(result);
  const rows = raw.slice(0, TURN_PAGE_LIMIT);
  const turns: ParsedTurn[] = [];
  const issues = new Set<string>();
  let invalidTurns = Math.max(0, raw.length - rows.length);
  if (raw.length > TURN_PAGE_LIMIT) issues.add("turn_page_over_limit");
  const ids = new Set<string>();
  for (const value of rows) {
    const turn = object(value);
    const id = typeof turn?.id === "string" && turn.id.length > 0 && turn.id.length <= 200 && !/[\0\r\n]/.test(turn.id) ? turn.id : null;
    const status = turn?.status;
    const startedAt = unixSeconds(turn?.startedAt);
    const completedAt = turn?.completedAt === null || turn?.completedAt === undefined ? null : unixSeconds(turn.completedAt);
    const validStatus = status === "completed" || status === "interrupted" || status === "failed" || status === "inProgress";
    let issue: string | null = null;
    if (!id) issue = "turn_id_invalid";
    else if (ids.has(id)) issue = "duplicate_turn_id";
    else if (!validStatus) issue = "turn_status_invalid";
    else if (!startedAt) issue = "turn_started_at_missing";
    else if (status !== "inProgress" && !completedAt) issue = "turn_completed_at_missing";
    else if (status === "inProgress" && completedAt) issue = "in_progress_has_completed_at";
    else if (completedAt && Date.parse(completedAt) < Date.parse(startedAt)) issue = "turn_time_reversed";
    const durationValue = turn?.durationMs;
    if (!issue && durationValue !== null && durationValue !== undefined
      && (typeof durationValue !== "number" || !Number.isSafeInteger(durationValue) || durationValue < 0)) issue = "turn_duration_invalid";
    if (issue || !id || !validStatus || !startedAt) {
      invalidTurns += 1;
      issues.add(issue ?? "turn_metadata_invalid");
      continue;
    }
    ids.add(id);
    turns.push({ id, status, startedAt, completedAt,
      durationMs: typeof durationValue === "number" ? durationValue : completedAt ? Date.parse(completedAt) - Date.parse(startedAt) : null });
  }
  return { turns, rawCount: raw.length, issues: [...issues].sort(), invalidTurns };
}

async function defaultThreadReader(environment: Record<string, string>, threadId: string, timeoutMs: number): Promise<unknown> {
  let client: CodexAppServerClient | undefined;
  try {
    client = await CodexAppServerClient.connect({ environment, requestTimeoutMs: timeoutMs, clientVersion: codexAppServerClientVersion() });
    const threadResult = await client.request("thread/read", { threadId, includeTurns: false });
    const turnsResult = await client.request("thread/turns/list", codexTurnListParamsForTest(threadId));
    return { threadResult, turnsResult };
  } finally {
    client?.close();
  }
}

function errorCode(error: unknown): string {
  return error instanceof CodexAppServerRpcError
    ? `rpc_${error.code ?? "unknown"}`
    : error instanceof Error && error.name ? error.name : "unknown_error";
}

function p95(rows: Array<{ latency_ms: number }>): number | null {
  return rows.length ? rows[Math.ceil(rows.length * 0.95) - 1]!.latency_ms : null;
}

function utcDate(value: unknown): number {
  if (typeof value !== "string") return Number.NaN;
  return Date.parse(value.endsWith("Z") ? value : `${value.replace(" ", "T")}Z`);
}

// 기존 TUI 세션을 제어하지 않고 app-server의 metadata-only thread/turn history만 병행 기록한다.
// send/interrupt/approval 메서드를 노출하지 않으며 turn item/message/tool/error payload는 저장하지 않는다.
export class CodexStructuredShadowService {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly database: AppDatabase,
    private readonly accounts: AgentAccountService,
    private readonly enabled: boolean,
    private readonly reader: CodexThreadReader = defaultThreadReader,
    private readonly intervalMs = DEFAULT_INTERVAL_MS,
    private readonly timeoutMs = 5_000,
    private readonly interactiveCandidateEnabled = false,
    private readonly interactiveCandidateCohort?: string,
    private readonly interactiveCandidateMaxNewChats = 0,
  ) {}

  start(): void {
    if (!this.enabled || this.timer) return;
    void this.probeActiveChats();
    this.timer = setInterval(() => void this.probeActiveChats(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async probeChat(chatId: number): Promise<CodexShadowObservation> {
    if (!this.enabled) throw Object.assign(new Error("Codex app-server shadow가 비활성화되어 있습니다."), { statusCode: 409 });
    const chat = this.database.prepare(`
      SELECT id, provider_session_id, account_id, status, busy
      FROM chats WHERE id = ? AND provider = 'codex' AND provider_session_id IS NOT NULL
    `).get(chatId) as ShadowChatRow | undefined;
    if (!chat) throw Object.assign(new Error("구조화 shadow로 읽을 Codex 세션을 찾을 수 없습니다."), { statusCode: 404 });
    return this.observe(chat);
  }

  async probeActiveChats(): Promise<number> {
    if (!this.enabled || this.running) return 0;
    this.running = true;
    try {
      const chats = this.database.prepare(`
        SELECT id, provider_session_id, account_id, status, busy
        FROM chats
        WHERE provider = 'codex' AND provider_session_id IS NOT NULL
          AND status IN ('starting', 'running', 'resuming')
        ORDER BY updated_at DESC LIMIT 20
      `).all() as ShadowChatRow[];
      for (const chat of chats) await this.observe(chat);
      return chats.length;
    } finally {
      this.running = false;
    }
  }

  snapshot(): Record<string, unknown> {
    const summary = this.database.prepare(`
      SELECT comparison, COUNT(*) AS count FROM provider_shadow_observations
      WHERE provider = 'codex' AND observed_at >= datetime('now', '-7 days')
      GROUP BY comparison ORDER BY comparison
    `).all() as Array<{ comparison: ShadowComparison; count: number }>;
    const latest = this.database.prepare(`
      SELECT id, chat_id AS chatId, session_id AS sessionId, account_id AS accountId,
             structured_status AS structuredStatus, structured_busy AS structuredBusy,
             tui_status AS tuiStatus, tui_busy AS tuiBusy, comparison, latency_ms AS latencyMs,
             error_code AS errorCode, observed_at AS observedAt
      FROM provider_shadow_observations WHERE provider = 'codex'
      ORDER BY observed_at DESC, rowid DESC LIMIT 50
    `).all() as Array<Record<string, unknown>>;
    const aggregate = this.database.prepare(`
      SELECT COUNT(*) AS observations, COUNT(DISTINCT date(observed_at)) AS observed_days,
             COUNT(DISTINCT chat_id) AS observed_chats, MIN(observed_at) AS first_observed_at, MAX(observed_at) AS last_observed_at,
             SUM(CASE WHEN comparison='mismatch' THEN 1 ELSE 0 END) AS mismatches,
             SUM(CASE WHEN comparison='error' THEN 1 ELSE 0 END) AS errors,
             SUM(CASE WHEN comparison='inconclusive' THEN 1 ELSE 0 END) AS inconclusive,
             SUM(CASE WHEN structured_busy=1 THEN 1 ELSE 0 END) AS busy_samples,
             SUM(CASE WHEN structured_busy=0 THEN 1 ELSE 0 END) AS idle_samples
      FROM provider_shadow_observations WHERE provider='codex' AND observed_at >= datetime('now', '-7 days')
    `).get() as Record<string, number | string | null>;
    const eligibleChats = Number((this.database.prepare(`SELECT COUNT(*) AS count FROM chats
      WHERE provider='codex' AND provider_session_id IS NOT NULL
        AND status IN ('starting', 'running', 'resuming')`).get() as { count: number }).count);
    const latencyRows = this.database.prepare(`SELECT latency_ms FROM provider_shadow_observations
      WHERE provider='codex' AND observed_at >= datetime('now', '-7 days') ORDER BY latency_ms`).all() as Array<{ latency_ms: number }>;
    const p95LatencyMs = p95(latencyRows);
    const observedChats = Number(aggregate.observed_chats ?? 0);
    const coverageRatio = eligibleChats ? Math.min(1, observedChats / eligibleChats) : 0;
    const lastObservedAt = typeof aggregate.last_observed_at === "string" ? aggregate.last_observed_at : null;
    const fresh = Boolean(lastObservedAt && utcDate(lastObservedAt) >= Date.now() - 15 * 60_000);
    const threadReasons = [
      ...(!this.enabled ? ["shadow_disabled"] : []),
      ...(Number(aggregate.observed_days ?? 0) < 7 ? ["insufficient_days"] : []),
      ...(Number(aggregate.observations ?? 0) < 100 ? ["insufficient_observations"] : []),
      ...(eligibleChats < 1 ? ["no_eligible_chats"] : coverageRatio < 0.8 ? ["insufficient_chat_coverage"] : []),
      ...(Number(aggregate.busy_samples ?? 0) < 1 ? ["busy_state_not_observed"] : []),
      ...(Number(aggregate.idle_samples ?? 0) < 1 ? ["idle_state_not_observed"] : []),
      ...(Number(aggregate.mismatches ?? 0) > 0 ? ["mismatch_observed"] : []),
      ...(Number(aggregate.errors ?? 0) > 0 ? ["error_observed"] : []),
      ...(Number(aggregate.inconclusive ?? 0) > 0 ? ["inconclusive_observed"] : []),
      ...(!fresh ? ["observation_stale"] : []),
      ...(p95LatencyMs !== null && p95LatencyMs > this.timeoutMs ? ["latency_over_timeout"] : []),
    ];
    const threadStatus = {
      scope: "thread_status", status: threadReasons.length ? "not_ready" : "ready", reasons: threadReasons,
      requirements: { observedDays: 7, observations: 100, chatCoverageRatio: 0.8, freshnessMinutes: 15, mismatches: 0, errors: 0, inconclusive: 0 },
      metrics: { observations: Number(aggregate.observations ?? 0), observedDays: Number(aggregate.observed_days ?? 0), observedChats, eligibleChats, coverageRatio,
        busySamples: Number(aggregate.busy_samples ?? 0), idleSamples: Number(aggregate.idle_samples ?? 0), mismatches: Number(aggregate.mismatches ?? 0), errors: Number(aggregate.errors ?? 0),
        inconclusive: Number(aggregate.inconclusive ?? 0), firstObservedAt: aggregate.first_observed_at, lastObservedAt, p95LatencyMs },
    };

    const turnAggregate = this.database.prepare(`
      SELECT COUNT(*) AS scans, COUNT(DISTINCT date(observed_at)) AS observed_days,
             SUM(invalid_turns) AS invalid_turns, SUM(CASE WHEN error_code IS NOT NULL THEN 1 ELSE 0 END) AS errors,
             MIN(observed_at) AS first_observed_at, MAX(observed_at) AS last_observed_at
      FROM provider_shadow_turn_scans WHERE provider='codex' AND observed_at >= datetime('now', '-7 days')
    `).get() as Record<string, number | string | null>;
    const turnCounts = this.database.prepare(`
      SELECT COUNT(DISTINCT CASE WHEN event_type='started' THEN CAST(chat_id AS TEXT) || ':' || turn_id END) AS started_turns,
             COUNT(DISTINCT CASE WHEN event_type IN ('completed','failed','interrupted') THEN CAST(chat_id AS TEXT) || ':' || turn_id END) AS terminal_turns
      FROM provider_shadow_turn_events WHERE provider='codex' AND observed_at >= datetime('now', '-7 days')
    `).get() as { started_turns: number; terminal_turns: number };
    const pairedTurns = Number((this.database.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT chat_id, turn_id FROM provider_shadow_turn_events
      WHERE provider='codex' AND observed_at >= datetime('now', '-7 days')
      GROUP BY chat_id, turn_id
      HAVING SUM(CASE WHEN event_type='started' THEN 1 ELSE 0 END) > 0
         AND SUM(CASE WHEN event_type IN ('completed','failed','interrupted') THEN 1 ELSE 0 END) > 0
    )`).get() as { count: number }).count);
    const turnLatencyRows = this.database.prepare(`SELECT latency_ms FROM provider_shadow_turn_scans
      WHERE provider='codex' AND observed_at >= datetime('now', '-7 days') ORDER BY latency_ms`).all() as Array<{ latency_ms: number }>;
    const turnP95LatencyMs = p95(turnLatencyRows);
    const turnLastObservedAt = typeof turnAggregate.last_observed_at === "string" ? turnAggregate.last_observed_at : null;
    const missingPairs = Math.max(0, Number(turnCounts.terminal_turns ?? 0) - pairedTurns);
    const turnReasons = [
      ...(!this.enabled ? ["turn_shadow_disabled"] : []),
      ...(Number(turnAggregate.observed_days ?? 0) < 7 ? ["turn_insufficient_days"] : []),
      ...(Number(turnAggregate.scans ?? 0) < 100 ? ["turn_insufficient_scans"] : []),
      ...(Number(turnCounts.terminal_turns ?? 0) < 10 ? ["turn_insufficient_terminal_turns"] : []),
      ...(Number(turnAggregate.errors ?? 0) > 0 ? ["turn_scan_error_observed"] : []),
      ...(Number(turnAggregate.invalid_turns ?? 0) > 0 ? ["turn_metadata_invalid"] : []),
      ...(missingPairs > 0 ? ["turn_terminal_pair_missing"] : []),
      ...(!(turnLastObservedAt && utcDate(turnLastObservedAt) >= Date.now() - 15 * 60_000) ? ["turn_observation_stale"] : []),
      ...(turnP95LatencyMs !== null && turnP95LatencyMs > this.timeoutMs ? ["turn_latency_over_timeout"] : []),
    ];
    const turnHistory = {
      scope: "turn_history_metadata", status: turnReasons.length ? "not_ready" : "ready", reasons: turnReasons,
      requirements: { observedDays: 7, scans: 100, terminalTurns: 10, missingPairs: 0, invalidTurns: 0, errors: 0, freshnessMinutes: 15 },
      metrics: { scans: Number(turnAggregate.scans ?? 0), observedDays: Number(turnAggregate.observed_days ?? 0), startedTurns: Number(turnCounts.started_turns ?? 0),
        terminalTurns: Number(turnCounts.terminal_turns ?? 0), pairedTurns, missingPairs, invalidTurns: Number(turnAggregate.invalid_turns ?? 0), errors: Number(turnAggregate.errors ?? 0),
        firstObservedAt: turnAggregate.first_observed_at, lastObservedAt: turnLastObservedAt, p95LatencyMs: turnP95LatencyMs },
    };
    const candidateBlockers = [
      ...(threadReasons.length ? ["thread_status_shadow_not_ready"] : []),
      ...(turnReasons.length ? ["turn_history_shadow_not_ready"] : []),
      ...(!this.interactiveCandidateEnabled ? ["interactive_transport_candidate_flag_required"] : []),
      ...(this.interactiveCandidateEnabled && !this.interactiveCandidateCohort ? ["interactive_transport_cohort_required"] : []),
      ...(this.interactiveCandidateEnabled && this.interactiveCandidateMaxNewChats < 1 ? ["interactive_transport_quota_required"] : []),
    ];
    const latestTurnScans = this.database.prepare(`SELECT chat_id AS chatId, turns_seen AS turnsSeen, started_seen AS startedSeen,
      terminal_seen AS terminalSeen, paired_seen AS pairedSeen, invalid_turns AS invalidTurns, issues_json AS issuesJson,
      latency_ms AS latencyMs, error_code AS errorCode, observed_at AS observedAt
      FROM provider_shadow_turn_scans WHERE provider='codex' ORDER BY observed_at DESC, rowid DESC LIMIT 50`).all() as Array<Record<string, unknown>>;
    return {
      enabled: this.enabled,
      mode: this.enabled ? "read_only_shadow" : "off",
      windowDays: 7,
      summary: Object.fromEntries(summary.map((row) => [row.comparison, row.count])),
      readiness: {
        scope: "thread_status_and_turn_history",
        status: threadReasons.length || turnReasons.length ? "not_ready" : "ready",
        reasons: [...threadReasons, ...turnReasons],
        threadStatus,
        turnHistory,
        interactiveCandidateEnabled: this.interactiveCandidateEnabled,
        interactiveCandidateCohort: this.interactiveCandidateCohort ?? null,
        interactiveCandidateMaxNewChats: this.interactiveCandidateMaxNewChats,
        candidateEligible: candidateBlockers.length === 0,
        candidateBlockers,
        transitionEligible: candidateBlockers.length === 0,
        transitionBlockers: candidateBlockers,
      },
      latest: latest.map((row) => ({ ...row, structuredBusy: row.structuredBusy === null ? null : row.structuredBusy === 1, tuiBusy: row.tuiBusy === 1 })),
      latestTurnScans: latestTurnScans.map((row) => ({ ...row, issues: JSON.parse(String(row.issuesJson)), issuesJson: undefined })),
    };
  }

  private async observe(chat: ShadowChatRow): Promise<CodexShadowObservation> {
    const startedAt = Date.now();
    const observedAt = new Date().toISOString();
    let structuredStatus: ThreadStatus | null = null;
    let structuredBusy: boolean | null = null;
    let comparison: ShadowComparison = "error";
    let observationErrorCode: string | null = null;
    let page: ParsedTurnPage = { turns: [], rawCount: 0, issues: [], invalidTurns: 0 };
    let turnReadSucceeded = false;
    try {
      const account = this.accounts.resolveForChat("codex", chat.account_id);
      const result = await this.reader(this.accounts.environment(account), chat.provider_session_id, this.timeoutMs);
      const parsed = parseThreadStatus(result);
      structuredStatus = parsed.status;
      structuredBusy = parsed.busy;
      comparison = structuredBusy === null ? "inconclusive" : structuredBusy === Boolean(chat.busy) ? "match" : "mismatch";
      page = parseTurnPage(result);
      turnReadSucceeded = true;
    } catch (error) {
      observationErrorCode = errorCode(error);
    }
    const latencyMs = Math.max(0, Date.now() - startedAt);
    const observation: CodexShadowObservation = {
      id: crypto.randomUUID(), chatId: chat.id, sessionId: chat.provider_session_id, accountId: chat.account_id,
      structuredStatus, structuredBusy, tuiStatus: chat.status, tuiBusy: Boolean(chat.busy), comparison,
      latencyMs, errorCode: observationErrorCode, observedAt,
    };
    this.database.transaction(() => {
      if (turnReadSucceeded) this.persistTurnEvents(chat, page, observedAt);
      this.database.prepare(`INSERT INTO provider_shadow_observations(
        id, provider, chat_id, session_id, account_id, structured_status, structured_busy,
        tui_status, tui_busy, comparison, latency_ms, error_code, observed_at
      ) VALUES (?, 'codex', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        observation.id, observation.chatId, observation.sessionId, observation.accountId, observation.structuredStatus,
        observation.structuredBusy === null ? null : Number(observation.structuredBusy), observation.tuiStatus,
        Number(observation.tuiBusy), observation.comparison, observation.latencyMs, observation.errorCode, observation.observedAt,
      );
      const terminalSeen = page.turns.filter((turn) => turn.status !== "inProgress").length;
      const pairedSeen = page.turns.filter((turn) => turn.status !== "inProgress" && turn.completedAt).length;
      this.database.prepare(`INSERT INTO provider_shadow_turn_scans(
        id, provider, chat_id, session_id, turns_seen, started_seen, terminal_seen, paired_seen,
        invalid_turns, issues_json, latency_ms, error_code, observed_at
      ) VALUES (?, 'codex', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        crypto.randomUUID(), chat.id, chat.provider_session_id, page.rawCount, page.turns.length, terminalSeen, pairedSeen,
        page.invalidTurns, JSON.stringify(page.issues), latencyMs, observationErrorCode, observedAt,
      );
    })();
    return observation;
  }

  private persistTurnEvents(chat: ShadowChatRow, page: ParsedTurnPage, observedAt: string): void {
    if (!page.turns.length) return;
    const placeholders = page.turns.map(() => "?").join(",");
    const existingRows = this.database.prepare(`SELECT turn_id, event_type, source_at FROM provider_shadow_turn_events
      WHERE provider='codex' AND chat_id=? AND turn_id IN (${placeholders})`).all(chat.id, ...page.turns.map((turn) => turn.id)) as Array<{ turn_id: string; event_type: TurnEventType; source_at: string }>;
    const existing = new Map<string, Map<TurnEventType, string>>();
    for (const row of existingRows) {
      const events = existing.get(row.turn_id) ?? new Map<TurnEventType, string>();
      events.set(row.event_type, row.source_at); existing.set(row.turn_id, events);
    }
    const insert = this.database.prepare(`INSERT OR IGNORE INTO provider_shadow_turn_events(
      id, provider, chat_id, session_id, turn_id, event_type, source_at, duration_ms, observed_at
    ) VALUES (?, 'codex', ?, ?, ?, ?, ?, ?, ?)`);
    for (const turn of page.turns) {
      const prior = existing.get(turn.id);
      const priorTerminal = [...(prior?.keys() ?? [])].find((type) => type !== "started");
      if (prior?.get("started") && prior.get("started") !== turn.startedAt) {
        page.invalidTurns += 1; if (!page.issues.includes("turn_started_at_changed")) page.issues.push("turn_started_at_changed"); continue;
      }
      if (turn.status === "inProgress" && priorTerminal) {
        page.invalidTurns += 1; if (!page.issues.includes("turn_terminal_regression")) page.issues.push("turn_terminal_regression"); continue;
      }
      if (turn.status !== "inProgress" && priorTerminal && priorTerminal !== turn.status) {
        page.invalidTurns += 1; if (!page.issues.includes("turn_terminal_status_changed")) page.issues.push("turn_terminal_status_changed"); continue;
      }
      if (turn.status !== "inProgress" && prior?.get(turn.status) && prior.get(turn.status) !== turn.completedAt) {
        page.invalidTurns += 1; if (!page.issues.includes("turn_completed_at_changed")) page.issues.push("turn_completed_at_changed"); continue;
      }
      insert.run(crypto.randomUUID(), chat.id, chat.provider_session_id, turn.id, "started", turn.startedAt, null, observedAt);
      if (turn.status !== "inProgress" && turn.completedAt) {
        insert.run(crypto.randomUUID(), chat.id, chat.provider_session_id, turn.id, turn.status, turn.completedAt, turn.durationMs, observedAt);
      }
    }
    page.issues.sort();
  }
}

export const codexThreadStatusForTest = parseThreadStatus;
export const codexTurnPageForTest = parseTurnPage;
export const codexTurnListParamsForTest = (threadId: string): Record<string, unknown> => ({
  threadId, limit: TURN_PAGE_LIMIT, sortDirection: "desc", itemsView: "notLoaded",
});
