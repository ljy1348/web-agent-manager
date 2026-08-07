import type { AgentAccountService } from "../src/server/services/agent-accounts";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import type { AppDatabase } from "../src/server/core/database";
import type { AppConfig } from "../src/server/core/config";
import type { SessionManager } from "../src/server/services/session-manager";
import { ClaudeAdapter } from "../src/server/providers/claude";
import { HistoryCache } from "../src/server/services/history-cache";
import { createProjectRouter } from "../src/server/routes/project-routes";

let closeServer: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
});

// 10턴짜리 세션 JSONL을 만들어 커서 페이지네이션이 DB 없이도 정확히 동작하는지 검증한다.
function writeFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-pagination-"));
  const file = path.join(dir, "session.jsonl");
  const lines = Array.from({ length: 10 }, (_, index) => ({
    type: index % 2 === 0 ? "user" : "assistant",
    sessionId: "s1",
    cwd: "/home/testuser/web-agent-manager",
    message: { content: `turn-${index}` },
    timestamp: `2026-07-07T00:00:${String(index).padStart(2, "0")}.000Z`,
  }));
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"));
  return file;
}

function stubDatabase(historyFile: string): AppDatabase {
  return {
    prepare: (sql: string) => {
      if (sql.includes("SELECT provider, history_file FROM chats")) return { get: () => ({ provider: "claude", history_file: historyFile }) };
      return { get: () => undefined, run: () => ({ changes: 0 }), all: () => [] };
    },
  } as unknown as AppDatabase;
}

describe("메시지 커서 페이지네이션 API", () => {
  it("DB 없이 JSONL을 직접 읽어 최근 구간과 이전 구간을 정확히 반환한다", async () => {
    const historyFile = writeFixture();
    const app = express();
    app.use((request: any, _response, next) => { request.authUser = { id: 1, username: "tester", role: "admin" }; next(); });
    app.use(createProjectRouter(stubDatabase(historyFile), {} as AppConfig, {} as SessionManager, [new ClaudeAdapter("", {})], {} as AgentAccountService, new HistoryCache()));
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    closeServer = () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const first = await (await fetch(`${base}/chats/1/messages?limit=4`)).json();
    expect(first.messages.map((message: any) => message.content)).toEqual(["turn-6", "turn-7", "turn-8", "turn-9"]);
    expect(first.hasMore).toBe(true);

    const oldestId = first.messages[0].id;
    const second = await (await fetch(`${base}/chats/1/messages?limit=4&before=${oldestId}`)).json();
    expect(second.messages.map((message: any) => message.content)).toEqual(["turn-2", "turn-3", "turn-4", "turn-5"]);
    expect(second.hasMore).toBe(true);
  });
});
