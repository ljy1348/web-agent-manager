import { once } from "node:events";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import { CodexAdapter } from "../src/server/providers/codex";
import { createOperationsRouter } from "../src/server/routes/operations-routes";
import {
  createProcessProviderCanaryRunner,
  createConfiguredProviderCanaryRunner,
  PROVIDER_CANARY_STEPS,
  ProviderCanaryService,
  type ProviderCanaryRunner,
} from "../src/server/services/provider-canary";

const roots: string[] = [];
let closeServer: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture(): { database: AppDatabase; dataDir: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wam-provider-canary-"));
  roots.push(dataDir);
  const database = openDatabase({ dataDir } as AppConfig);
  database.prepare("INSERT INTO users(id, username, password_hash, role, access_scope) VALUES (1, 'qa-tester', 'x', 'user', 'test_only')").run();
  return { database, dataDir };
}

const harnessSource = `
const fs = require("node:fs");
const path = require("node:path");
const home = process.env.HOME || "";
const cwd = process.cwd();
const isolated = home.includes("provider-canaries") && cwd.includes("provider-canaries") && !process.env.WAM_PARENT_SECRET;
fs.appendFileSync(path.join(home, "observed-steps"), process.env.WAM_CANARY_STEP + "\\n");
console.log(JSON.stringify({
  state: isolated ? "passed" : "failed",
  reportedVersion: process.env.WAM_CANARY_EXPECTED_VERSION,
  evidence: { code: isolated ? "isolated_ok" : "isolation_failed", sessionObserved: true, eventObserved: true },
  capabilities: {
    transport: "app_server", structuredSession: true, deliveryAcknowledgement: true, queueAcknowledgement: true,
    sessionEvents: true, turnEvents: true, approvalEvents: true, toolEvents: true, usageEvents: true,
    interrupt: true, resume: true, evidencePriority: ["provider_api"], fallbackReasons: []
  }
}));`;

function processService(database: AppDatabase, dataDir: string): ProviderCanaryService {
  return new ProviderCanaryService(database, dataDir, createProcessProviderCanaryRunner(process.execPath, ["-e", harnessSource]), 5_000);
}

async function serve(database: AppDatabase, service: ProviderCanaryService): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((request: any, _response, next) => { request.authUser = { id: 1, username: "qa-tester", role: "user", access_scope: "test_only" }; next(); });
  app.use(createOperationsRouter(
    database,
    {} as never,
    { restartProviderTerminals: () => 0, list: () => [] } as never,
    { snapshot: () => ({ latest: null, recent: [] }) } as never,
    { status: () => ({}) } as never,
    { status: () => ({}) } as never,
    [new CodexAdapter()],
    { settings: () => ({ enabled: false, timeoutHours: 24 }) } as never,
    async (command) => command === "codex" ? "codex 1.0.0" : `${command} test`,
    undefined,
    undefined,
    undefined,
    service,
  ));
  app.use((error: any, _request: any, response: any, _next: any) => response.status(error?.statusCode || 400).json({ error: error?.message || String(error) }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  closeServer = () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("provider CLI canary", () => {
  it("소유자 전용 실제 harness와 credential seed만 격리 HOME에 연결한다", async () => {
    const { database, dataDir } = fixture();
    const harnessRoot = path.join(dataDir, "configured-harness");
    const credentialsRoot = path.join(dataDir, "configured-credentials");
    const candidateRoot = path.join(dataDir, "configured-candidates");
    const seed = path.join(credentialsRoot, "codex", ".codex");
    fs.mkdirSync(harnessRoot, { mode: 0o700 });
    fs.mkdirSync(candidateRoot, { mode: 0o700 });
    fs.mkdirSync(seed, { recursive: true, mode: 0o700 });
    fs.chmodSync(credentialsRoot, 0o700);
    fs.chmodSync(path.join(credentialsRoot, "codex"), 0o700);
    fs.writeFileSync(path.join(seed, "auth.json"), "dedicated-test-credential", { mode: 0o600 });
    const candidate = path.join(candidateRoot, "codex");
    fs.writeFileSync(candidate, "candidate", { mode: 0o700 });
    const script = `#!/bin/sh\nif [ "$(sed -n '1p' "$HOME/.codex/auth.json")" = "dedicated-test-credential" ] && [ "$WAM_CANARY_CANDIDATE_COMMAND" = "${candidate}" ]; then state=passed; code=seed_ok; else state=failed; code=seed_missing; fi\nprintf '{"state":"%s","reportedVersion":"%s","evidence":{"code":"%s"},"capabilities":{"transport":"app_server","structuredSession":true,"interrupt":true,"resume":true}}\\n' "$state" "$WAM_CANARY_EXPECTED_VERSION" "$code"\n`;
    fs.writeFileSync(path.join(harnessRoot, "codex"), script, { mode: 0o700 });
    const runner = createConfiguredProviderCanaryRunner(harnessRoot, credentialsRoot, candidateRoot);
    const service = new ProviderCanaryService(database, dataDir, runner, 5_000);
    const result = await service.run({ provider: "codex", adapter: new CodexAdapter(), currentVersion: "1", candidateVersion: "2", idempotencyKey: "configured", userId: 1 }) as any;
    expect(result.run.state, JSON.stringify(result)).toBe("passed");
    expect(result.run.candidateSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.steps).toHaveLength(10);
    expect(result.steps.every((step: any) => step.evidence.code === "seed_ok")).toBe(true);
    expect(fs.readFileSync(path.join(seed, "auth.json"), "utf8")).toBe("dedicated-test-credential");
    database.close();
  });

  it("symlink harness와 공개 credential root를 시작 전에 거부한다", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-provider-canary-config-"));
    roots.push(root);
    const harnessRoot = path.join(root, "harness");
    const credentialsRoot = path.join(root, "credentials");
    fs.mkdirSync(harnessRoot, { mode: 0o700 });
    fs.mkdirSync(credentialsRoot, { mode: 0o755 });
    fs.symlinkSync(process.execPath, path.join(harnessRoot, "codex"));
    expect(() => createConfiguredProviderCanaryRunner(harnessRoot)).toThrow("안전한 일반 파일");
    fs.unlinkSync(path.join(harnessRoot, "codex"));
    expect(() => createConfiguredProviderCanaryRunner(harnessRoot, credentialsRoot)).toThrow("소유자 전용");
  });

  it("실제 격리 프로세스 10단계를 SQLite 원장과 HTTP API에 연결한다", async () => {
    const { database, dataDir } = fixture();
    const service = processService(database, dataDir);
    const base = await serve(database, service);
    const oldSecret = process.env.WAM_PARENT_SECRET;
    process.env.WAM_PARENT_SECRET = "must-not-leak";
    const started = performance.now();
    const response = await fetch(`${base}/providers/codex/canaries`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "process-http-canary" },
      body: JSON.stringify({ candidateVersion: "codex 2.0.0" }),
    });
    if (oldSecret === undefined) delete process.env.WAM_PARENT_SECRET; else process.env.WAM_PARENT_SECRET = oldSecret;

    expect(response.status).toBe(201);
    const canary = (await response.json() as any).canary;
    expect(canary.run).toMatchObject({ provider: "codex", currentVersion: "codex 1.0.0", candidateVersion: "codex 2.0.0", reportedVersion: "codex 2.0.0", state: "passed" });
    expect(canary.steps.map((step: any) => step.name)).toEqual(PROVIDER_CANARY_STEPS);
    expect(canary.steps.every((step: any) => step.state === "passed" && step.evidence.code === "isolated_ok")).toBe(true);
    expect(canary.run.capabilityDiff).toEqual(expect.arrayContaining([expect.objectContaining({ field: "transport", before: "hook_jsonl_tui", after: "app_server" })]));
    expect(fs.existsSync(path.join(dataDir, "provider-canaries", canary.run.id))).toBe(false);
    expect(performance.now() - started).toBeLessThan(5_000);

    const listStarted = performance.now();
    const listed = await fetch(`${base}/providers/codex/canaries`);
    expect(listed.status).toBe(200);
    expect((await listed.json() as any).canaries).toHaveLength(1);
    expect(performance.now() - listStarted).toBeLessThan(500);
    expect(database.prepare("SELECT COUNT(*) AS count FROM provider_canary_steps").get()).toEqual({ count: 10 });
    expect(database.prepare("SELECT details FROM audit_logs WHERE action = 'provider.cli_canary'").get()).toBeTruthy();
    expect(service.authorizeUpdate("codex", canary.run.id, "codex 1.0.0")).toEqual({ canaryRunId: canary.run.id, candidateVersion: "codex 2.0.0", candidateSha256: null });
    expect(() => service.authorizeUpdate("codex", canary.run.id, "codex 1.0.1")).toThrow("최근 24시간");
    database.prepare("UPDATE provider_canary_runs SET finished_at = datetime('now', '-25 hours') WHERE id = ?").run(canary.run.id);
    expect(() => service.authorizeUpdate("codex", canary.run.id, "codex 1.0.0")).toThrow("최근 24시간");
    database.close();
  });

  it("멱등 재요청은 재실행하지 않고 후보 버전 불일치는 나머지 단계를 건너뛴다", async () => {
    const { database, dataDir } = fixture();
    let calls = 0;
    const mismatchRunner: ProviderCanaryRunner = async () => {
      calls += 1;
      return { state: "passed", reportedVersion: "wrong-version", evidence: { code: "probe_ok" } };
    };
    const service = new ProviderCanaryService(database, dataDir, mismatchRunner);
    const input = { provider: "codex" as const, adapter: new CodexAdapter(), currentVersion: "1", candidateVersion: "2", idempotencyKey: "same", userId: 1 };
    const first = await service.run(input) as any;
    const replay = await service.run(input) as any;

    expect(first.run.state).toBe("blocked");
    expect(first.steps[0]).toMatchObject({ state: "blocked", evidence: { code: "candidate_version_mismatch" } });
    expect(first.steps.slice(1).every((step: any) => step.state === "skipped")).toBe(true);
    expect(replay.run.id).toBe(first.run.id);
    expect(calls).toBe(1);
    expect(() => service.authorizeUpdate("codex", first.run.id, "1")).toThrow("최근 24시간");
    await expect(service.run({ ...input, candidateVersion: "3" })).rejects.toMatchObject({ statusCode: 409 });
    database.close();
  });

  it("재시작 시 pending/running canary와 단계를 blocked로 복구한다", () => {
    const { database, dataDir } = fixture();
    database.prepare(`
      INSERT INTO provider_canary_runs(id, provider, idempotency_key, suite_version, candidate_version, state, current_capabilities_json, created_by)
      VALUES ('interrupted', 'codex', 'recover', 'provider-cli-v1', '2', 'running', '{}', 1)
    `).run();
    database.prepare("INSERT INTO provider_canary_steps(id, run_id, ordinal, name, state) VALUES ('step', 'interrupted', 1, 'login', 'running')").run();
    const service = new ProviderCanaryService(database, dataDir);

    expect(service.recoverInterruptedRuns()).toBe(1);
    expect((service.get("interrupted") as any)).toMatchObject({ run: { state: "blocked", summary: { reason: "server_restart_reconciliation_required" } }, steps: [{ state: "blocked", evidence: { code: "server_restart_reconciliation_required" } }] });
    database.close();
  });
});
