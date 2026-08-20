import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express, { type Request, type Response, type NextFunction } from "express";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import type { AppConfig } from "../src/server/core/config";
import type { AgentAccountService } from "../src/server/services/agent-accounts";
import type { SessionManager } from "../src/server/services/session-manager";
import { HistoryCache } from "../src/server/services/history-cache";
import { createProjectRouter } from "../src/server/routes/project-routes";

let closeServer: (() => Promise<void>) | undefined;
const cleanup: Array<() => void> = [];

afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
  while (cleanup.length) cleanup.pop()?.();
});

// preset을 고른 채팅 생성만 검증할 최소 서버를 띄운다. 세션은 실제로 시작하지 않는다.
async function startServer(): Promise<{ base: string; database: AppDatabase; projectId: number }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-chat-preset-"));
  const dataDir = path.join(root, "data");
  const projectPath = path.join(root, "project");
  fs.mkdirSync(projectPath, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const config: AppConfig = {
    rootDir: root, homeDir: root, dataDir, host: "127.0.0.1", port: 0,
    publicUrl: "http://127.0.0.1:0", allowedRoots: [root], sessionTtlHours: 1,
    runtimeEnabled: false, slack: {}, ntfy: { serverUrl: "https://ntfy.sh" },
  };
  const database = openDatabase(config);
  database.prepare("INSERT INTO users(id, username, password_hash, role) VALUES (1, 'admin', 'hash', 'admin')").run();
  const projectId = Number(database.prepare("INSERT INTO projects(name, path) VALUES ('샘플', ?)").run(projectPath).lastInsertRowid);
  cleanup.push(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const accounts = {
    requireForProvider: (provider: string) => ({ id: 1, provider, label: "기본", config_dir: null }),
  } as unknown as AgentAccountService;
  const sessions = { start: () => undefined } as unknown as SessionManager;

  const app = express();
  app.use(express.json());
  app.use((request: Request & { authUser?: unknown; trustedNetwork?: boolean }, _response, next) => {
    request.authUser = { id: 1, username: "admin", role: "admin" };
    request.trustedNetwork = true;
    next();
  });
  app.use(createProjectRouter(database, config, sessions, [
    { id: "codex", displayLabel: "Codex" }, { id: "claude", displayLabel: "Claude" },
  ] as never, accounts, new HistoryCache()));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  closeServer = () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, database, projectId };
}

// 승격된 preset과 그 버전을 직접 만든다.
function createPreset(database: AppDatabase, projectId: number, model: string, provider = "codex"): { presetId: string; versionId: string } {
  const presetId = `preset-${model}`;
  const versionId = `version-${model}`;
  database.prepare("INSERT INTO agent_presets(id, project_id, name, status, active_version) VALUES (?, ?, ?, 'active', 1)")
    .run(presetId, projectId, `우승-${model}`);
  database.prepare("INSERT INTO agent_preset_versions(id, preset_id, version, config_snapshot_json) VALUES (?, ?, 1, ?)")
    .run(versionId, presetId, JSON.stringify({ schemaVersion: 1, runtime: { provider, model, reasoningEffort: "high" } }));
  return { presetId, versionId };
}

describe("채팅의 Agent preset 버전 고정", () => {
  it("선택한 preset 버전의 설정 스냅샷을 채팅에 복사해 고정한다", async () => {
    const { base, database, projectId } = await startServer();
    const { presetId, versionId } = createPreset(database, projectId, "gpt-winner");

    const created = await (await fetch(`${base}/chats`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, provider: "codex", presetId }),
    })).json();

    const row = database.prepare("SELECT preset_version_id AS versionId, preset_config_json AS config, model FROM chats WHERE id = ?")
      .get(created.chat.id) as { versionId: string; config: string; model: string };
    expect(row.versionId).toBe(versionId);
    expect(row.model).toBe("gpt-winner");
    expect(JSON.parse(row.config).runtime.model).toBe("gpt-winner");
  });

  it("나중에 preset의 활성 버전이 바뀌어도 이미 시작한 채팅은 그대로 남는다", async () => {
    const { base, database, projectId } = await startServer();
    const { presetId } = createPreset(database, projectId, "gpt-v1");

    const created = await (await fetch(`${base}/chats`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, provider: "codex", presetId }),
    })).json();

    // v2를 승격해 활성 버전을 바꾼다.
    database.prepare("INSERT INTO agent_preset_versions(id, preset_id, version, config_snapshot_json) VALUES ('version-v2', ?, 2, ?)")
      .run(presetId, JSON.stringify({ schemaVersion: 1, runtime: { provider: "codex", model: "gpt-v2" } }));
    database.prepare("UPDATE agent_presets SET active_version = 2 WHERE id = ?").run(presetId);

    const row = database.prepare("SELECT preset_config_json AS config, model FROM chats WHERE id = ?")
      .get(created.chat.id) as { config: string; model: string };
    expect(row.model).toBe("gpt-v1");
    expect(JSON.parse(row.config).runtime.model).toBe("gpt-v1");
  });

  it("공급자가 다른 preset과 다른 프로젝트의 preset을 거부한다", async () => {
    const { base, database, projectId } = await startServer();
    const { presetId } = createPreset(database, projectId, "claude-only", "claude");

    const mismatch = await fetch(`${base}/chats`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, provider: "codex", presetId }),
    });
    expect(mismatch.status).toBe(400);
    expect((await mismatch.json()).error).toContain("claude 전용");

    const otherProject = Number(database.prepare("INSERT INTO projects(name, path) VALUES ('다른', '/tmp/other')").run().lastInsertRowid);
    const other = createPreset(database, otherProject, "gpt-other");
    const crossProject = await fetch(`${base}/chats`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, provider: "codex", presetId: other.presetId }),
    });
    expect(crossProject.status).toBe(400);
    expect((await crossProject.json()).error).toContain("다른 프로젝트");
  });

  it("preset을 고르지 않으면 고정 없이 기존처럼 만든다", async () => {
    const { base, database, projectId } = await startServer();
    const created = await (await fetch(`${base}/chats`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, provider: "codex" }),
    })).json();
    const row = database.prepare("SELECT preset_version_id AS versionId FROM chats WHERE id = ?")
      .get(created.chat.id) as { versionId: string | null };
    expect(row.versionId).toBeNull();
  });
});
