import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import type { AppDatabase } from "../src/server/core/database";
import type { ApprovalService } from "../src/server/services/approval";
import type { UsageMonitor } from "../src/server/services/usage-monitor";
import type { SystemMetricsService } from "../src/server/services/system-metrics";
import type { SlackNotifier } from "../src/server/services/slack";
import type { NtfyNotifier } from "../src/server/services/ntfy";
import { createOperationsRouter } from "../src/server/routes/operations-routes";
import { CodexAdapter } from "../src/server/providers/codex";

let closeServer: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
});

// audit 기록 호출만 흉내 내고 나머지 쿼리는 no-op으로 응답한다.
function stubDatabase(): AppDatabase {
  return { prepare: () => ({ get: () => undefined, run: () => ({ changes: 0 }), all: () => [] }) } as unknown as AppDatabase;
}

// 지정 역할로 운영 API를 호출하는 테스트 앱을 만든다.
function buildApp(role: "admin" | "user" = "admin") {
  const app = express();
  app.use(express.json());
  app.use((request: any, _response, next) => { request.authUser = { id: 1, username: role, role }; next(); });
  app.use(createOperationsRouter(
    stubDatabase(),
    {} as ApprovalService,
    { list: () => [] } as unknown as UsageMonitor,
    { snapshot: () => ({ latest: null, recent: [] }) } as unknown as SystemMetricsService,
    { status: () => ({}) } as unknown as SlackNotifier,
    { status: () => ({}) } as unknown as NtfyNotifier,
    [new CodexAdapter()],
  ));
  // 실제 서버(index.ts)와 같은 오류 처리 규약: 던져진 Error 메시지를 400으로 변환한다.
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(400).json({ error: error instanceof Error ? error.message : "서버 오류가 발생했습니다." });
  });
  return app;
}

async function listen(app: express.Express): Promise<number> {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  closeServer = () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return (server.address() as AddressInfo).port;
}

describe("프로세스 종료 API 안전장치", () => {
  it("등록된 어댑터 기반 공급자 메타를 반환한다", async () => {
    const port = await listen(buildApp());
    const response = await fetch(`http://127.0.0.1:${port}/providers`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      providers: [{ id: "codex", label: "Codex", usageWindowId: "weekly", supportsPermissionMode: false }],
    });
  });

  it("일반 사용자의 Slack·ntfy 테스트 전송을 거부한다", async () => {
    const port = await listen(buildApp("user"));
    const [slack, ntfy] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/slack/test`, { method: "POST" }),
      fetch(`http://127.0.0.1:${port}/ntfy/test`, { method: "POST" }),
    ]);
    expect([slack.status, ntfy.status]).toEqual([403, 403]);
  });

  it("자기 자신(서버) 프로세스는 종료를 거부한다", async () => {
    const port = await listen(buildApp());
    const response = await fetch(`http://127.0.0.1:${port}/system/processes/${process.pid}/kill`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force: false }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("자신");
  });

  it("pid 1(init)은 종료를 거부한다", async () => {
    const port = await listen(buildApp());
    const response = await fetch(`http://127.0.0.1:${port}/system/processes/1/kill`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force: false }),
    });
    expect(response.status).toBe(400);
  });

  it("존재하지 않는 프로세스는 이미 종료된 것으로 안내한다", async () => {
    const port = await listen(buildApp());
    // 실제 시스템에 없을 만한 매우 큰 pid를 사용한다.
    const response = await fetch(`http://127.0.0.1:${port}/system/processes/999999999/kill`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force: false }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("이미 종료");
  });
});
