import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase } from "../src/server/core/database";
import { TaskCommandService } from "../src/server/services/task-command-service";
import { VerificationService, classifyPullRequestCheckRollup, redactVerificationOutput, snapshotGitWorkspace, type VerificationExecutor } from "../src/server/services/verification-service";

const roots: string[] = [];
const snapshotter = () => ({ commitHash: "a".repeat(40), diffHash: "b".repeat(64) });

function fixture(steps: unknown[], verificationPolicy: Record<string, unknown> = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wam-verification-data-"));
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "wam-verification-project-"));
  roots.push(dataDir, projectPath);
  const database = openDatabase({ dataDir } as AppConfig);
  database.prepare("INSERT INTO users(id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')").run();
  const projectId = Number(database.prepare("INSERT INTO projects(name, path) VALUES ('p', ?)").run(projectPath).lastInsertRowid);
  database.prepare("INSERT INTO agent_presets(id, project_id, name, status, active_version) VALUES ('profile', ?, 'profile', 'active', 1)").run(projectId);
  const snapshot = { schemaVersion: 1, runtime: { provider: "codex" }, verification: { steps, ...verificationPolicy } };
  database.prepare("INSERT INTO agent_preset_versions(id, preset_id, version, config_snapshot_json) VALUES ('profile-v1', 'profile', 1, ?)").run(JSON.stringify(snapshot));
  const chatId = Number(database.prepare(`
    INSERT INTO chats(project_id, provider, tmux_name, status, title, preset_version_id, preset_config_json)
    VALUES (?, 'codex', 'verification-chat', 'running', 'chat', 'profile-v1', ?)
  `).run(projectId, JSON.stringify(snapshot)).lastInsertRowid);
  const task = new TaskCommandService(database).receive(chatId, "work", { id: 1, username: "admin", role: "admin" }, "command-1");
  database.prepare("UPDATE agent_tasks SET state = 'running' WHERE id = ?").run(task.task.id);
  return { database, dataDir, projectPath, chatId, taskId: task.task.id };
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("VerificationService", () => {
  it("task가 채팅 시작 당시 profile version을 고정하고 모든 필수 step 통과 뒤에만 완료한다", async () => {
    const { database, dataDir, projectPath, taskId } = fixture([
      { kind: "static", argv: ["npm", "run", "typecheck"], required: true },
      { kind: "full_test", argv: ["npm", "test"], required: true },
    ]);
    expect(database.prepare("SELECT profile_version_id FROM agent_tasks WHERE id = ?").get(taskId)).toEqual({ profile_version_id: "profile-v1" });
    const calls: unknown[] = [];
    const executor: VerificationExecutor = async (argv, cwd, timeoutMs) => {
      calls.push({ argv, cwd, timeoutMs });
      return { exitCode: 0, stdout: `ok API_TOKEN=secret ${os.homedir()}`, stderr: "", durationMs: 12 };
    };
    const service = new VerificationService(database, dataDir, os.homedir(), executor, snapshotter);

    const result = await service.run(taskId, "verify-1", 1) as any;

    expect(result.run.state).toBe("passed");
    expect(result.run).toMatchObject({ commit_hash: "a".repeat(40), diff_hash: "b".repeat(64) });
    expect(result.steps.map((step: any) => step.state)).toEqual(["passed", "passed"]);
    expect(calls).toEqual([
      { argv: ["npm", "run", "typecheck"], cwd: projectPath, timeoutMs: 600_000 },
      { argv: ["npm", "test"], cwd: projectPath, timeoutMs: 600_000 },
    ]);
    expect(database.prepare("SELECT state, state_reason FROM agent_tasks WHERE id = ?").get(taskId)).toEqual({ state: "completed", state_reason: "verification_passed" });
    const outputPath = (database.prepare("SELECT path FROM verification_artifacts WHERE id = ?").get(result.artifacts[0].id) as { path: string }).path;
    const output = fs.readFileSync(outputPath, "utf8");
    expect(output).toContain("API_TOKEN=[REDACTED]");
    expect(output).toContain("$HOME");
    expect(output).not.toContain("secret");
    database.close();
  });

  it("필수 step 실패 즉시 중단하고 task를 completed로 표시하지 않는다", async () => {
    const { database, dataDir, taskId } = fixture([
      { kind: "static", argv: ["check"], required: true },
      { kind: "build", argv: ["build"], required: true },
    ]);
    let calls = 0;
    const service = new VerificationService(database, dataDir, "/home/user", async () => {
      calls += 1;
      return { exitCode: 2, stdout: "", stderr: "failed", durationMs: 4 };
    }, snapshotter);

    const result = await service.run(taskId, "verify-fail", 1) as any;

    expect(result.run.state).toBe("failed");
    expect(result.steps).toHaveLength(1);
    expect(calls).toBe(1);
    expect(database.prepare("SELECT state, state_reason FROM agent_tasks WHERE id = ?").get(taskId)).toEqual({ state: "failed", state_reason: "verification_failed" });
    database.close();
  });

  it("live/human 검증은 자동 실행하지 않고 명시적 승인 대기로 차단한다", async () => {
    const { database, dataDir, taskId } = fixture([{ kind: "live", argv: [], required: true }]);
    let called = false;
    const service = new VerificationService(database, dataDir, "/home/user", async () => { called = true; throw new Error("호출되면 안 됨"); }, snapshotter);

    const result = await service.run(taskId, "verify-live", 1) as any;

    expect(result.run.state).toBe("blocked");
    expect(JSON.parse(result.run.summary_json)).toMatchObject({ reason: "explicit_approval_required" });
    expect(called).toBe(false);
    expect(database.prepare("SELECT state, state_reason FROM agent_tasks WHERE id = ?").get(taskId)).toEqual({ state: "needs_input", state_reason: "explicit_approval_required" });
    database.close();
  });

  it("관리자 승인 뒤 같은 workspace snapshot에서만 live 단계를 실행한다", async () => {
    const { database, dataDir, taskId } = fixture([{ kind: "live", argv: ["probe", "--safe"], required: true }]);
    const calls: unknown[] = [];
    const service = new VerificationService(database, dataDir, "/home/user", async (...args) => {
      calls.push(args);
      return { exitCode: 0, stdout: "live ok", stderr: "", durationMs: 2 };
    }, snapshotter);
    const blocked = await service.run(taskId, "live-run", 1) as any;
    const approved = await service.decideBlockedRun(blocked.run.id, "approve", "approve-1", 1) as any;

    expect(approved.run).toMatchObject({ state: "passed", approved_by: 1 });
    expect(approved.run).not.toHaveProperty("approval_idempotency_key");
    expect(approved.steps).toEqual([expect.objectContaining({ kind: "live", state: "passed" })]);
    expect(calls).toHaveLength(1);
    expect(database.prepare("SELECT state FROM agent_tasks WHERE id = ?").get(taskId)).toEqual({ state: "completed" });
    const replay = await service.decideBlockedRun(blocked.run.id, "approve", "approve-1", 1) as any;
    expect(replay.run.id).toBe(blocked.run.id);
    expect(calls).toHaveLength(1);
    database.close();
  });

  it("human review 승인은 명령 실행 없이 증거 step을 만들고 거부 결정은 task를 실패시킨다", async () => {
    const human = fixture([{ kind: "human_review", required: true }]);
    let called = false;
    const humanService = new VerificationService(human.database, human.dataDir, "/home/user", async () => { called = true; throw new Error("호출 금지"); }, snapshotter);
    const run = await humanService.run(human.taskId, "human", 1) as any;
    const approved = await humanService.decideBlockedRun(run.run.id, "approve", "human-approval", 1) as any;
    expect(approved.run.state).toBe("passed");
    expect(approved.steps).toEqual([expect.objectContaining({ kind: "human_review", state: "passed" })]);
    expect(approved.steps[0]).not.toHaveProperty("command_json");
    expect(called).toBe(false);
    human.database.close();

    const declinedFixture = fixture([{ kind: "live", argv: ["probe"] }]);
    const declinedService = new VerificationService(declinedFixture.database, declinedFixture.dataDir, "/home/user", async () => { throw new Error("호출 금지"); }, snapshotter);
    const declinedRun = await declinedService.run(declinedFixture.taskId, "decline", 1) as any;
    const declined = await declinedService.decideBlockedRun(declinedRun.run.id, "decline", "decision-1", 1) as any;
    expect(declined.run.state).toBe("failed");
    expect(declinedFixture.database.prepare("SELECT state, state_reason FROM agent_tasks WHERE id = ?").get(declinedFixture.taskId)).toEqual({ state: "failed", state_reason: "verification_approval_declined" });
    declinedFixture.database.close();
  });

  it("승인 대기 중 workspace가 달라지면 live 명령을 실행하지 않는다", async () => {
    const { database, dataDir, taskId } = fixture([{ kind: "live", argv: ["probe"] }]);
    let revision = "b".repeat(64);
    let called = false;
    const service = new VerificationService(database, dataDir, "/home/user", async () => { called = true; throw new Error("호출 금지"); }, () => ({ commitHash: "a".repeat(40), diffHash: revision }));
    const run = await service.run(taskId, "changed", 1) as any;
    revision = "c".repeat(64);
    const result = await service.decideBlockedRun(run.run.id, "approve", "approve-changed", 1) as any;
    expect(result.run.state).toBe("blocked");
    expect(JSON.parse(result.run.summary_json)).toMatchObject({ reason: "workspace_changed_after_approval_request" });
    expect(called).toBe(false);
    database.close();
  });

  it("같은 멱등 키 재요청은 step을 다시 실행하지 않고 기존 run을 반환한다", async () => {
    const { database, dataDir, taskId } = fixture([{ kind: "contract", command: "npm test", required: true }]);
    let calls = 0;
    const service = new VerificationService(database, dataDir, "/home/user", async () => { calls += 1; return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 }; }, snapshotter);
    const first = await service.run(taskId, "same", 1) as any;
    const second = await service.run(taskId, "same", 1) as any;
    expect(second.run.id).toBe(first.run.id);
    expect(calls).toBe(1);
    database.close();
  });

  it("변경 경로와 일치하는 step만 실행하고 필수 step 생략 사유를 요약에 보존한다", async () => {
    const { database, dataDir, taskId } = fixture([
      { kind: "static", argv: ["always"], required: true },
      { kind: "focused_test", argv: ["source-test"], required: true, includePaths: ["src/**"], excludePaths: ["src/generated/**"] },
      { kind: "ui", argv: ["ui-test"], required: true, includePaths: ["web/**/*.tsx"] },
    ]);
    const calls: string[] = [];
    const service = new VerificationService(database, dataDir, "/home/user", async (argv) => {
      calls.push(argv[0]!);
      return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 };
    }, () => ({ commitHash: "a".repeat(40), diffHash: "b".repeat(64), changedFiles: ["src/main.ts", "src/generated/schema.ts", "README.md"] }));

    const result = await service.run(taskId, "path-selection", 1) as any;

    expect(result.run.state).toBe("passed");
    expect(calls).toEqual(["always", "source-test"]);
    expect(result.steps.map((step: any) => step.ordinal)).toEqual([1, 2]);
    expect(JSON.parse(result.run.summary_json).selection).toEqual({
      changedFileCount: 3,
      selected: [
        { ordinal: 1, kind: "static", reason: "unconditional" },
        { ordinal: 2, kind: "focused_test", reason: "changed_path_matched" },
      ],
      skipped: [{ ordinal: 3, kind: "ui", reason: "no_changed_path_matched" }],
    });
    const event = database.prepare("SELECT payload_json FROM agent_task_events WHERE task_id = ? AND type = 'verification.recipe_selected'").get(taskId) as { payload_json: string };
    expect(JSON.parse(event.payload_json).skipped).toEqual([{ ordinal: 3, kind: "ui", reason: "no_changed_path_matched" }]);
    database.close();
  });

  it("조건부 step이 모두 생략되면 검증 없이 task를 완료하지 않는다", async () => {
    const { database, dataDir, taskId } = fixture([{ kind: "focused_test", argv: ["test"], required: true, includePaths: ["src/**"] }]);
    let called = false;
    const service = new VerificationService(database, dataDir, "/home/user", async () => { called = true; throw new Error("호출 금지"); },
      () => ({ commitHash: "a".repeat(40), diffHash: "b".repeat(64), changedFiles: ["docs/guide.md"] }));

    const result = await service.run(taskId, "no-selected-step", 1) as any;

    expect(result.run.state).toBe("blocked");
    expect(JSON.parse(result.run.summary_json)).toMatchObject({ reason: "verification_no_steps_selected" });
    expect(called).toBe(false);
    expect(database.prepare("SELECT state FROM agent_tasks WHERE id = ?").get(taskId)).toEqual({ state: "needs_input" });
    database.close();
  });

  it("같은 commit·diff·profile에서 새 run으로 명시적 재검증하고 멱등 재요청은 실행하지 않는다", async () => {
    const { database, dataDir, taskId } = fixture([{ kind: "static", argv: ["check"], required: true }]);
    let calls = 0;
    const service = new VerificationService(database, dataDir, "/home/user", async () => {
      calls += 1;
      return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 };
    }, () => ({ commitHash: "a".repeat(40), diffHash: "b".repeat(64), changedFiles: ["src/a.ts"] }));
    const first = await service.run(taskId, "first-run", 1) as any;
    const second = await service.rerun(first.run.id, "rerun-1", 1) as any;
    const replay = await service.rerun(first.run.id, "rerun-1", 1) as any;

    expect(second.run).toMatchObject({ trigger: "reverification", source_run_id: first.run.id, state: "passed", profile_version_id: "profile-v1" });
    expect(second.run.id).not.toBe(first.run.id);
    expect(replay.run.id).toBe(second.run.id);
    expect(calls).toBe(2);
    database.close();
  });

  it("깨끗한 동일 commit의 PR check와 로컬 step이 모두 통과해야 같은 gate에서 완료한다", async () => {
    const { database, dataDir, taskId, chatId } = fixture([{ kind: "static", argv: ["check"] }]);
    const calls: number[] = [];
    const service = new VerificationService(
      database,
      dataDir,
      "/home/user",
      async () => ({ exitCode: 0, stdout: "local ok", stderr: "", durationMs: 1 }),
      () => ({ commitHash: "a".repeat(40), diffHash: "b".repeat(64), changedFiles: [], clean: true }),
      30,
      async (_cwd, number) => {
        calls.push(number);
        return { number, headSha: "a".repeat(40), state: "passed", totalCount: 2, passedCount: 2, failedCount: 0, pendingCount: 0, unavailableCount: 0 };
      },
    );

    const result = await service.run(taskId, "pr-pass", 1, { pullRequestNumber: 42 }) as any;

    expect(result.run).toMatchObject({ state: "passed", pull_request_number: 42, pull_request_head_sha: "a".repeat(40) });
    expect(JSON.parse(result.run.summary_json)).toMatchObject({
      local: { state: "passed" },
      pullRequest: { number: 42, state: "passed", totalCount: 2, passedCount: 2, reason: "pull_request_checks_passed" },
      result: "passed",
    });
    expect(JSON.parse(result.run.pull_request_checks_json)).not.toHaveProperty("checks");
    expect(calls).toEqual([42]);
    expect(database.prepare("SELECT state, state_reason FROM agent_tasks WHERE id = ?").get(taskId)).toEqual({ state: "completed", state_reason: "pull_request_checks_passed" });
    expect(service.currentForChat(chatId).task).toMatchObject({ id: taskId, profile_name: "profile", profile_version: 1, state: "completed" });
    database.close();
  });

  it.each([
    { checkState: "pending", headSha: "a".repeat(40), expectedRun: "blocked", expectedTask: "needs_input", reason: "pull_request_checks_pending" },
    { checkState: "failed", headSha: "a".repeat(40), expectedRun: "failed", expectedTask: "failed", reason: "pull_request_checks_failed" },
    { checkState: "unavailable", headSha: "a".repeat(40), expectedRun: "blocked", expectedTask: "needs_input", reason: "pull_request_checks_unavailable" },
    { checkState: "passed", headSha: "c".repeat(40), expectedRun: "blocked", expectedTask: "needs_input", reason: "pull_request_head_mismatch" },
  ])("PR check가 $checkState 이거나 head가 다르면 completed로 전환하지 않는다", async ({ checkState, headSha, expectedRun, expectedTask, reason }) => {
    const { database, dataDir, taskId } = fixture([{ kind: "static", argv: ["check"] }]);
    const service = new VerificationService(
      database,
      dataDir,
      "/home/user",
      async () => ({ exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 }),
      () => ({ commitHash: "a".repeat(40), diffHash: "b".repeat(64), changedFiles: [], clean: true }),
      30,
      async (_cwd, number) => ({
        number, headSha, state: checkState as "passed" | "failed" | "pending" | "unavailable", totalCount: 1,
        passedCount: checkState === "passed" ? 1 : 0, failedCount: checkState === "failed" ? 1 : 0,
        pendingCount: checkState === "pending" ? 1 : 0, unavailableCount: checkState === "unavailable" ? 1 : 0,
      }),
    );

    const result = await service.run(taskId, `pr-${checkState}-${reason}`, 1, { pullRequestNumber: 7 }) as any;

    expect(result.run.state).toBe(expectedRun);
    expect(JSON.parse(result.run.summary_json)).toMatchObject({ reason, local: { state: "passed" } });
    expect(database.prepare("SELECT state FROM agent_tasks WHERE id = ?").get(taskId)).toEqual({ state: expectedTask });
    database.close();
  });

  it("dirty workspace나 필수 PR 번호 누락은 PR check 없이 차단한다", async () => {
    const dirty = fixture([{ kind: "static", argv: ["check"] }]);
    let readerCalled = false;
    const dirtyService = new VerificationService(
      dirty.database, dirty.dataDir, "/home/user",
      async () => ({ exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 }),
      () => ({ commitHash: "a".repeat(40), diffHash: "b".repeat(64), changedFiles: ["src/a.ts"], clean: false }),
      30,
      async (_cwd, number) => { readerCalled = true; return { number, headSha: "a".repeat(40), state: "passed", totalCount: 1, passedCount: 1, failedCount: 0, pendingCount: 0, unavailableCount: 0 }; },
    );
    const dirtyRun = await dirtyService.run(dirty.taskId, "dirty-pr", 1, { pullRequestNumber: 9 }) as any;
    expect(JSON.parse(dirtyRun.run.summary_json).reason).toBe("pull_request_workspace_not_clean");
    expect(readerCalled).toBe(false);
    dirty.database.close();

    const required = fixture([{ kind: "static", argv: ["check"] }], { pullRequestChecks: { required: true } });
    let executorCalled = false;
    const requiredService = new VerificationService(required.database, required.dataDir, "/home/user", async () => {
      executorCalled = true;
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
    }, snapshotter);
    const missingRun = await requiredService.run(required.taskId, "required-pr", 1) as any;
    expect(JSON.parse(missingRun.run.summary_json)).toMatchObject({ reason: "pull_request_number_required", gate: { pullRequestChecksRequired: true } });
    expect(executorCalled).toBe(false);
    required.database.close();
  });

  it("PR 연결 재검증은 원본 번호를 계승하고 최신 check를 다시 읽는다", async () => {
    const { database, dataDir, taskId } = fixture([{ kind: "static", argv: ["check"] }]);
    let checks = 0;
    const service = new VerificationService(
      database, dataDir, "/home/user",
      async () => ({ exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 }),
      () => ({ commitHash: "a".repeat(40), diffHash: "b".repeat(64), changedFiles: [], clean: true }),
      30,
      async (_cwd, number) => { checks += 1; return { number, headSha: "a".repeat(40), state: "passed", totalCount: 1, passedCount: 1, failedCount: 0, pendingCount: 0, unavailableCount: 0 }; },
    );
    const first = await service.run(taskId, "pr-original", 1, { pullRequestNumber: 81 }) as any;
    const rerun = await service.rerun(first.run.id, "pr-rerun", 1) as any;
    expect(rerun.run).toMatchObject({ source_run_id: first.run.id, pull_request_number: 81, state: "passed" });
    expect(checks).toBe(2);
    database.close();
  });

  it("원본 run 이후 commit 또는 diff가 달라지면 새 재검증 run을 만들지 않는다", async () => {
    const { database, dataDir, taskId } = fixture([{ kind: "static", argv: ["check"], required: true }]);
    let diffHash = "b".repeat(64);
    const service = new VerificationService(database, dataDir, "/home/user", async () => ({ exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 }),
      () => ({ commitHash: "a".repeat(40), diffHash, changedFiles: ["src/a.ts"] }));
    const first = await service.run(taskId, "first-run", 1) as any;
    diffHash = "c".repeat(64);

    await expect(service.rerun(first.run.id, "rerun-changed", 1)).rejects.toThrow("동일 commit과 diff");
    expect(database.prepare("SELECT COUNT(*) AS count FROM verification_runs WHERE task_id = ?").get(taskId)).toEqual({ count: 1 });
    database.close();
  });

  it("shell 연산자가 든 command와 recipe 부재를 실행하지 않는다", async () => {
    const unsafe = fixture([{ kind: "static", command: "npm test; deploy", required: true }]);
    const service = new VerificationService(unsafe.database, unsafe.dataDir, "/home/user", async () => { throw new Error("호출되면 안 됨"); }, snapshotter);
    await expect(service.run(unsafe.taskId, "unsafe", 1)).rejects.toThrow("안전한 argv");
    expect(unsafe.database.prepare("SELECT COUNT(*) AS count FROM verification_runs").get()).toEqual({ count: 0 });
    unsafe.database.close();
  });

  it("중단된 running run을 재실행하지 않고 task 확인 필요 상태로 복구한다", () => {
    const { database, dataDir, taskId, projectPath } = fixture([{ kind: "static", argv: ["check"] }]);
    database.prepare("UPDATE agent_tasks SET state = 'verifying' WHERE id = ?").run(taskId);
    database.prepare("INSERT INTO verification_runs(id, task_id, idempotency_key, state) VALUES ('run-interrupted', ?, 'key', 'running')").run(taskId);
    database.prepare("INSERT INTO verification_steps(id, run_id, ordinal, kind, cwd, timeout_ms, state) VALUES ('step-interrupted', 'run-interrupted', 1, 'static', ?, 1000, 'running')").run(projectPath);
    const service = new VerificationService(database, dataDir, "/home/user", async () => { throw new Error("재실행 금지"); }, snapshotter);

    expect(service.recoverInterruptedRuns()).toBe(1);
    expect(database.prepare("SELECT state FROM verification_runs WHERE id = 'run-interrupted'").get()).toEqual({ state: "blocked" });
    expect(database.prepare("SELECT state FROM verification_steps WHERE id = 'step-interrupted'").get()).toEqual({ state: "blocked" });
    expect(database.prepare("SELECT state, state_reason FROM agent_tasks WHERE id = ?").get(taskId)).toEqual({ state: "needs_input", state_reason: "verification_restart_reconciliation_required" });
    expect(service.recoverInterruptedRuns()).toBe(0);
    database.close();
  });

  it("안전한 artifact만 hash·경로 재검증 후 다운로드 대상으로 반환한다", async () => {
    const { database, dataDir, taskId } = fixture([{ kind: "static", argv: ["check"] }]);
    const service = new VerificationService(database, dataDir, "/home/user", async () => ({ exitCode: 0, stdout: "safe", stderr: "", durationMs: 1 }), snapshotter);
    const run = await service.run(taskId, "artifact", 1) as any;
    const artifact = run.artifacts[0];
    const artifactPath = (database.prepare("SELECT path FROM verification_artifacts WHERE id = ?").get(artifact.id) as { path: string }).path;
    expect(artifact).not.toHaveProperty("path");
    expect(service.artifactForDownload(artifact.id)).toMatchObject({ path: artifactPath, mimeType: "text/plain" });
    fs.appendFileSync(artifactPath, "tampered");
    expect(() => service.artifactForDownload(artifact.id)).toThrow("hash가 일치하지 않습니다");
    database.prepare("UPDATE verification_artifacts SET redaction_status = 'blocked' WHERE id = ?").run(artifact.id);
    expect(() => service.artifactForDownload(artifact.id)).toThrow("redaction이 확인되지 않은");
    database.close();
  });

  it("private key가 감지된 출력은 redaction 후 별도 quarantine에 저장하고 다운로드를 막는다", async () => {
    const { database, dataDir, taskId } = fixture([{ kind: "static", argv: ["check"] }]);
    const privateKey = "-----BEGIN PRIVATE KEY-----\nvery-secret-material\n-----END PRIVATE KEY-----";
    const service = new VerificationService(database, dataDir, "/home/user", async () => ({ exitCode: 0, stdout: privateKey, stderr: "", durationMs: 1 }), snapshotter);
    const run = await service.run(taskId, "quarantine", 1) as any;
    const artifact = run.artifacts[0];
    const artifactPath = (database.prepare("SELECT path FROM verification_artifacts WHERE id = ?").get(artifact.id) as { path: string }).path;
    expect(artifact.redaction_status).toBe("blocked");
    expect(artifact).not.toHaveProperty("path");
    expect(artifactPath).toContain("verification-artifacts-quarantine");
    expect(run.run.state).toBe("blocked");
    expect(fs.readFileSync(artifactPath, "utf8")).toBe("[REDACTED PRIVATE KEY]");
    expect(() => service.artifactForDownload(artifact.id)).toThrow("redaction이 확인되지 않은");
    database.close();
  });

  it("보존 기간이 지난 관리 root 내부 artifact만 삭제하고 경로 이탈 행은 건너뛴다", async () => {
    const { database, dataDir, taskId } = fixture([{ kind: "static", argv: ["check"] }]);
    const service = new VerificationService(database, dataDir, "/home/user", async () => ({ exitCode: 0, stdout: "old", stderr: "", durationMs: 1 }), snapshotter, 7);
    const run = await service.run(taskId, "retention", 1) as any;
    const artifact = run.artifacts[0];
    const artifactPath = (database.prepare("SELECT path FROM verification_artifacts WHERE id = ?").get(artifact.id) as { path: string }).path;
    database.prepare("UPDATE verification_artifacts SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(artifact.id);
    const outside = path.join(dataDir, "outside.log");
    fs.writeFileSync(outside, "keep");
    database.prepare(`INSERT INTO verification_artifacts(id, run_id, path, sha256, mime_type, size_bytes, redaction_status, created_at) VALUES ('outside', ?, ?, ?, 'text/plain', 4, 'safe', '2026-01-01T00:00:00.000Z')`)
      .run(run.run.id, outside, "0".repeat(64));

    expect(service.cleanupExpiredArtifacts(new Date("2026-02-01T00:00:00.000Z"))).toEqual({ deleted: 1, skipped: 1 });
    expect(fs.existsSync(artifactPath)).toBe(false);
    expect(fs.readFileSync(outside, "utf8")).toBe("keep");
    expect(database.prepare("SELECT id FROM verification_artifacts ORDER BY id").all()).toEqual([{ id: "outside" }]);
    database.close();
  });
});

describe("verification artifact redaction", () => {
  it("Bearer, cookie, 비밀 환경변수와 홈 경로를 제거한다", () => {
    const result = redactVerificationOutput("Authorization: Bearer abc\nCookie=session\nMY_SECRET=value\n/home/person/file", "/home/person");
    expect(result).toEqual({ text: "Authorization: Bearer [REDACTED]\nCookie=[REDACTED]\nMY_SECRET=[REDACTED]\n$HOME/file", status: "safe" });
  });

  it("JWT와 알려진 credential은 치환하고 private key 출력은 quarantine 대상으로 표시한다", () => {
    expect(redactVerificationOutput("eyJabcdefghijk.abcdefghijk.abcdefghijk sk-abcdefghijklmnopqrstuvwxyz", "/home/user")).toEqual({
      text: "[REDACTED JWT] [REDACTED CREDENTIAL]", status: "safe",
    });
    expect(redactVerificationOutput("-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----", "/home/user")).toEqual({
      text: "[REDACTED PRIVATE KEY]", status: "blocked",
    });
  });

  it("Git HEAD, tracked diff와 untracked content를 하나의 재현 가능한 hash로 고정한다", () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), "wam-verification-git-"));
    roots.push(repository);
    execFileSync("git", ["init"], { cwd: repository });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repository });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repository });
    fs.writeFileSync(path.join(repository, "tracked.txt"), "one");
    execFileSync("git", ["add", "tracked.txt"], { cwd: repository });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repository });
    const clean = snapshotGitWorkspace(repository);
    fs.writeFileSync(path.join(repository, "tracked.txt"), "two");
    fs.writeFileSync(path.join(repository, "new.txt"), "alpha");
    const changed = snapshotGitWorkspace(repository);
    fs.writeFileSync(path.join(repository, "new.txt"), "beta");
    const untrackedChanged = snapshotGitWorkspace(repository);
    expect(changed.commitHash).toBe(clean.commitHash);
    expect(clean.clean).toBe(true);
    expect(changed.clean).toBe(false);
    expect(changed.changedFiles).toEqual(["new.txt", "tracked.txt"]);
    expect(changed.diffHash).not.toBe(clean.diffHash);
    expect(untrackedChanged.diffHash).not.toBe(changed.diffHash);
  });
});

describe("GitHub PR check rollup", () => {
  it("CheckRun과 StatusContext의 성공·실패·대기 상태를 보수적으로 집계한다", () => {
    const head = "a".repeat(40);
    expect(classifyPullRequestCheckRollup(3, head, [
      { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS", name: "build" },
      { __typename: "StatusContext", state: "SUCCESS", context: "policy" },
      { __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED", name: "optional" },
    ])).toMatchObject({ state: "passed", totalCount: 3, passedCount: 3 });
    expect(classifyPullRequestCheckRollup(3, head, [
      { status: "IN_PROGRESS", conclusion: "" }, { state: "SUCCESS" },
    ])).toMatchObject({ state: "pending", pendingCount: 1, passedCount: 1 });
    expect(classifyPullRequestCheckRollup(3, head, [
      { status: "IN_PROGRESS" }, { state: "FAILURE" }, { unexpected: true },
    ])).toMatchObject({ state: "failed", failedCount: 1, pendingCount: 1, unavailableCount: 1 });
    expect(classifyPullRequestCheckRollup(3, head, [])).toMatchObject({ state: "unavailable", totalCount: 0 });
  });
});
