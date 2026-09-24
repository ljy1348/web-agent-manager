import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import type { UsageRecord, UsageWindow } from "../../shared/types";
import type { ModelChoice, ModelOptions } from "./provider";
import { directSnapshot, normalizedPercent, normalizedResetAt, type UsageCollection, type UsageCollectorContext } from "./usage-collector";
import type { ModelOptionsCollectorContext } from "./model-options-collector";

const REQUEST_TIMEOUT_MS = 10_000;
const PREFERRED_ISSUER = "https://auth.x.ai";

interface GrokAuthEntry {
  key?: unknown;
  user_id?: unknown;
  email?: unknown;
  expires_at?: unknown;
}

interface GrokMoneyValue {
  val?: unknown;
}

interface GrokBillingConfig {
  creditUsagePercent?: unknown;
  currentPeriod?: { type?: unknown; start?: unknown; end?: unknown } | null;
  billingPeriodStart?: unknown;
  billingPeriodEnd?: unknown;
  subscriptionTier?: unknown;
  monthlyLimit?: GrokMoneyValue;
  used?: GrokMoneyValue;
}

interface GrokBillingPayload extends GrokBillingConfig {
  config?: GrokBillingConfig | null;
}

interface GrokSession {
  accessToken: string;
  userId: string | null;
  email: string | null;
}

function money(value: GrokMoneyValue | undefined): number | null {
  const raw = value?.val;
  const parsed = typeof raw === "string" ? Number.parseFloat(raw) : raw;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

function matchingTimestamp(left: unknown, right: unknown): boolean {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && leftTime === rightTime;
}

// Grok's protobuf JSON omits a scalar when its value is zero. The official 1.0.41 TUI treats an
// absent creditUsagePercent as 0% only when currentPeriod explicitly proves a weekly allowance and
// its boundaries match the billing period. This is the same evidence behind `/usage show`'s 0% bar.
function weeklyPercent(config: GrokBillingConfig): number | null {
  const reported = normalizedPercent(config.creditUsagePercent);
  if (reported !== null) return reported;
  if (config.creditUsagePercent !== undefined) return null;
  return config.currentPeriod?.type === "USAGE_PERIOD_TYPE_WEEKLY"
    && matchingTimestamp(config.currentPeriod.start, config.billingPeriodStart)
    && matchingTimestamp(config.currentPeriod.end, config.billingPeriodEnd)
    ? 0
    : null;
}

function billingWindows(config: GrokBillingConfig): UsageWindow[] {
  const windows: UsageWindow[] = [];
  const weeklyUsedPercent = weeklyPercent(config);
  const periodEnd = config.currentPeriod?.end ?? config.billingPeriodEnd;
  if (weeklyUsedPercent !== null) {
    windows.push({ id: "weekly", label: "Weekly limit", usedPercent: weeklyUsedPercent, remainingPercent: 100 - weeklyUsedPercent, resetAt: normalizedResetAt(periodEnd) });
  }
  const monthlyLimit = money(config.monthlyLimit);
  const monthlyUsed = money(config.used);
  if (monthlyLimit !== null && monthlyUsed !== null && monthlyLimit > 0) {
    const usedPercent = Math.min(100, Math.max(0, monthlyUsed / monthlyLimit * 100));
    windows.push({ id: "monthly", label: "Monthly included budget", usedPercent, remainingPercent: 100 - usedPercent, resetAt: normalizedResetAt(periodEnd) });
  }
  return windows;
}

export function parseGrokBillingUsage(payload: GrokBillingPayload): Partial<UsageRecord> {
  const config = payload.config ?? payload;
  const windows = billingWindows(config);
  if (!windows.length) throw new Error("Grok billing response did not include a usage percentage");
  const primary = windows.find((window) => window.id === "weekly") ?? windows[0];
  const tier = typeof config.subscriptionTier === "string" && config.subscriptionTier.trim() ? config.subscriptionTier.trim() : null;
  const activity = tier ? [`Plan ${tier}`] : [];
  return {
    provider: "grok",
    summary: [...windows.map((window) => `${window.label}: ${window.usedPercent}% used`), ...activity].join("\n"),
    used_percent: primary.usedPercent,
    remaining_percent: primary.remainingPercent,
    reset_at: primary.resetAt,
    details_json: JSON.stringify({ windows, activity, source: "oauth" }),
    data_status: "fresh",
    error_code: null,
  };
}

function authEntry(value: unknown): GrokAuthEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as GrokAuthEntry;
  return typeof entry.key === "string" && entry.key ? entry : null;
}

async function readGrokSession(environment: Record<string, string>): Promise<GrokSession> {
  const home = environment.GROK_HOME || process.env.GROK_HOME || path.join(os.homedir(), ".grok");
  const parsed = JSON.parse(await fs.readFile(path.join(home, "auth.json"), "utf8")) as Record<string, unknown>;
  const preferred = Object.entries(parsed).filter(([issuer]) => issuer === PREFERRED_ISSUER || issuer.startsWith(`${PREFERRED_ISSUER}::`));
  const entries = preferred.length ? preferred : Object.entries(parsed);
  const selected = entries.map(([, value]) => authEntry(value)).find(Boolean);
  if (!selected || typeof selected.key !== "string") throw new Error("Grok OAuth access token is unavailable");
  if (typeof selected.expires_at === "string") {
    const expiry = Date.parse(selected.expires_at);
    if (Number.isFinite(expiry) && expiry <= Date.now() + 5 * 60_000) throw new Error("Grok OAuth access token is expired");
  }
  return {
    accessToken: selected.key,
    userId: typeof selected.user_id === "string" ? selected.user_id : null,
    email: typeof selected.email === "string" ? selected.email : null,
  };
}

async function fetchBilling(url: string, session: GrokSession, signal: AbortSignal): Promise<GrokBillingPayload> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.accessToken}`,
    "X-XAI-Token-Auth": "xai-grok-cli",
    Accept: "application/json",
  };
  if (session.userId) headers["x-userid"] = session.userId;
  const response = await fetch(url, { headers, signal });
  if (!response.ok) throw new Error(`Grok billing request failed (HTTP ${response.status})`);
  const payload = await response.json();
  if (!payload || typeof payload !== "object") throw new Error("Grok billing response is invalid");
  return payload as GrokBillingPayload;
}

export async function collectGrokUsage(context: UsageCollectorContext): Promise<UsageCollection> {
  const session = await readGrokSession(context.environment);
  const base = (context.environment.GROK_CLI_CHAT_PROXY_BASE_URL || process.env.GROK_CLI_CHAT_PROXY_BASE_URL || "https://cli-chat-proxy.grok.com/v1").replace(/\/$/, "");
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
  let payload = await fetchBilling(`${base}/billing?format=credits`, session, signal);
  let record: Partial<UsageRecord>;
  try {
    record = parseGrokBillingUsage(payload);
  } catch {
    // 일부 unified-billing 계정은 format=credits에 주간 비율을 주지 않고 기본 응답에 월 예산만 준다.
    payload = await fetchBilling(`${base}/billing`, session, signal);
    record = parseGrokBillingUsage(payload);
  }
  return { record, snapshot: directSnapshot("grok-billing", record) };
}

const GROK_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

function grokModelLabel(id: string): string {
  return id.replace(/^grok-/i, "Grok ").replace(/-build-fast$/i, " Build Fast");
}

export function parseGrokModelsOutput(output: string): ModelOptions {
  const defaultId = output.match(/^Default model:\s*(\S+)/im)?.[1] ?? null;
  const models: ModelChoice[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*[*-]\s+(\S+?)(?:\s+\(default\))?\s*$/i);
    if (!match) continue;
    const id = match[1];
    if (models.some((model) => model.id === id)) continue;
    models.push({ index: models.length + 1, id, label: grokModelLabel(id), current: id === defaultId });
  }
  if (!models.length) throw new Error("grok models returned no available models");
  const efforts = GROK_EFFORTS.map((id, index) => ({ index: index + 1, id, label: id }));
  return { provider: "grok", currentModel: defaultId ?? models[0].id, models, efforts };
}

export async function collectGrokModelOptions(context: ModelOptionsCollectorContext): Promise<ModelOptions> {
  const output = await new Promise<string>((resolve, reject) => {
    execFile(context.command, ["models"], {
      env: { ...process.env, ...context.environment },
      encoding: "utf8",
      maxBuffer: 512 * 1024,
      timeout: REQUEST_TIMEOUT_MS,
      signal: context.signal,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`grok models failed: ${error.message}${stderr.trim() ? ` (${stderr.trim().split("\n").at(-1)})` : ""}`));
        return;
      }
      resolve(stdout);
    });
  });
  return parseGrokModelsOutput(output);
}
