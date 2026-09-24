import type { UsageRecord, UsageWindow } from "../../shared/types";
import type { ModelChoice, ModelOptions } from "./provider";
import { CodexAppServerClient, codexAppServerClientVersion } from "./codex-app-server";
import { parseCodexResetCredits } from "./codex-rate-limits";
import { directSnapshot, normalizedPercent, normalizedResetAt, type UsageCollection, type UsageCollectorContext } from "./usage-collector";
import type { ModelOptionsCollectorContext } from "./model-options-collector";

const REQUEST_TIMEOUT_MS = 10_000;
const FIVE_HOUR_MINUTES = 300;
const WEEKLY_MINUTES = 10_080;

interface CodexRateWindow {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
}

interface CodexRateLimitPayload {
  rateLimits?: {
    primary?: CodexRateWindow | null;
    secondary?: CodexRateWindow | null;
    planType?: unknown;
  } | null;
  rateLimitResetCredits?: {
    availableCount?: unknown;
    credits?: unknown;
  } | null;
  planType?: unknown;
}

function durationKind(window: CodexRateWindow): "five_hour" | "weekly" | null {
  const duration = window.windowDurationMins;
  if (typeof duration !== "number" || !Number.isFinite(duration)) return null;
  if (Math.abs(duration - FIVE_HOUR_MINUTES) <= 1) return "five_hour";
  if (Math.abs(duration - WEEKLY_MINUTES) <= 1) return "weekly";
  return null;
}

function toWindow(id: "five_hour" | "weekly", value: CodexRateWindow | null | undefined): UsageWindow | null {
  const usedPercent = normalizedPercent(value?.usedPercent);
  if (usedPercent === null) return null;
  return {
    id,
    label: id === "five_hour" ? "5h limit" : "Weekly limit",
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetAt: normalizedResetAt(value?.resetsAt),
  };
}

export function parseCodexAppServerUsage(payload: CodexRateLimitPayload): Partial<UsageRecord> {
  const primary = payload.rateLimits?.primary ?? null;
  const secondary = payload.rateLimits?.secondary ?? null;
  let fiveHourSource: CodexRateWindow | null = null;
  let weeklySource: CodexRateWindow | null = null;
  for (const candidate of [primary, secondary]) {
    if (!candidate) continue;
    const kind = durationKind(candidate);
    if (kind === "five_hour" && !fiveHourSource) fiveHourSource = candidate;
    if (kind === "weekly" && !weeklySource) weeklySource = candidate;
  }
  // 구형 app-server가 duration을 생략하던 시기의 primary/session, secondary/weekly 계약을 보존한다.
  if (!fiveHourSource && primary && durationKind(primary) === null) fiveHourSource = primary;
  if (!weeklySource && secondary && durationKind(secondary) === null) weeklySource = secondary;

  const windows = [toWindow("weekly", weeklySource), toWindow("five_hour", fiveHourSource)].filter(Boolean) as UsageWindow[];
  if (!windows.length) throw new Error("Codex app-server response did not include rate limits");
  const primaryWindow = windows.find((window) => window.id === "five_hour") ?? windows[0];
  const credits = parseCodexResetCredits({ result: payload });
  const planType = typeof payload.planType === "string"
    ? payload.planType
    : typeof payload.rateLimits?.planType === "string" ? payload.rateLimits.planType : null;
  const activity = planType ? [`Plan ${planType}`] : [];
  return {
    provider: "codex",
    summary: [...windows.map((window) => `${window.label}: ${window.usedPercent}% used`), ...activity].join("\n"),
    used_percent: primaryWindow.usedPercent,
    remaining_percent: primaryWindow.remainingPercent,
    reset_at: primaryWindow.resetAt,
    details_json: JSON.stringify({ windows, activity, source: "app-server", ...(credits ? { rateLimitResetCredits: credits } : {}) }),
    data_status: "fresh",
    error_code: null,
  };
}

export async function collectCodexUsage(context: UsageCollectorContext): Promise<UsageCollection> {
  let client: CodexAppServerClient | undefined;
  try {
    client = await CodexAppServerClient.connect({
      environment: context.environment,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      clientVersion: codexAppServerClientVersion(),
    });
    const payload = await client.request("account/rateLimits/read", {}) as CodexRateLimitPayload;
    const record = parseCodexAppServerUsage(payload);
    return { record, snapshot: directSnapshot("codex-app-server", record) };
  } finally {
    client?.close();
  }
}

interface CodexModelRow {
  id?: unknown;
  model?: unknown;
  displayName?: unknown;
  description?: unknown;
  hidden?: unknown;
  isDefault?: unknown;
  defaultReasoningEffort?: unknown;
  supportedReasoningEfforts?: unknown;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function codexEffortChoice(value: unknown, index: number): ModelChoice | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = text(row.reasoningEffort);
  if (!id) return null;
  // The current interactive /model screen accepts these four stable choices. Newer app-server
  // catalogs also advertise max/ultra for some models, but exposing them before the TUI selection
  // adapter can validate per-model support would let users choose an invalid combination.
  if (!["low", "medium", "high", "xhigh"].includes(id)) return null;
  const description = text(row.description) ?? undefined;
  return { index: index + 1, id: id === "xhigh" ? "extra-high" : id, label: id === "xhigh" ? "Extra high" : `${id.charAt(0).toUpperCase()}${id.slice(1)}`, description };
}

export function parseCodexModelList(rows: unknown[]): ModelOptions {
  const models: ModelChoice[] = [];
  const effortsById = new Map<string, ModelChoice>();
  let currentModel: string | null = null;
  let currentEffort: string | null = null;
  for (const value of rows) {
    if (!value || typeof value !== "object") continue;
    const row = value as CodexModelRow;
    const id = text(row.model) ?? text(row.id);
    if (!id || row.hidden === true || models.some((model) => model.id === id)) continue;
    const current = row.isDefault === true;
    const effortRows = Array.isArray(row.supportedReasoningEfforts) ? row.supportedReasoningEfforts : [];
    effortRows.forEach((effort, index) => {
      const parsed = codexEffortChoice(effort, index);
      if (parsed && !effortsById.has(parsed.id)) effortsById.set(parsed.id, parsed);
    });
    if (current) {
      currentModel = id;
      const rawEffort = text(row.defaultReasoningEffort);
      currentEffort = rawEffort === "xhigh" ? "extra-high" : rawEffort;
    }
    models.push({
      index: models.length + 1,
      id,
      label: text(row.displayName) ?? id,
      description: text(row.description) ?? undefined,
      current,
    });
  }
  if (!models.length) throw new Error("Codex app-server returned no available models");
  currentModel ??= models[0].id;
  const efforts = [...effortsById.values()].map((effort) => ({ ...effort, current: effort.id === currentEffort }));
  return { provider: "codex", currentModel, currentEffort, models, efforts };
}

export async function collectCodexModelOptions(context: ModelOptionsCollectorContext): Promise<ModelOptions> {
  let client: CodexAppServerClient | undefined;
  try {
    client = await CodexAppServerClient.connect({ environment: context.environment, requestTimeoutMs: REQUEST_TIMEOUT_MS, clientVersion: codexAppServerClientVersion() });
    const rows: unknown[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const result = await client.request("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }) as { data?: unknown; nextCursor?: unknown };
      if (Array.isArray(result?.data)) rows.push(...result.data);
      cursor = text(result?.nextCursor);
      if (!cursor) break;
    }
    return parseCodexModelList(rows);
  } finally {
    client?.close();
  }
}
