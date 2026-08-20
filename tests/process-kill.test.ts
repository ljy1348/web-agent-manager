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
import type { IdleChatReaper } from "../src/server/services/idle-chat-reaper";

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
function buildApp(
  role: "admin" | "user" = "admin",
  readVersion: (command: string, args: string[]) => Promise<string | null> = async (command) => `${command} 1.0.0`,
  metricsSnapshot: unknown = { latest: null, recent: [] },
  trustedNetwork = true,
  usageMonitor = { list: () => [] } as unknown as UsageMonitor,
) {
  const app = express();
  app.use(express.json());
  app.use((request: any, _response, next) => { request.authUser = { id: 1, username: role, role }; request.trustedNetwork = trustedNetwork; next(); });
  app.use(createOperationsRouter(
    stubDatabase(),
    {} as ApprovalService,
    usageMonitor,
    { snapshot: () => metricsSnapshot } as unknown as SystemMetricsService,
    { status: () => ({}) } as unknown as SlackNotifier,
    { status: () => ({}) } as unknown as NtfyNotifier,
    [new CodexAdapter()],
    { settings: () => ({ enabled: true, timeoutHours: 24 }) } as unknown as IdleChatReaper,
    readVersion,
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

describe("초기화권 사용 API 안전장치", () => {
  it("관리자는 Codex 초기화권 사용 결과를 받는다", async () => {
    const calls: string[] = [];
    const usage = {
      list: () => [],
      redeemResetCredit: async (provider: string, accountId?: number) => {
        calls.push(`${provider}:${accountId}`);
        return { outcome: "reset", before: { availableCount: 1, expiresAt: null }, after: { availableCount: 0, expiresAt: null } };
      },
    } as unknown as UsageMonitor;
    const port = await listen(buildApp("admin", undefined, undefined, true, usage));
    const response = await fetch(`http://127.0.0.1:${port}/usage/codex/reset-credit/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: 7 }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ outcome: "reset", credits: { availableCount: 0, expiresAt: null } });
    expect(calls).toEqual(["codex:7"]);
  });

  it("일반 사용자는 초기화권 사용을 거부한다", async () => {
    const usage = { list: () => [], redeemResetCredit: async () => { throw new Error("호출되면 안 됩니다."); } } as unknown as UsageMonitor;
    const port = await listen(buildApp("user", undefined, undefined, true, usage));
    const response = await fetch(`http://127.0.0.1:${port}/usage/codex/reset-credit/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: 7 }),
    });

    expect(response.status).toBe(403);
  });

  it("서비스의 잔여량·중복 사용 오류를 API 오류로 전달한다", async () => {
    const usage = { list: () => [], redeemResetCredit: async () => { throw new Error("Codex 초기화권을 이미 사용 중입니다."); } } as unknown as UsageMonitor;
    const port = await listen(buildApp("admin", undefined, undefined, true, usage));
    const response = await fetch(`http://127.0.0.1:${port}/usage/codex/reset-credit/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: 7 }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Codex 초기화권을 이미 사용 중입니다." });
  });

  it("계정 ID가 없으면 초기화권 사용을 거부한다", async () => {
    const usage = { list: () => [], redeemResetCredit: async () => { throw new Error("호출되면 안 됩니다."); } } as unknown as UsageMonitor;
    const port = await listen(buildApp("admin", undefined, undefined, true, usage));
    const response = await fetch(`http://127.0.0.1:${port}/usage/codex/reset-credit/redeem`, { method: "POST" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "유효한 Codex 계정을 지정해주세요." });
  });
});

describe("프로세스 종료 API 안전장치", () => {
  it("등록된 어댑터 기반 공급자 메타를 반환한다", async () => {
    const port = await listen(buildApp());
    const response = await fetch(`http://127.0.0.1:${port}/providers`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      providers: [{ id: "codex", label: "Codex", usageWindowId: "weekly", supportsPermissionMode: false }],
    });
  });

  it("런타임 버전은 서버 시작 시 한 번만 조회하고 반복 요청에서 재사용한다", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const port = await listen(buildApp("admin", async (command, args) => {
      calls.push({ command, args });
      return `${command} 1.0.0`;
    }));

    const first = await fetch(`http://127.0.0.1:${port}/runtime`);
    const second = await fetch(`http://127.0.0.1:${port}/runtime`);

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(calls.map((call) => call.command).sort()).toEqual(["codex", "gh", "git", "tmux"]);
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

  it("시스템 묶음으로 분류된 프로세스는 종료를 거부한다", async () => {
    // 화면에서 버튼을 숨겨도 API를 직접 부르는 경로가 남아 서버에서도 막는다.
    const snapshot = {
      latest: { processes: [{ pid: 424242, name: "node", cpu: 0, memory: 0, chat: null, group: { kind: "system", key: "system", label: "web-agent-manager 시스템" } }] },
      recent: [],
    };
    const port = await listen(buildApp("admin", undefined, snapshot));

    const response = await fetch(`http://127.0.0.1:${port}/system/processes/424242/kill`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force: false }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "web-agent-manager 시스템 프로세스는 대시보드에서 종료할 수 없습니다." });
  });

  it("채팅 묶음 프로세스는 시스템 보호에 걸리지 않는다", async () => {
    const snapshot = {
      latest: { processes: [{ pid: 999999999, name: "claude", cpu: 0, memory: 0, chat: null, group: { kind: "chat", key: "chat:1", label: "프로젝트 · 채팅" } }] },
      recent: [],
    };
    const port = await listen(buildApp("admin", undefined, snapshot));

    const response = await fetch(`http://127.0.0.1:${port}/system/processes/999999999/kill`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force: false }),
    });

    // 보호에 막히지 않고 실제 종료 시도까지 가서 "이미 종료된 프로세스" 안내가 나와야 한다.
    await expect(response.json()).resolves.toMatchObject({ error: "이미 종료된 프로세스입니다." });
  });

  it("외부 네트워크에서는 프로세스 종료를 거부한다", async () => {
    // 되돌릴 수 없는 작업이라 내부망에서만 허용한다(파일 탭의 민감 경로 정책과 같은 기준).
    const port = await listen(buildApp("admin", undefined, { latest: null, recent: [] }, false));

    const response = await fetch(`http://127.0.0.1:${port}/system/processes/999999999/kill`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force: false }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "되돌릴 수 없는 작업은 내부망에서만 할 수 있습니다." });
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
