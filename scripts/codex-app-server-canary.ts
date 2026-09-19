#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { CodexAppServerClient, type CodexAppServerNotification, type CodexAppServerRequestId } from "../src/server/providers/codex-app-server";

const STEPS = new Set([
  "login", "new_session", "resume", "idle_input", "follow_up", "approval", "interrupt", "completion", "rate_limit_sample", "usage_read",
]);
const MARKERS: Record<string, string> = {
  idle_input: "WAM_CODEX_CANARY_IDLE_OK",
  follow_up: "WAM_CODEX_CANARY_FOLLOW_UP_OK",
  completion: "WAM_CODEX_CANARY_COMPLETION_OK",
};

interface CanaryState { threadId: string }
interface HarnessResult {
  state: "passed" | "failed" | "blocked";
  reportedVersion: string | null;
  evidence: { code: string; sessionObserved?: boolean; eventObserved?: boolean };
  capabilities?: Record<string, unknown>;
}

class BlockedError extends Error {
  constructor(public readonly code: string) { super(code); }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function safeCode(error: unknown): string {
  if (error instanceof BlockedError) return error.code;
  const message = error instanceof Error ? error.message : String(error);
  if (/시간이 초과|timed? out/i.test(message)) return "app_server_timeout";
  if (/Command failed|EACCES|ENOENT/i.test(message)) return "candidate_execution_failed";
  if (/auth|login|credential|로그인|인증/i.test(message)) return "test_credential_rejected";
  if (/종료|닫혀|closed|exit/i.test(message)) return "app_server_closed";
  return "app_server_contract_failed";
}

function assertPrivateDirectory(value: string | undefined, label: string): string {
  if (!value) throw new BlockedError(`${label}_missing`);
  const resolved = path.resolve(value);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(resolved); } catch { throw new BlockedError(`${label}_missing`); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new BlockedError(`${label}_unsafe`);
  return resolved;
}

function assertCandidate(value: string | undefined): string {
  if (!value || !path.isAbsolute(value)) throw new BlockedError("candidate_command_missing");
  const resolved = path.resolve(value);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(resolved); } catch { throw new BlockedError("candidate_command_missing"); }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) throw new BlockedError("candidate_command_unsafe");
  fs.accessSync(resolved, fs.constants.X_OK);
  return resolved;
}

function firstLine(value: string): string | null {
  const line = value.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  return line && line.length <= 200 && !/[\0\r\n]/.test(line) ? line : null;
}

function capabilities(version: string): Record<string, unknown> {
  return {
    transport: "app_server",
    structuredSession: true,
    deliveryAcknowledgement: true,
    queueAcknowledgement: false,
    sessionEvents: true,
    turnEvents: true,
    approvalEvents: true,
    toolEvents: true,
    usageEvents: false,
    interrupt: true,
    resume: true,
    evidencePriority: ["provider_api", "hook", "jsonl", "tui"],
    fallbackReasons: ["pre_delivery_connection_failure", "delivery_unknown", "unsupported_server_request"],
    cliVersion: version,
  };
}

function writeResult(result: HarnessResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function main(): Promise<void> {
  let reportedVersion: string | null = null;
  let activeProcess: ChildProcess | undefined;
  let terminating = false;
  const terminate = (signal: NodeJS.Signals = "SIGTERM"): void => {
    if (!activeProcess?.pid) return;
    try {
      if (process.platform !== "win32") process.kill(-activeProcess.pid, signal);
      else activeProcess.kill(signal);
    } catch { /* 이미 종료된 격리 child다. */ }
  };
  const terminateAndExit = (code: number): void => {
    if (terminating) return;
    terminating = true;
    terminate("SIGTERM");
    setTimeout(() => { terminate("SIGKILL"); process.exit(code); }, 250);
  };
  process.once("SIGTERM", () => terminateAndExit(143));
  process.once("SIGINT", () => terminateAndExit(130));
  try {
    if (process.env.WAM_CANARY_PROVIDER !== "codex") throw new BlockedError("provider_not_codex");
    const step = process.env.WAM_CANARY_STEP ?? "";
    if (!STEPS.has(step)) throw new BlockedError("step_invalid");
    const homeDir = assertPrivateDirectory(process.env.HOME, "home");
    const workspaceDir = assertPrivateDirectory(process.cwd(), "workspace");
    const seedMarker = path.join(homeDir, ".wam-canary-seeded");
    if (!fs.existsSync(seedMarker)) throw new BlockedError("dedicated_credential_seed_required");
    const markerStat = fs.lstatSync(seedMarker);
    if (!markerStat.isFile() || markerStat.isSymbolicLink() || (markerStat.mode & 0o077) !== 0) {
      throw new BlockedError("dedicated_credential_seed_required");
    }
    const command = assertCandidate(process.env.WAM_CANARY_CANDIDATE_COMMAND);
    const childEnvironment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "",
      HOME: homeDir,
      TMPDIR: process.env.TMPDIR ?? path.join(homeDir, "tmp"),
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? path.join(homeDir, ".config"),
      CODEX_HOME: process.env.CODEX_HOME ?? path.join(homeDir, ".codex"),
      LANG: process.env.LANG ?? "C.UTF-8",
    };
    reportedVersion = firstLine(execFileSync(command, ["--version"], {
      cwd: workspaceDir, env: childEnvironment, encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"],
    }));
    if (!reportedVersion) throw new BlockedError("candidate_version_unreported");
    const timeoutMs = Math.min(120_000, Math.max(2_000, Number.parseInt(process.env.WAM_CANARY_TIMEOUT_MS ?? "30000", 10) || 30_000));
    const terminal = new Map<string, string>();
    const terminalWaiters = new Map<string, (status: string) => void>();
    const answers = new Map<string, string>();
    let threadEventObserved = false;
    let threadEventWaiter: (() => void) | undefined;
    let approvalObserved = false;
    let toolEventObserved = false;

    const onNotification = (notification: CodexAppServerNotification): void => {
      const params = object(notification.params);
      if (!params) return;
      if (notification.method === "thread/started") { threadEventObserved = true; threadEventWaiter?.(); threadEventWaiter = undefined; }
      if (notification.method === "item/started" || notification.method === "item/completed") toolEventObserved = true;
      const turn = object(params.turn);
      const turnId = typeof params.turnId === "string" ? params.turnId : typeof turn?.id === "string" ? turn.id : "";
      if (notification.method === "item/agentMessage/delta" && turnId && typeof params.delta === "string") {
        answers.set(turnId, `${answers.get(turnId) ?? ""}${params.delta}`.slice(0, 4_096));
      }
      if (notification.method === "turn/completed" && turnId) {
        const status = typeof turn?.status === "string" ? turn.status : "unknown";
        terminal.set(turnId, status);
        terminalWaiters.get(turnId)?.(status);
        terminalWaiters.delete(turnId);
      }
    };
    const onServerRequest = async (request: { id: CodexAppServerRequestId; method: string; params: unknown }): Promise<unknown> => {
      if (request.method !== "item/commandExecution/requestApproval" && request.method !== "item/fileChange/requestApproval") {
        throw new Error("unsupported_server_request");
      }
      approvalObserved = true;
      return { decision: "decline" };
    };
    const spawnProcess = (): any => {
      activeProcess = spawn(command, ["app-server"], {
        cwd: workspaceDir,
        env: childEnvironment,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "ignore"],
      });
      return activeProcess as any;
    };
    const connect = (): Promise<CodexAppServerClient> => CodexAppServerClient.connect({
      clientVersion: "0.6.0",
      requestTimeoutMs: Math.max(1_000, timeoutMs - 1_000),
      spawnProcess,
      onNotification,
      onServerRequest,
    });
    const statePath = path.join(homeDir, ".wam-codex-canary-state.json");
    const loadState = (): CanaryState => {
      let value: unknown;
      try { value = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { throw new BlockedError("canary_thread_state_missing"); }
      const threadId = object(value)?.threadId;
      if (typeof threadId !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(threadId)) throw new BlockedError("canary_thread_state_invalid");
      return { threadId };
    };
    const saveState = (state: CanaryState): void => {
      const temporary = `${statePath}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, statePath);
      fs.chmodSync(statePath, 0o600);
    };
    const threadIdFrom = (value: unknown): string => {
      const id = object(object(value)?.thread)?.id;
      if (typeof id !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(id)) throw new Error("thread_id_invalid");
      return id;
    };
    const turnIdFrom = (value: unknown): string => {
      const id = object(object(value)?.turn)?.id;
      if (typeof id !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(id)) throw new Error("turn_id_invalid");
      return id;
    };
    const waitForTerminal = (turnId: string): Promise<string> => {
      const observed = terminal.get(turnId);
      if (observed) return Promise.resolve(observed);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { terminalWaiters.delete(turnId); reject(new Error("turn_terminal_timeout")); }, Math.max(1_000, timeoutMs - 1_000));
        timer.unref();
        terminalWaiters.set(turnId, (status) => { clearTimeout(timer); resolve(status); });
      });
    };
    const waitForThreadEvent = (): Promise<void> => {
      if (threadEventObserved) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { threadEventWaiter = undefined; reject(new Error("thread_started_event_missing")); }, Math.min(2_000, Math.max(500, timeoutMs - 1_000)));
        timer.unref();
        threadEventWaiter = () => { clearTimeout(timer); resolve(); };
      });
    };
    const resume = async (client: CodexAppServerClient, approvalPolicy = "never", sandbox = "read-only"): Promise<string> => {
      const state = loadState();
      const result = await client.request("thread/resume", {
        threadId: state.threadId, cwd: workspaceDir, approvalPolicy, sandbox, excludeTurns: true,
      });
      if (threadIdFrom(result) !== state.threadId) throw new Error("thread_resume_id_mismatch");
      return state.threadId;
    };
    const runTurn = async (prompt: string, marker?: string, interrupt = false): Promise<{ status: string; turnId: string }> => {
      const client = await connect();
      try {
        const threadId = await resume(client, marker === undefined && !interrupt ? "on-request" : "never", "read-only");
        const result = await client.request("turn/start", {
          threadId,
          clientUserMessageId: crypto.randomUUID(),
          input: [{ type: "text", text: prompt, text_elements: [] }],
        });
        const turnId = turnIdFrom(result);
        if (interrupt) await client.request("turn/interrupt", { threadId, turnId });
        const status = await waitForTerminal(turnId);
        if (marker && (answers.get(turnId) ?? "").trim() !== marker) throw new Error("assistant_marker_mismatch");
        return { status, turnId };
      } finally { client.close(); activeProcess = undefined; }
    };

    let evidence: HarnessResult["evidence"];
    if (step === "login") {
      const client = await connect();
      try {
        const account = await client.request("account/read", {});
        if (!object(object(account)?.account)) throw new Error("test_credential_rejected");
      } finally { client.close(); activeProcess = undefined; }
      evidence = { code: "login_ok", sessionObserved: true, eventObserved: false };
    } else if (step === "new_session") {
      const client = await connect();
      try {
        const result = await client.request("thread/start", { cwd: workspaceDir, approvalPolicy: "never", sandbox: "read-only", ephemeral: false });
        saveState({ threadId: threadIdFrom(result) });
        await waitForThreadEvent();
      } finally { client.close(); activeProcess = undefined; }
      evidence = { code: "new_session_ok", sessionObserved: true, eventObserved: threadEventObserved };
    } else if (step === "resume") {
      const client = await connect();
      try { await resume(client); } finally { client.close(); activeProcess = undefined; }
      evidence = { code: "resume_ok", sessionObserved: true, eventObserved: threadEventObserved };
    } else if (step === "idle_input" || step === "follow_up" || step === "completion") {
      const marker = MARKERS[step]!;
      const result = await runTurn(`Respond with exactly ${marker} and nothing else. Do not use tools.`, marker);
      if (result.status !== "completed") throw new Error("turn_not_completed");
      evidence = { code: `${step}_ok`, sessionObserved: true, eventObserved: true };
    } else if (step === "approval") {
      const before = fs.readdirSync(workspaceDir).sort();
      const result = await runTurn("Try to create a file named wam-canary-must-not-exist using a shell command. Ask for approval if required.");
      if (!approvalObserved || !toolEventObserved || !["completed", "failed"].includes(result.status)) throw new Error("approval_event_missing");
      if (JSON.stringify(before) !== JSON.stringify(fs.readdirSync(workspaceDir).sort())) throw new Error("approval_workspace_changed");
      evidence = { code: "approval_declined_ok", sessionObserved: true, eventObserved: approvalObserved || toolEventObserved };
    } else if (step === "interrupt") {
      const result = await runTurn("Write the integers from 1 to 10000, one per line, without using tools.", undefined, true);
      if (result.status !== "interrupted") throw new Error("interrupt_terminal_missing");
      evidence = { code: "interrupt_ok", sessionObserved: true, eventObserved: true };
    } else {
      const client = await connect();
      try {
        const value = await client.request("account/rateLimits/read", {});
        if (!object(value) || Object.keys(object(value)!).length === 0) throw new Error("rate_limits_invalid");
      } finally { client.close(); activeProcess = undefined; }
      evidence = { code: step === "rate_limit_sample" ? "rate_limit_sample_ok" : "usage_read_ok", eventObserved: true };
    }
    writeResult({ state: "passed", reportedVersion, evidence, capabilities: capabilities(reportedVersion) });
  } catch (error) {
    terminate();
    writeResult({
      state: error instanceof BlockedError ? "blocked" : "failed",
      reportedVersion,
      evidence: { code: safeCode(error) },
    });
  }
}

void main();
