#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { redactVerificationOutput } from "../src/server/services/verification-service";

const PROTOCOL = "wam-worker/v1";
const WORKER_VERSION = "0.6.0";
const CAPABILITIES = new Set(["build", "test", "verify", "preview"]);
const STATES = new Set(["queued", "running", "completed", "failed"]);
const OUTPUT_LIMIT = 64 * 1024;

interface Recipe { executable: string; args: string[]; timeoutMs: number }
interface WorkerConfig { workspaceRoot: string; stateDir: string; maxConcurrent: number; recipes: Record<string, Recipe> }
interface TaskRequest { protocol: string; requestId: string; taskId: string; capability: string; projectPath: string }
interface Job extends TaskRequest, Recipe {
  dispatchId: string; state: string; inputHash: string; createdAt: string; updatedAt: string; pid: number | null; summary: string | null;
}

function fail(message: string): never { throw new Error(message); }
function exactObject(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== [...keys].sort().join("\0")) fail(`${label} has unknown or missing fields`);
  return record;
}
function safeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(value)) fail(`${label} is invalid`);
  return value;
}
function assertOwnerOnly(file: string, kind: "file" | "directory"): fs.Stats {
  const stat = fs.statSync(file);
  if (kind === "file" ? !stat.isFile() : !stat.isDirectory()) fail(`${file} must be a ${kind}`);
  if ((stat.mode & 0o077) !== 0) fail(`${file} must not be accessible by group or others`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) fail(`${file} must be owned by the worker user`);
  return stat;
}
function normalizedAbsolute(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || value === "/" || value.includes("\0") || value.includes("\\") || value.split("/").includes("..")) fail(`${label} must be a normalized absolute POSIX path other than /`);
  if (path.posix.normalize(value) !== value.replace(/\/$/, "")) fail(`${label} must be normalized`);
  return value.replace(/\/$/, "");
}
function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function realDirectory(value: unknown, label: string): string {
  const declared = normalizedAbsolute(value, label);
  let actual: string;
  try { actual = fs.realpathSync(declared); } catch { fail(`${label} does not exist`); }
  if (!fs.statSync(actual).isDirectory()) fail(`${label} must be a directory`);
  return actual;
}
function configPathFromEnvironment(): string {
  const configured = process.env.WEB_AGENT_MANAGER_WORKER_CONFIG ?? path.join(os.homedir(), ".config", "web-agent-manager", "worker.json");
  if (!path.isAbsolute(configured) || configured.includes("\0")) fail("worker config path must be absolute");
  return configured;
}
function readConfig(): { config: WorkerConfig; configPath: string } {
  const configPath = configPathFromEnvironment();
  assertOwnerOnly(configPath, "file");
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch { fail("worker config is not valid JSON"); }
  const raw = exactObject(parsed, ["protocol", "workspaceRoot", "stateDir", "maxConcurrent", "recipes"], "worker config");
  if (raw.protocol !== PROTOCOL) fail("worker config protocol is incompatible");
  const workspaceRoot = realDirectory(raw.workspaceRoot, "workspaceRoot");
  const stateDirDeclared = normalizedAbsolute(raw.stateDir, "stateDir");
  fs.mkdirSync(stateDirDeclared, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateDirDeclared, 0o700);
  const stateDir = fs.realpathSync(stateDirDeclared);
  assertOwnerOnly(stateDir, "directory");
  if (within(workspaceRoot, stateDir)) fail("stateDir must be outside workspaceRoot");
  const maxConcurrent = Number(raw.maxConcurrent);
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 16) fail("maxConcurrent must be an integer from 1 to 16");
  if (!raw.recipes || typeof raw.recipes !== "object" || Array.isArray(raw.recipes)) fail("recipes must be an object");
  const recipes: Record<string, Recipe> = {};
  for (const [capability, value] of Object.entries(raw.recipes as Record<string, unknown>)) {
    if (!CAPABILITIES.has(capability)) fail(`unsupported recipe capability: ${capability}`);
    const recipe = exactObject(value, ["executable", "args", "timeoutMs"], `recipe ${capability}`);
    const executableDeclared = normalizedAbsolute(recipe.executable, `recipe ${capability} executable`);
    const executable = fs.realpathSync(executableDeclared);
    const stat = fs.statSync(executable);
    if (!stat.isFile() || (stat.mode & 0o022) !== 0 || (stat.mode & 0o111) === 0) fail(`recipe ${capability} executable is unsafe`);
    if (!Array.isArray(recipe.args) || recipe.args.length > 100 || !recipe.args.every((arg) => typeof arg === "string" && arg.length > 0 && arg.length <= 1_024 && !arg.includes("\0"))) fail(`recipe ${capability} args are invalid`);
    const timeoutMs = Number(recipe.timeoutMs);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30 * 60_000) fail(`recipe ${capability} timeoutMs is invalid`);
    recipes[capability] = { executable, args: recipe.args as string[], timeoutMs };
  }
  if (!Object.keys(recipes).length) fail("at least one recipe is required");
  return { config: { workspaceRoot, stateDir, maxConcurrent, recipes }, configPath };
}
function parseRequest(encoded: string, config: WorkerConfig): TaskRequest & { projectPath: string } {
  if (!/^[A-Za-z0-9_-]{1,16384}$/.test(encoded)) fail("request-base64 is invalid");
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); } catch { fail("task request is not valid base64url JSON"); }
  const raw = exactObject(parsed, ["protocol", "requestId", "taskId", "capability", "projectPath"], "task request");
  if (raw.protocol !== PROTOCOL) fail("task request protocol is incompatible");
  const requestId = safeId(raw.requestId, "requestId");
  const taskId = safeId(raw.taskId, "taskId");
  if (typeof raw.capability !== "string" || !config.recipes[raw.capability]) fail("task capability is not configured");
  const declaredProject = normalizedAbsolute(raw.projectPath, "projectPath");
  let projectPath: string;
  try { projectPath = fs.realpathSync(declaredProject); } catch { fail("projectPath does not exist"); }
  if (!fs.statSync(projectPath).isDirectory() || !within(config.workspaceRoot, projectPath)) fail("projectPath escapes workspaceRoot");
  return { protocol: PROTOCOL, requestId, taskId, capability: raw.capability, projectPath };
}
function jobFile(config: WorkerConfig, id: string): string { return path.join(config.stateDir, `${safeId(id, "dispatchId")}.json`); }
function readJob(config: WorkerConfig, id: string): Job {
  const file = jobFile(config, id);
  assertOwnerOnly(file, "file");
  const job = JSON.parse(fs.readFileSync(file, "utf8")) as Job;
  if (job.dispatchId !== id || job.protocol !== PROTOCOL || !STATES.has(job.state)) fail("stored job is invalid");
  return job;
}
function writeJob(config: WorkerConfig, job: Job, exclusive = false): void {
  const target = jobFile(config, job.dispatchId);
  if (exclusive) {
    fs.writeFileSync(target, JSON.stringify(job), { flag: "wx", mode: 0o600 });
    return;
  }
  const temporary = path.join(config.stateDir, `.${job.dispatchId}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(job), { flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, target);
}
function processAlive(pid: number | null): boolean {
  if (!pid || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function reconcile(job: Job, config: WorkerConfig): Job {
  if ((job.state === "running" || job.state === "queued") && job.pid && !processAlive(job.pid)) {
    const failed = { ...job, state: "failed", summary: "worker process ended before reporting a result", updatedAt: new Date().toISOString() };
    writeJob(config, failed); return failed;
  }
  return job;
}
function response(job: Job, includeRequest = false): Record<string, unknown> {
  return { protocol: PROTOCOL, ...(includeRequest ? { requestId: job.requestId } : {}), dispatchId: job.dispatchId, state: job.state, ...(job.summary ? { summary: job.summary } : {}) };
}
function lock<T>(config: WorkerConfig, action: () => T): T {
  const lockPath = path.join(config.stateDir, ".start.lock");
  try { fs.mkdirSync(lockPath, { mode: 0o700 }); } catch { fail("worker admission is busy; retry status before starting again"); }
  try { return action(); } finally { fs.rmdirSync(lockPath); }
}
function activeCount(config: WorkerConfig): number {
  let count = 0;
  for (const name of fs.readdirSync(config.stateDir)) {
    if (!/^[A-Za-z0-9._:-]{1,160}\.json$/.test(name)) continue;
    try { const job = reconcile(readJob(config, name.slice(0, -5)), config); if (job.state === "queued" || job.state === "running") count += 1; } catch { /* unrelated/corrupt files never become executable jobs */ }
  }
  return count;
}
function start(encoded: string): Record<string, unknown> {
  const { config, configPath } = readConfig();
  const request = parseRequest(encoded, config);
  const recipe = config.recipes[request.capability]!;
  const inputHash = crypto.createHash("sha256").update(JSON.stringify(request)).digest("hex");
  return lock(config, () => {
    const target = jobFile(config, request.requestId);
    if (fs.existsSync(target)) {
      const existing = reconcile(readJob(config, request.requestId), config);
      if (existing.inputHash !== inputHash) fail("requestId was already used for a different task");
      return response(existing, true);
    }
    if (activeCount(config) >= config.maxConcurrent) fail("worker concurrency limit reached");
    const now = new Date().toISOString();
    const job: Job = { ...request, ...recipe, dispatchId: request.requestId, state: "queued", inputHash, createdAt: now, updatedAt: now, pid: null, summary: null };
    writeJob(config, job, true);
    const script = fileURLToPath(import.meta.url);
    try {
      const child = spawn(process.execPath, [...process.execArgv, script, "__run", "--dispatch-id", job.dispatchId], {
        detached: true, stdio: "ignore", cwd: "/", env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", WEB_AGENT_MANAGER_WORKER_CONFIG: configPath },
      });
      job.pid = child.pid ?? null; job.updatedAt = new Date().toISOString(); writeJob(config, job); child.unref();
      return response(job, true);
    } catch (error) {
      job.state = "failed"; job.summary = "worker runner could not start"; job.updatedAt = new Date().toISOString(); writeJob(config, job);
      throw error;
    }
  });
}
async function runJob(id: string): Promise<void> {
  const { config } = readConfig();
  let job = readJob(config, id);
  for (let attempt = 0; job.state === "queued" && job.pid !== process.pid && attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    job = readJob(config, id);
  }
  if (job.state !== "queued" || job.pid !== process.pid) return;
  job = { ...job, state: "running", updatedAt: new Date().toISOString() }; writeJob(config, job);
  const child = spawn(job.executable, job.args, { cwd: job.projectPath, shell: false, stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", CI: "true" } });
  let output = ""; let timedOut = false; let exceeded = false;
  const append = (chunk: Buffer) => { output += chunk.toString("utf8"); if (Buffer.byteLength(output) > OUTPUT_LIMIT) { exceeded = true; output = output.slice(0, OUTPUT_LIMIT); child.kill("SIGTERM"); } };
  child.stdout.on("data", append); child.stderr.on("data", append);
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 2_000).unref(); }, job.timeoutMs);
  const code = await new Promise<number | null>((resolve) => { child.once("error", () => resolve(null)); child.once("close", resolve); });
  clearTimeout(timer);
  const redacted = redactVerificationOutput(output, os.homedir());
  const detail = redacted.text.replace(/[\r\n]+/g, " ").trim().slice(-400);
  const success = code === 0 && !timedOut && !exceeded && redacted.status === "safe";
  job = { ...job, state: success ? "completed" : "failed", summary: timedOut ? "recipe timed out" : exceeded ? "recipe output exceeded 64KiB" : redacted.status === "blocked" ? "recipe output was quarantined by redaction policy" : detail || (success ? "recipe completed" : `recipe exited with code ${code ?? "unknown"}`), updatedAt: new Date().toISOString() };
  writeJob(config, job);
}
function status(id: string): Record<string, unknown> {
  const { config } = readConfig();
  return response(reconcile(readJob(config, id), config));
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === "capabilities" && args[1] === "--json") {
    const { config } = readConfig();
    process.stdout.write(`${JSON.stringify({ protocol: PROTOCOL, version: WORKER_VERSION, capabilities: Object.keys(config.recipes).sort() })}\n`); return;
  }
  if (args.length === 6 && args[0] === "tasks" && args[1] === "start" && args[2] === "--protocol" && args[3] === PROTOCOL && args[4] === "--request-base64") {
    process.stdout.write(`${JSON.stringify(start(args[5]!))}\n`); return;
  }
  if (args.length === 6 && args[0] === "tasks" && args[1] === "status" && args[2] === "--protocol" && args[3] === PROTOCOL && args[4] === "--dispatch-id") {
    process.stdout.write(`${JSON.stringify(status(args[5]!))}\n`); return;
  }
  if (args.length === 3 && args[0] === "__run" && args[1] === "--dispatch-id") { await runJob(args[2]!); return; }
  fail("usage: web-agent-manager-worker capabilities --json | tasks start|status");
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
