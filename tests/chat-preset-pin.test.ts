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
    const audit = database.prepare("SELECT details FROM audit_logs WHERE action = 'chat.create'").get() as { details: string };
    expect(JSON.parse(audit.details)).toMatchObject({ projectId, provider: "codex", profileVersionId: versionId });
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
    const audit = database.prepare("SELECT details FROM audit_logs WHERE action = 'chat.create'").get() as { details: string };
    expect(JSON.parse(audit.details)).toMatchObject({ profileVersionId: null });
  });
});

describe("프로젝트 profile API", () => {
  it("미저장 초안을 검토한 뒤 draft/version/activation을 명시적으로 진행한다", async () => {
    const { base, database, projectId } = await startServer();
    const projectPath = (database.prepare("SELECT path FROM projects WHERE id = ?").get(projectId) as { path: string }).path;
    fs.writeFileSync(path.join(projectPath, "AGENTS.md"), "rules");
    fs.writeFileSync(path.join(projectPath, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));

    const draftResponse = await fetch(`${base}/projects/${projectId}/profile-draft`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "codex", taskKind: "analysis" }),
    });
    expect(draftResponse.status).toBe(200);
    const draft = (await draftResponse.json() as any).draft;
    expect(draft.configSnapshot).toMatchObject({ taskKind: "analysis", runtime: { provider: "codex" }, permissions: { sandbox: "read-only" } });
    expect(database.prepare("SELECT COUNT(*) AS count FROM agent_presets").get()).toEqual({ count: 0 });

    const createResponse = await fetch(`${base}/projects/${projectId}/profiles`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "분석", taskKind: "analysis", configSnapshot: draft.configSnapshot }),
    });
    expect(createResponse.status).toBe(201);
    const profile = (await createResponse.json() as any).profile;
    expect(profile).toMatchObject({ status: "draft", activeVersion: null, taskKind: "analysis" });

    const versionResponse = await fetch(`${base}/projects/${projectId}/profiles/${profile.id}/versions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ configSnapshot: { ...draft.configSnapshot, runtime: { provider: "codex", model: "gpt-next" } } }),
    });
    expect(versionResponse.status).toBe(201);
    const versioned = (await versionResponse.json() as any).profile;
    expect(versioned.versions.map((version: any) => version.version)).toEqual([2, 1]);

    const activateResponse = await fetch(`${base}/projects/${projectId}/profiles/${profile.id}/activate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ versionId: versioned.versions[0].id }),
    });
    expect(activateResponse.status).toBe(200);
    await expect(activateResponse.json()).resolves.toMatchObject({ profile: { status: "active", activeVersion: 2 } });

    const list = await fetch(`${base}/projects/${projectId}/profiles`);
    await expect(list.json()).resolves.toMatchObject({ profiles: [{ id: profile.id, taskKind: "analysis", activeVersion: 2 }] });
    expect(database.prepare("SELECT action FROM audit_logs ORDER BY id").all()).toEqual([
      { action: "project.profile_create" }, { action: "project.profile_version_create" }, { action: "project.profile_activate" },
    ]);
  });

  it("taskKind만 지정한 새 채팅이 해당 프로젝트의 활성 profile version을 자동 pin한다", async () => {
    const { base, database, projectId } = await startServer();
    const create = await fetch(`${base}/projects/${projectId}/profiles`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "일반 구현", taskKind: "implementation", configSnapshot: { runtime: { provider: "codex", model: "profile-model" } } }),
    });
    const profile = (await create.json() as any).profile;
    await fetch(`${base}/projects/${projectId}/profiles/${profile.id}/activate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ versionId: profile.versions[0].id }),
    });

    const created = await (await fetch(`${base}/chats`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, provider: "codex", taskKind: "implementation" }),
    })).json() as any;
    const chat = database.prepare("SELECT preset_version_id AS versionId, model, preset_config_json AS config FROM chats WHERE id = ?").get(created.chat.id) as any;
    expect(chat.versionId).toBe(profile.versions[0].id);
    expect(chat.model).toBe("profile-model");
    expect(JSON.parse(chat.config).taskKind).toBe("implementation");
  });
});
