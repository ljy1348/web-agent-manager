import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase } from "../src/server/core/database";
import type { ProviderAdapter } from "../src/server/providers/provider";
import {
  createConfiguredProviderCanaryRunner,
  createProcessProviderCanaryRunner,
  ProviderCanaryService,
} from "../src/server/services/provider-canary";

const roots: string[] = [];
afterEach(() => { delete process.env.WAM_SECRET_MARKER; while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

function executable(file: string, body: string): void {
  fs.writeFileSync(file, body, { mode: 0o700 });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-codex-canary-")); roots.push(root);
  const dataDir = path.join(root, "data"); const harnessRoot = path.join(root, "harness");
  const credentialRoot = path.join(root, "credentials"); const candidateRoot = path.join(root, "candidate");
  for (const directory of [dataDir, harnessRoot, credentialRoot, candidateRoot]) fs.mkdirSync(directory, { mode: 0o700 });
  const codexSeed = path.join(credentialRoot, "codex"); fs.mkdirSync(path.join(codexSeed, ".codex"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(codexSeed, ".codex", "auth.json"), "dedicated-test-only-seed", { mode: 0o600 });
  const candidate = path.join(candidateRoot, "codex");
  executable(candidate, `#!/usr/bin/env node
import readline from "node:readline";
if (process.argv[2] === "--version") { process.stdout.write("codex-test 1.0.0\\n"); process.exit(0); }
if (process.argv[2] !== "app-server" || process.env.WAM_SECRET_MARKER) process.exit(91);
const rl = readline.createInterface({ input: process.stdin });
let pendingApproval = null; let pendingInterrupt = null; let nextTurn = 1;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "fake" } });
  if (message.method === "initialized") return;
  if (message.method === "account/read") return send({ id: message.id, result: { account: { type: "chatgpt" } } });
  if (message.method === "account/rateLimits/read") return send({ id: message.id, result: { rateLimits: { primary: { usedPercent: 1 } } } });
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread-canary" } } });
    return setTimeout(() => send({ method: "thread/started", params: { thread: { id: "thread-canary" } } }), 2);
  }
  if (message.method === "thread/resume") return send({ id: message.id, result: { thread: { id: message.params.threadId } } });
  if (message.method === "turn/start") {
    const turnId = "turn-" + nextTurn++;
    const prompt = message.params.input[0].text;
    send({ id: message.id, result: { turn: { id: turnId, status: "inProgress" } } });
    setTimeout(() => send({ method: "turn/started", params: { threadId: message.params.threadId, turn: { id: turnId, status: "inProgress" } } }), 2);
    if (prompt.includes("wam-canary-must-not-exist")) {
      pendingApproval = { turnId, threadId: message.params.threadId };
      return setTimeout(() => {
        send({ method: "item/started", params: { threadId: message.params.threadId, turnId, item: { id: "item-approval", type: "commandExecution" } } });
        send({ id: "approval-1", method: "item/commandExecution/requestApproval", params: {
          threadId: message.params.threadId, turnId, itemId: "item-approval", availableDecisions: ["decline"]
        } });
      }, 4);
    }
    if (prompt.includes("integers from 1")) { pendingInterrupt = { turnId, threadId: message.params.threadId }; return; }
    const marker = prompt.match(/Respond with exactly ([A-Z0-9_]+)/)?.[1] || "UNKNOWN";
    setTimeout(() => {
      send({ method: "item/agentMessage/delta", params: { threadId: message.params.threadId, turnId, delta: marker } });
      send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, status: "completed" } } });
    }, 4);
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    const current = pendingInterrupt;
    pendingInterrupt = null;
    return setTimeout(() => send({ method: "turn/completed", params: { threadId: current.threadId, turn: { id: current.turnId, status: "interrupted" } } }), 2);
  }
  if (message.id === "approval-1" && pendingApproval) {
    const current = pendingApproval; pendingApproval = null;
    return setTimeout(() => send({ method: "turn/completed", params: { threadId: current.threadId, turn: { id: current.turnId, status: "completed" } } }), 2);
  }
});
`);
  const tsxCli = path.resolve("node_modules/tsx/dist/cli.mjs");
  const canaryScript = path.resolve("scripts/codex-app-server-canary.ts");
  executable(path.join(harnessRoot, "codex"), `#!/bin/sh
exec "${process.execPath}" "${tsxCli}" "${canaryScript}"
`);
  const database = openDatabase({ dataDir, homeDir: root } as AppConfig);
  database.prepare("INSERT INTO users(id,username,password_hash,role) VALUES (1,'canary-owner','x','admin')").run();
  return { root, dataDir, harnessRoot, credentialRoot, candidateRoot, candidate, database };
}

describe("bundled Codex app-server canary harness", () => {
  it("전용 seed와 실제 stdio fake CLI로 고정 10단계를 끝까지 검증한다", async () => {
    const input = fixture();
    const runner = createConfiguredProviderCanaryRunner(input.harnessRoot, input.credentialRoot, input.candidateRoot);
    const service = new ProviderCanaryService(input.database, input.dataDir, runner, 5_000);
    process.env.WAM_SECRET_MARKER = "must-not-leak";
    const started = performance.now();
    const result = await service.run({
      provider: "codex",
      adapter: { id: "codex", displayLabel: "Codex" } as ProviderAdapter,
      currentVersion: "codex-old 0.9.0",
      candidateVersion: "codex-test 1.0.0",
      idempotencyKey: "codex-app-server-real-stdio",
      userId: 1,
    }) as any;
    delete process.env.WAM_SECRET_MARKER;

    expect(performance.now() - started).toBeLessThan(30_000);
    expect(result.steps[0]).toMatchObject({ state: "passed", evidence: { code: "login_ok" } });
    expect(result.steps.find((step: any) => step.state !== "passed")).toBeUndefined();
    expect(result.run).toMatchObject({ state: "passed", reportedVersion: "codex-test 1.0.0" });
    expect(result.run.candidateSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.steps).toHaveLength(10);
    expect(result.steps.every((step: any) => step.state === "passed")).toBe(true);
    expect(result.steps.map((step: any) => step.evidence.code)).toEqual([
      "login_ok", "new_session_ok", "resume_ok", "idle_input_ok", "follow_up_ok",
      "approval_declined_ok", "interrupt_ok", "completion_ok", "rate_limit_sample_ok", "usage_read_ok",
    ]);
    const persisted = JSON.stringify(input.database.prepare("SELECT * FROM provider_canary_runs").all())
      + JSON.stringify(input.database.prepare("SELECT * FROM provider_canary_steps").all());
    expect(persisted).not.toContain("dedicated-test-only-seed");
    expect(persisted).not.toContain("WAM_CODEX_CANARY_");
    expect(fs.readdirSync(path.join(input.dataDir, "provider-canaries"))).toEqual([]);
    input.database.close();
  }, 35_000);

  it("전용 credential seed marker가 없으면 CLI를 시작하지 않고 blocked한다", async () => {
    const input = fixture();
    const homeDir = path.join(input.root, "direct-home"); const workspaceDir = path.join(input.root, "direct-workspace");
    fs.mkdirSync(homeDir, { mode: 0o700 }); fs.mkdirSync(workspaceDir, { mode: 0o700 });
    const runner = createProcessProviderCanaryRunner(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), path.resolve("scripts/codex-app-server-canary.ts")]);
    const result = await runner({
      provider: "codex", step: "login", expectedVersion: "codex-test 1.0.0", homeDir, workspaceDir,
      timeoutMs: 5_000, candidateCommand: input.candidate,
    });
    expect(result).toMatchObject({ state: "blocked", reportedVersion: null, evidence: { code: "dedicated_credential_seed_required" } });
    input.database.close();
  });

  it("wrapper timeout이면 detached app-server process group을 남기지 않는다", async () => {
    const input = fixture();
    const homeDir = path.join(input.root, "timeout-home"); const workspaceDir = path.join(input.root, "timeout-workspace");
    fs.mkdirSync(homeDir, { mode: 0o700 }); fs.mkdirSync(workspaceDir, { mode: 0o700 });
    fs.writeFileSync(path.join(homeDir, ".wam-canary-seeded"), "seeded\n", { mode: 0o600 });
    const hanging = path.join(input.root, "hanging-codex"); const pidFile = path.join(input.root, "hanging.pid");
    executable(hanging, `#!/usr/bin/env node
import fs from "node:fs";
if (process.argv[2] === "--version") { process.stdout.write("codex-test 1.0.0\\n"); process.exit(0); }
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`);
    const runner = createProcessProviderCanaryRunner(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), path.resolve("scripts/codex-app-server-canary.ts")]);
    const result = await runner({
      provider: "codex", step: "login", expectedVersion: "codex-test 1.0.0", homeDir, workspaceDir,
      // 전체 suite의 병렬 CPU 부하에서도 tsx wrapper와 candidate가 실제로 뜬 뒤 timeout되어야
      // process-group 정리를 검증할 수 있다. 800ms는 candidate 시작 전 끝나 ENOENT만 검사했다.
      timeoutMs: 3_000, candidateCommand: hanging,
    });
    expect(result).toMatchObject({ state: "failed", evidence: { code: "app_server_timeout" } });
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    const running = (): boolean => {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        return stat.split(" ")[2] !== "Z";
      } catch { return false; }
    };
    await expect.poll(running, { timeout: 2_000 }).toBe(false);
    input.database.close();
  }, 10_000);
});
