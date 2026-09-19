import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import type { AppDatabase } from "../src/server/core/database";
import { createVerificationRouter } from "../src/server/routes/verification-routes";
import type { VerificationService } from "../src/server/services/verification-service";

let closeServer: (() => Promise<void>) | undefined;
afterEach(async () => { await closeServer?.(); closeServer = undefined; });

async function serve(identity: "admin" | "user" | "tester", service: Pick<VerificationService, "run" | "list">): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((request: any, _response, next) => {
    request.authUser = { id: 1, username: identity, role: identity === "admin" ? "admin" : "user", access_scope: identity === "tester" ? "test_only" : "standard" };
    next();
  });
  const database = { prepare: () => ({ run: () => ({ changes: 1 }) }) } as unknown as AppDatabase;
  app.use(createVerificationRouter(database, service as VerificationService));
  app.use((error: unknown, _request: any, response: any, _next: any) => response.status(400).json({ error: error instanceof Error ? error.message : String(error) }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  closeServer = () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("verification routes", () => {
  it("관리자 요청의 Idempotency-Key와 task를 service에 전달한다", async () => {
    const calls: unknown[] = [];
    const base = await serve("admin", {
      run: async (...args: unknown[]) => { calls.push(args); return { run: { id: "v", state: "passed" } }; },
      list: () => [],
    } as never);
    const response = await fetch(`${base}/tasks/task-1/verifications`, { method: "POST", headers: { "Idempotency-Key": "verify-key" } });
    expect(response.status).toBe(202);
    expect(calls).toEqual([["task-1", "verify-key", 1, { pullRequestNumber: undefined }]]);
  });

  it("PR 번호를 검증해 service에 전달한다", async () => {
    const calls: unknown[] = [];
    const base = await serve("admin", {
      run: async (...args: unknown[]) => { calls.push(args); return { run: { id: "v", state: "blocked" } }; },
      list: () => [],
    } as never);
    const response = await fetch(`${base}/tasks/task-1/verifications`, {
      method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": "verify-pr" }, body: JSON.stringify({ pullRequestNumber: 17 }),
    });
    expect(response.status).toBe(202);
    expect(calls).toEqual([["task-1", "verify-pr", 1, { pullRequestNumber: 17 }]]);
  });

  it("tester는 일반 검증과 재검증만 실행하고 live/human 결정은 할 수 없다", async () => {
    const calls: unknown[] = [];
    const base = await serve("tester", {
      run: async (...args: unknown[]) => { calls.push(["run", ...args]); return { run: { id: "v", state: "passed" } }; },
      list: () => [],
      rerun: async (...args: unknown[]) => { calls.push(["rerun", ...args]); return { run: { id: "v2", state: "passed" } }; },
      decideBlockedRun: async (...args: unknown[]) => { calls.push(["decision", ...args]); return { run: { id: "v", state: "passed" } }; },
    } as never);
    expect((await fetch(`${base}/tasks/task-1/verifications`, { method: "POST", headers: { "Idempotency-Key": "tester-run" } })).status).toBe(202);
    expect((await fetch(`${base}/verifications/v/rerun`, { method: "POST", headers: { "Idempotency-Key": "tester-rerun" } })).status).toBe(202);
    expect((await fetch(`${base}/verifications/v/decision`, {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "tester-decision" }, body: JSON.stringify({ decision: "approve" }),
    })).status).toBe(403);
    expect(calls.map((call: any) => call[0])).toEqual(["run", "rerun"]);
  });

  it("멱등 키가 없거나 일반 사용자의 실행 요청이면 거부한다", async () => {
    let called = false;
    const service = { run: async () => { called = true; return {}; }, list: () => [] } as never;
    const admin = await serve("admin", service);
    expect((await fetch(`${admin}/tasks/t/verifications`, { method: "POST" })).status).toBe(400);
    await closeServer?.(); closeServer = undefined;
    const user = await serve("user", service);
    expect((await fetch(`${user}/tasks/t/verifications`, { method: "POST", headers: { "Idempotency-Key": "key" } })).status).toBe(403);
    expect(called).toBe(false);
  });

  it("저장된 검증 timeline을 조회한다", async () => {
    const base = await serve("user", { run: async () => ({}), list: (taskId: string) => [{ run: { task_id: taskId } }] } as never);
    const response = await fetch(`${base}/tasks/task-9/verifications`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ verifications: [{ run: { task_id: "task-9" } }] });
  });

  it("timeline 조회 개수를 1~100 범위로 제한한다", async () => {
    const calls: unknown[] = [];
    const base = await serve("user", { run: async () => ({}), list: (...args: unknown[]) => { calls.push(args); return []; } } as never);
    expect((await fetch(`${base}/tasks/task-9/verifications?limit=17`)).status).toBe(200);
    expect(calls).toEqual([["task-9", 17]]);
    expect((await fetch(`${base}/tasks/task-9/verifications?limit=101`)).status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it("채팅의 최신 task와 검증 timeline을 함께 조회한다", async () => {
    const calls: number[] = [];
    const base = await serve("user", {
      run: async () => ({}),
      list: () => [],
      currentForChat: (chatId: number) => { calls.push(chatId); return { task: { id: "task-current" }, verifications: [] }; },
    } as never);
    const response = await fetch(`${base}/chats/12/current-task`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ task: { id: "task-current" }, verifications: [] });
    expect(calls).toEqual([12]);
  });

  it("live/human 결정도 관리자 멱등 키와 명시적 approve/decline만 전달한다", async () => {
    const calls: unknown[] = [];
    const base = await serve("admin", {
      run: async () => ({}),
      list: () => [],
      decideBlockedRun: async (...args: unknown[]) => { calls.push(args); return { run: { id: "run-1", state: "passed" } }; },
    } as never);
    const response = await fetch(`${base}/verifications/run-1/decision`, {
      method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": "decision-key" },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(response.status).toBe(200);
    expect(calls).toEqual([["run-1", "approve", "decision-key", 1]]);
  });

  it("원본 run과 관리자 멱등 키를 명시적 재검증에 전달한다", async () => {
    const calls: unknown[] = [];
    const base = await serve("admin", {
      run: async () => ({}),
      list: () => [],
      rerun: async (...args: unknown[]) => { calls.push(args); return { run: { id: "run-2", state: "passed" } }; },
    } as never);
    const response = await fetch(`${base}/verifications/run-1/rerun`, { method: "POST", headers: { "Idempotency-Key": "rerun-key" } });
    expect(response.status).toBe(202);
    expect(calls).toEqual([["run-1", "rerun-key", 1]]);
  });
});
