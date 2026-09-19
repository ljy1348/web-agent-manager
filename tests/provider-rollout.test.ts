import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase } from "../src/server/core/database";
import { ProviderRolloutService } from "../src/server/services/provider-rollout";

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-rollout-"));
  roots.push(root);
  const dataDir = path.join(root, "data");
  const candidateRoot = path.join(root, "candidates");
  fs.mkdirSync(dataDir); fs.mkdirSync(candidateRoot, { mode: 0o700 });
  const command = path.join(candidateRoot, "codex");
  fs.writeFileSync(command, "#!/bin/sh\nprintf 'codex 2.0.0\\n'\n", { mode: 0o700 });
  const database = openDatabase({ dataDir } as AppConfig);
  database.prepare("INSERT INTO users(id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')").run();
  const projectId = Number(database.prepare("INSERT INTO projects(name, path) VALUES ('p', ?)").run(root).lastInsertRowid);
  database.prepare(`INSERT INTO provider_canary_runs(id, provider, idempotency_key, suite_version, current_version, candidate_version, reported_version, state, current_capabilities_json, finished_at)
    VALUES ('canary', 'codex', 'canary-key', 'provider-cli-v1', 'codex 1.0.0', 'codex 2.0.0', 'codex 2.0.0', 'passed', '{}', CURRENT_TIMESTAMP)`).run();
  const chat = (name: string) => Number(database.prepare("INSERT INTO chats(project_id, provider, tmux_name, title) VALUES (?, 'codex', ?, ?)").run(projectId, name, name).lastInsertRowid);
  return { database, candidateRoot, command, chat };
}

const sha256 = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

describe("provider staged rollout", () => {
  it("검증된 후보를 정해진 신규 채팅에만 할당하고 오류 관측 시 승격을 막는다", async () => {
    const { database, candidateRoot, command, chat } = fixture();
    const service = new ProviderRolloutService(database, candidateRoot);
    const startedAt = performance.now();
    const started = await service.start({ provider: "codex", canaryRunId: "canary", candidateVersion: "codex 2.0.0", candidateSha256: sha256(command), versionArgs: ["--version"], maxNewChats: 1, idempotencyKey: "rollout-1", userId: 1 }) as any;
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(started).toMatchObject({ state: "active", maxNewChats: 1, assignedCount: 0, replay: false });
    const first = chat("first"); const second = chat("second");
    expect(service.assignNewChat("codex", first)).toBe(started.id);
    expect(service.assignNewChat("codex", second)).toBeNull();
    const managedCommand = service.resolveLaunch(first, "codex", { command: "codex", args: [] }).command;
    expect(managedCommand).not.toBe(command);
    expect(fs.readFileSync(managedCommand, "utf8")).toBe(fs.readFileSync(command, "utf8"));
    expect(service.resolveLaunch(second, "codex", { command: "codex", args: [] }).command).toBe("codex");
    fs.writeFileSync(managedCommand, "changed", { mode: 0o700 });
    expect(() => service.resolveLaunch(first, "codex", { command: "codex", args: [] })).toThrow("hash");
    service.observeChatStatus(first, "error");
    database.prepare("UPDATE chats SET status = 'running' WHERE id = ?").run(first);
    expect(() => service.authorizePromotion(started.id, "codex", "canary")).toThrow("오류 채팅");
    expect(service.halt(started.id, "codex", 1)).toMatchObject({ state: "halted", errorCount: 1 });
    expect(service.resolveLaunch(first, "codex", { command: "codex", args: [] }).command).toBe("codex");
    database.close();
  });

  it("오류 없는 quota 완료만 승격하고 멱등 시작은 후보 프로세스를 반복하지 않는다", async () => {
    const { database, candidateRoot, chat } = fixture();
    let reads = 0;
    const service = new ProviderRolloutService(database, candidateRoot, async () => { reads += 1; return "codex 2.0.0"; });
    const input = { provider: "codex" as const, canaryRunId: "canary", candidateVersion: "codex 2.0.0", candidateSha256: sha256(path.join(candidateRoot, "codex")), versionArgs: ["--version"], maxNewChats: 1, idempotencyKey: "rollout-2", userId: 1 };
    const started = await service.start(input) as any;
    const replay = await service.start(input) as any;
    expect(replay).toMatchObject({ id: started.id, replay: true });
    expect(reads).toBe(1);
    expect(() => service.authorizePromotion(started.id, "codex", "canary")).toThrow("수가 차지 않았거나");
    service.assignNewChat("codex", chat("candidate"));
    expect(() => service.authorizePromotion(started.id, "codex", "canary")).not.toThrow();
    service.promote(started.id, 1);
    expect(service.get(started.id)).toMatchObject({ state: "promoted", assignedCount: 1, errorCount: 0 });
    database.close();
  });

  it("candidate symlink와 버전 불일치를 거부한다", async () => {
    const { database, candidateRoot, command } = fixture();
    fs.unlinkSync(command); fs.symlinkSync(process.execPath, command);
    const unsafe = new ProviderRolloutService(database, candidateRoot);
    expect(() => unsafe.candidateCommand("codex")).toThrow("안전한 일반 파일");
    fs.unlinkSync(command); fs.writeFileSync(command, "x", { mode: 0o700 });
    const mismatch = new ProviderRolloutService(database, candidateRoot, async () => "codex 9.0.0");
    await expect(mismatch.start({ provider: "codex", canaryRunId: "canary", candidateVersion: "codex 2.0.0", candidateSha256: sha256(command), versionArgs: [], maxNewChats: 1, idempotencyKey: "bad", userId: 1 })).rejects.toThrow("실제 버전");
    database.close();
  });
});
