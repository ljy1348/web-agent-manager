import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import type { UsageRecord, UsageWindow } from "../../shared/types";
import type { ModelChoice, ModelOptions } from "./provider";
import { directSnapshot, normalizedPercent, normalizedResetAt, type UsageCollection, type UsageCollectorContext } from "./usage-collector";
import type { ModelOptionsCollectorContext } from "./model-options-collector";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_MODEL_SELECTOR_URL = "https://api.anthropic.com/api/model_selector/cc";
const REQUEST_TIMEOUT_MS = 10_000;

interface ClaudeUsageWindow {
  used_percentage?: unknown;
  utilization?: unknown;
  resets_at?: unknown;
}

interface ClaudeScopedLimit {
  kind?: unknown;
  percent?: unknown;
  resets_at?: unknown;
  scope?: { model?: { display_name?: unknown } | null } | null;
}

interface ClaudeUsagePayload {
  five_hour?: ClaudeUsageWindow;
  seven_day?: ClaudeUsageWindow;
  limits?: ClaudeScopedLimit[] | null;
  [key: string]: unknown;
}

interface ClaudeCredentialFile {
  claudeAiOauth?: { accessToken?: unknown };
}

interface ClaudeModelSelectorRow {
  id?: unknown;
  name?: unknown;
  short_name?: unknown;
  description?: unknown;
  section?: unknown;
  quick_select?: unknown;
  min_claude_code_version?: unknown;
  thinking?: { type?: unknown; effort_options?: unknown } | null;
}

interface ClaudeModelSelectorConfig {
  id?: unknown;
  models?: unknown;
}

interface ClaudeModelSelectorState {
  id?: unknown;
  model?: unknown;
  thinking?: { type?: unknown; effort?: unknown } | null;
}

interface ClaudeModelSelectorPayload {
  model_selector_config?: unknown;
  model_selector_state?: unknown;
}

function titleCase(value: string): string {
  return value.split(/[-_\s]+/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function normalizedClaudeResetAt(value: unknown): string | null {
  const normalized = normalizedResetAt(value);
  if (!normalized) return null;
  // Claude OAuth occasionally jitters the same window boundary by a few hundred milliseconds
  // (and sometimes across :59/:00). The CLI only exposes minute precision, so round the direct
  // value to that same stable precision to avoid rewriting an unchanged reset on every poll.
  const milliseconds = Date.parse(normalized);
  return new Date(Math.round(milliseconds / 60_000) * 60_000).toISOString();
}

function windowFromPayload(id: string, label: string, value: ClaudeUsageWindow | undefined): UsageWindow | null {
  // OAuth usage has shipped both names: older/statusline payloads use used_percentage while the
  // current endpoint uses utilization. Accepting both keeps the direct path independent of CLI UI.
  const usedPercent = normalizedPercent(value?.used_percentage ?? value?.utilization);
  if (usedPercent === null) return null;
  return { id, label, usedPercent, remainingPercent: 100 - usedPercent, resetAt: normalizedClaudeResetAt(value?.resets_at) };
}

export function parseClaudeOAuthUsage(payload: ClaudeUsagePayload): Partial<UsageRecord> {
  const windows: UsageWindow[] = [];
  const session = windowFromPayload("session", "Current session", payload.five_hour);
  const weekly = windowFromPayload("weekly_all", "Current week (all models)", payload.seven_day);
  if (session) windows.push(session);
  if (weekly) windows.push(weekly);

  // Claude가 모델별 주간 필드를 추가해도 TUI parser처럼 자동 노출한다.
  for (const [key, value] of Object.entries(payload)) {
    if (!key.startsWith("seven_day_") || !value || typeof value !== "object") continue;
    const suffix = key.slice("seven_day_".length);
    const window = windowFromPayload(`weekly_${suffix}`, `Current week (${titleCase(suffix)})`, value as ClaudeUsageWindow);
    if (window && !windows.some((candidate) => candidate.id === window.id)) windows.push(window);
  }
  // Fable appeared under several field names before it moved into the generic scoped limits list.
  for (const key of ["fable_weekly", "fable_seven_day", "seven_day_fable"] as const) {
    const window = windowFromPayload("weekly_fable", "Current week (Fable)", payload[key] as ClaudeUsageWindow | undefined);
    if (window && !windows.some((candidate) => candidate.id === window.id)) windows.push(window);
  }
  for (const limit of Array.isArray(payload.limits) ? payload.limits : []) {
    if (limit?.kind !== "weekly_scoped") continue;
    const displayName = typeof limit.scope?.model?.display_name === "string" ? limit.scope.model.display_name.trim() : "";
    const usedPercent = normalizedPercent(limit.percent);
    if (!displayName || usedPercent === null) continue;
    const suffix = displayName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    const id = `weekly_${suffix}`;
    if (!suffix || windows.some((candidate) => candidate.id === id)) continue;
    windows.push({ id, label: `Current week (${displayName})`, usedPercent, remainingPercent: 100 - usedPercent, resetAt: normalizedClaudeResetAt(limit.resets_at) });
  }

  if (!windows.length) throw new Error("Claude OAuth usage response did not include usage windows");
  const primary = windows.find((window) => window.id === "session") ?? windows[0];
  return {
    provider: "claude",
    summary: windows.map((window) => `${window.label}: ${window.usedPercent}% used`).join("\n"),
    used_percent: primary.usedPercent,
    remaining_percent: primary.remainingPercent,
    reset_at: primary.resetAt,
    details_json: JSON.stringify({ windows, activity: [], source: "oauth" }),
    data_status: "fresh",
    error_code: null,
  };
}

async function readClaudeAccessToken(environment: Record<string, string>): Promise<string> {
  const configDir = environment.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const raw = await fs.readFile(path.join(configDir, ".credentials.json"), "utf8");
  const parsed = JSON.parse(raw) as ClaudeCredentialFile;
  const token = parsed.claudeAiOauth?.accessToken;
  if (typeof token !== "string" || !token.trim()) throw new Error("Claude OAuth access token is unavailable");
  return token;
}

export async function collectClaudeUsage(context: UsageCollectorContext): Promise<UsageCollection> {
  const token = await readClaudeAccessToken(context.environment);
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
  const response = await fetch(CLAUDE_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "claude-code/2.1.0",
    },
    signal,
  });
  if (!response.ok) throw new Error(`Claude OAuth usage request failed (HTTP ${response.status})`);
  const record = parseClaudeOAuthUsage(await response.json() as ClaudeUsagePayload);
  return { record, snapshot: directSnapshot("claude-oauth", record) };
}

async function optionalJson(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function selectorText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function selectorSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function versionParts(value: string): number[] | null {
  const match = value.match(/\d+(?:\.\d+)+/);
  return match ? match[0].split(".").map((part) => Number.parseInt(part, 10)) : null;
}

export function claudeVersionSatisfies(installed: string, minimum: string): boolean {
  const left = versionParts(installed);
  const right = versionParts(minimum);
  if (!left || !right) return false;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

function selectorRows(value: unknown): ClaudeModelSelectorRow[] {
  return Array.isArray(value) ? value.filter((row): row is ClaudeModelSelectorRow => !!row && typeof row === "object") : [];
}

function effortRows(value: unknown): Array<{ id: string; label: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const id = selectorText(row.id)?.toLowerCase();
    const label = selectorText(row.name);
    return id && label ? [{ id, label }] : [];
  });
}

// API의 raw 모델 행과 TUI의 논리 선택 항목은 다르다. main quick-select는 `Opus`처럼 다음 버전으로
// 이동하는 alias이고 overflow는 특정 버전 고정 선택이다. 특정 family/버전은 하드코딩하지 않고
// 서버가 준 short_name/section/quick_select만으로 매번 picker 계약을 재구성한다.
export function parseClaudeModelSelector(payload: ClaudeModelSelectorPayload, settings: Record<string, unknown>, cliVersion: string): ModelOptions {
  const configs = Array.isArray(payload.model_selector_config) ? payload.model_selector_config as ClaudeModelSelectorConfig[] : [];
  const states = Array.isArray(payload.model_selector_state) ? payload.model_selector_state as ClaudeModelSelectorState[] : [];
  const config = configs.find((entry) => selectorText(entry?.id) === "cc") ?? configs[0];
  const state = states.find((entry) => selectorText(entry?.id) === "cc") ?? states[0];
  const eligible = selectorRows(config?.models).filter((row) => {
    const minimum = selectorText(row.min_claude_code_version);
    return !minimum || claudeVersionSatisfies(cliVersion, minimum);
  });
  if (!eligible.length) throw new Error("Claude model selector returned no compatible models");

  const byId = new Map(eligible.flatMap((row) => {
    const id = selectorText(row.id);
    return id ? [[id, row] as const] : [];
  }));
  const defaultRow = byId.get(selectorText(state?.model) ?? "") ?? eligible[0];
  const defaultId = selectorText(defaultRow.id)!;
  const defaultName = selectorText(defaultRow.name) ?? defaultId;
  const defaultDescription = selectorText(defaultRow.description);
  const choices: ModelChoice[] = [{
    index: 1,
    id: "default",
    label: "Default (recommended)",
    description: [defaultName, defaultDescription].filter(Boolean).join(" · "),
    selectionKind: "default",
    resolvedModelId: defaultId,
    resolvedLabel: defaultName,
  }];
  const seen = new Set(["default"]);
  for (const row of eligible) {
    const providerId = selectorText(row.id);
    const name = selectorText(row.name);
    if (!providerId || !name) continue;
    const shortName = selectorText(row.short_name) ?? name;
    const isAlias = row.quick_select === true;
    const selectionSlug = selectorSlug(isAlias ? shortName : name);
    if (!selectionSlug) continue;
    const id = `${isAlias ? "alias" : "exact"}:${selectionSlug}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const description = selectorText(row.description);
    choices.push({
      index: choices.length + 1,
      id,
      label: isAlias ? shortName : name,
      description: [name, description].filter(Boolean).join(" · "),
      selectionKind: isAlias ? "alias" : "exact",
      resolvedModelId: providerId,
      resolvedLabel: name,
    });
  }

  const configuredModel = selectorText(settings.model)?.toLowerCase() ?? "default";
  let currentModel = "default";
  if (configuredModel !== "default") {
    const configuredRow = byId.get(configuredModel);
    if (configuredRow) {
      const name = selectorText(configuredRow.name) ?? configuredModel;
      const shortName = selectorText(configuredRow.short_name) ?? name;
      currentModel = `${configuredRow.quick_select === true ? "alias" : "exact"}:${selectorSlug(configuredRow.quick_select === true ? shortName : name)}`;
    } else {
      const alias = choices.find((choice) => choice.selectionKind === "alias" && selectorSlug(choice.label) === selectorSlug(configuredModel));
      if (alias) currentModel = alias.id;
    }
  }
  if (!choices.some((choice) => choice.id === currentModel)) currentModel = "default";
  for (const choice of choices) choice.current = choice.id === currentModel;

  const effortsById = new Map<string, { id: string; label: string }>();
  for (const row of eligible) {
    for (const effort of effortRows(row.thinking?.effort_options)) if (!effortsById.has(effort.id)) effortsById.set(effort.id, effort);
  }
  const currentEffort = selectorText(settings.effortLevel)?.toLowerCase()
    ?? (state?.thinking?.type === "effort" ? selectorText(state.thinking.effort)?.toLowerCase() ?? null : null);
  const efforts: ModelChoice[] = [...effortsById.values()].map((effort, index) => ({ ...effort, index: index + 1, current: effort.id === currentEffort }));
  return { provider: "claude", currentModel, currentEffort, models: choices, efforts };
}

function readClaudeCliVersion(command: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, ["--version"], { encoding: "utf8", maxBuffer: 64 * 1024, timeout: REQUEST_TIMEOUT_MS, signal }, (error, stdout) => {
      if (error) reject(new Error(`Claude version check failed: ${error.message}`));
      else {
        const version = stdout.match(/\d+(?:\.\d+)+/)?.[0];
        if (!version) reject(new Error("Claude version output did not include a version"));
        else resolve(version);
      }
    });
  });
}

export async function collectClaudeModelOptions(context: ModelOptionsCollectorContext): Promise<ModelOptions> {
  const [token, cliVersion] = await Promise.all([readClaudeAccessToken(context.environment), readClaudeCliVersion(context.command, context.signal)]);
  const configDir = context.environment.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const settings = await optionalJson(path.join(configDir, "settings.json"));
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
  const response = await fetch(CLAUDE_MODEL_SELECTOR_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-client-platform": "cli",
      "User-Agent": `claude-code/${cliVersion}`,
      Accept: "application/json",
    },
    signal,
  });
  if (!response.ok) throw new Error(`Claude model selector request failed (HTTP ${response.status})`);
  return parseClaudeModelSelector(await response.json() as ClaudeModelSelectorPayload, settings, cliVersion);
}
