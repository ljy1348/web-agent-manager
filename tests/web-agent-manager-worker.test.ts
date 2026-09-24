import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const script = path.resolve(process.env.WAM_WORKER_TEST_SCRIPT ?? "scripts/web-agent-manager-worker.ts");
const tsx = path.resolve("node_modules/tsx/dist/cli.mjs");
const launcherArgs = script.endsWith(".ts") ? [tsx, script] : [script];

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function setup(options: { timeoutMs?: number; maxConcurrent?: number; args?: string[] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-worker-")); roots.push(root);
  const workspace = path.join(root, "workspace"); const project = path.join(workspace, "project"); const stateDir = path.join(root, "state");
  fs.mkdirSync(project, { recursive: true, mode: 0o700 }); fs.mkdirSync(stateDir, { mode: 0o700 });
  // GitHub hosted runner의 Node는 공유 tool cache에 있어 worker의 고정 recipe 안전 검사에서
  // 거부될 수 있다. 테스트가 소유한 0700 launcher를 실제 recipe executable로 사용한다.
  const nodeLauncher = path.join(root, "node-launcher");
  fs.writeFileSync(nodeLauncher, `#!/bin/sh\nexec ${shellQuote(process.execPath)} "$@"\n`, { mode: 0o700 });
  const fixture = path.join(project, "fixture.mjs");
  fs.writeFileSync(fixture, "const [delay='0', code='0', value='ok'] = process.argv.slice(2); setTimeout(() => { console.log(value); process.exit(Number(code)); }, Number(delay));\n", { mode: 0o600 });
  const configPath = path.join(root, "worker.json");
  fs.writeFileSync(configPath, JSON.stringify({
    protocol: "wam-worker/v1", workspaceRoot: workspace, stateDir, maxConcurrent: options.maxConcurrent ?? 2,
    recipes: { test: { executable: nodeLauncher, args: options.args ?? [fixture, "10", "0", "API_KEY=super-secret-value"], timeoutMs: options.timeoutMs ?? 2_000 } },
  }), { mode: 0o600 });
  return { root, workspace, project, stateDir, configPath, fixture };
}

async function cli(configPath: string, args: string[], timeoutMs = 8_000): Promise<{ code: number | null; stdout: string; stderr: string; elapsed: number }> {
  const started = performance.now();
  const child = spawn(process.execPath, [...launcherArgs, ...args], { cwd: path.resolve("."), env: { ...process.env, WEB_AGENT_MANAGER_WORKER_CONFIG: configPath }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; }); child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const [code] = await once(child, "close") as [number | null]; clearTimeout(timer);
  return { code, stdout: stdout.trim(), stderr: stderr.trim(), elapsed: performance.now() - started };
}
function request(projectPath: string, requestId = "request-1", extra: Record<string, unknown> = {}): string {
  return Buffer.from(JSON.stringify({ protocol: "wam-worker/v1", requestId, taskId: "task-1", capability: "test", projectPath, ...extra })).toString("base64url");
}
async function waitFor(configPath: string, id: string, expected: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 7_000;
  while (Date.now() < deadline) {
    const result = await cli(configPath, ["tasks", "status", "--protocol", "wam-worker/v1", "--dispatch-id", id]);
    if (result.code === 0) { const value = JSON.parse(result.stdout) as Record<string, unknown>; if (value.state === expected) return value; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`dispatch ${id} did not reach ${expected}`);
}

describe("web-agent-manager-worker CLI", () => {
  it("고정 capability를 빠르게 접수하고 owner-only 원장에서 멱등 실행·redaction한다", async () => {
    const env = setup();
    const capabilities = await cli(env.configPath, ["capabilities", "--json"]);
    expect(capabilities.code).toBe(0);
    expect(JSON.parse(capabilities.stdout)).toEqual({ protocol: "wam-worker/v1", version: "0.7.0", capabilities: ["test"] });
    const encoded = request(env.project);
    const started = await cli(env.configPath, ["tasks", "start", "--protocol", "wam-worker/v1", "--request-base64", encoded]);
    expect(started.code).toBe(0); expect(started.elapsed).toBeLessThan(2_000);
    expect(JSON.parse(started.stdout)).toMatchObject({ protocol: "wam-worker/v1", requestId: "request-1", dispatchId: "request-1", state: "queued" });
    const completed = await waitFor(env.configPath, "request-1", "completed");
    expect(completed.summary).toContain("API_KEY=[REDACTED]"); expect(JSON.stringify(completed)).not.toContain("super-secret-value");
    const replay = await cli(env.configPath, ["tasks", "start", "--protocol", "wam-worker/v1", "--request-base64", encoded]);
    expect(JSON.parse(replay.stdout)).toMatchObject({ dispatchId: "request-1", state: "completed" });
    expect(fs.readdirSync(env.stateDir).filter((name) => name.endsWith(".json"))).toEqual(["request-1.json"]);
    expect(fs.statSync(env.stateDir).mode & 0o077).toBe(0); expect(fs.statSync(path.join(env.stateDir, "request-1.json")).mode & 0o077).toBe(0);
  });

  it("exact schema, request ID 재사용, symlink workspace escape와 느슨한 config 권한을 거부한다", async () => {
    const env = setup();
    const badSchema = await cli(env.configPath, ["tasks", "start", "--protocol", "wam-worker/v1", "--request-base64", request(env.project, "bad", { command: "rm" })]);
    expect(badSchema.code).toBe(1); expect(badSchema.stderr).toContain("unknown or missing");
    const outside = path.join(env.root, "outside"); fs.mkdirSync(outside); const link = path.join(env.workspace, "link"); fs.symlinkSync(outside, link);
    const escaped = await cli(env.configPath, ["tasks", "start", "--protocol", "wam-worker/v1", "--request-base64", request(link, "escape")]);
    expect(escaped.code).toBe(1); expect(escaped.stderr).toContain("escapes workspaceRoot");
    const first = await cli(env.configPath, ["tasks", "start", "--protocol", "wam-worker/v1", "--request-base64", request(env.project, "same")]); expect(first.code).toBe(0);
    const changed = await cli(env.configPath, ["tasks", "start", "--protocol", "wam-worker/v1", "--request-base64", request(env.project, "same", { taskId: "other" })]);
    expect(changed.code).toBe(1); expect(changed.stderr).toContain("different task");
    fs.chmodSync(env.configPath, 0o644);
    const loose = await cli(env.configPath, ["capabilities", "--json"]); expect(loose.code).toBe(1); expect(loose.stderr).toContain("group or others");
  });

  it("동시성 상한과 timeout을 실제 child process에서 적용하고 셸 메타문자를 실행하지 않는다", async () => {
    const env = setup({ maxConcurrent: 1, timeoutMs: 1_000, args: [] });
    const marker = path.join(env.root, "must-not-exist");
    const config = JSON.parse(fs.readFileSync(env.configPath, "utf8"));
    config.recipes.test.args = [env.fixture, "5000", "0", `ok;touch ${marker}`];
    fs.writeFileSync(env.configPath, JSON.stringify(config), { mode: 0o600 });
    const first = await cli(env.configPath, ["tasks", "start", "--protocol", "wam-worker/v1", "--request-base64", request(env.project, "slow-1")]); expect(first.code).toBe(0);
    const second = await cli(env.configPath, ["tasks", "start", "--protocol", "wam-worker/v1", "--request-base64", request(env.project, "slow-2")]);
    expect(second.code).toBe(1); expect(second.stderr).toContain("concurrency limit");
    const failed = await waitFor(env.configPath, "slow-1", "failed"); expect(failed.summary).toBe("recipe timed out");
    expect(fs.existsSync(marker)).toBe(false);
  });
});
