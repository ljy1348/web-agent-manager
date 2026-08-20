import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_SKILL_NAMES } from "../src/server/services/agent-skill-installer";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import type { ProviderAdapter } from "../src/server/providers/provider";
import { AgentBridge } from "../src/server/services/agent-bridge";
import { installProjectAgentSkills } from "../src/server/services/agent-skill-installer";
import type { HistoryCache } from "../src/server/services/history-cache";
import type { SessionManager } from "../src/server/services/session-manager";

const temporaryRoots: string[] = [];

// 테스트용 프로젝트·데이터 경로를 만들고 종료 시 정리 목록에 넣는다.
function createRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

// 실제 스키마가 적용된 임시 데이터베이스를 연다.
function createDatabase(dataDir: string): AppDatabase {
  return openDatabase({
    rootDir: dataDir,
    dataDir,
    homeDir: dataDir,
    host: "127.0.0.1",
    port: 0,
    publicUrl: "",
    allowedRoots: ["/"],
    sessionTtlHours: 1,
    runtimeEnabled: false,
    slack: {},
    ntfy: { serverUrl: "https://ntfy.sh" },
  });
}

// Unix 소켓으로 브리지 요청 한 건을 보내 구조화 응답을 받는다.
async function socketCall(socketPath: string, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const socket = net.createConnection(socketPath);
  socket.setEncoding("utf8");
  await once(socket, "connect");
  socket.write(`${JSON.stringify({ id: "test", method, params })}\n`);
  const [chunk] = await once(socket, "data") as [string];
  socket.end();
  return JSON.parse(chunk.trim()) as Record<string, unknown>;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("로컬 에이전트 브리지", () => {
  it("채팅 번호의 문맥을 읽고 동일 키 작업 전달을 한 번만 전송한다", async () => {
    const dataDir = createRoot("web-agent-manager-bridge-data-");
    const projectPath = createRoot("web-agent-manager-bridge-project-");
    const database = createDatabase(dataDir);
    database.prepare("INSERT INTO projects(id, name, path) VALUES (1, 'sample', ?)").run(projectPath);
    database.prepare(`
      INSERT INTO chats(id, project_id, provider, provider_session_id, tmux_name, status, title, history_file, busy)
      VALUES (160, 1, 'codex', 'codex-session', 'web_agent_manager_chat_160', 'running', '원본 작업', 'codex.jsonl', 1)
    `).run();
    database.prepare(`
      INSERT INTO chats(id, project_id, provider, provider_session_id, tmux_name, status, title, history_file, busy)
      VALUES (163, 1, 'claude', 'claude-session', 'web_agent_manager_chat_163', 'running', '마무리 작업', 'claude.jsonl', 0)
    `).run();
    const sent: Array<{ chatId: number; text: string }> = [];
    const sessions = {
      start: () => undefined,
      sendPrompt: async (chatId: number, text: string) => { sent.push({ chatId, text }); },
    } as unknown as Pick<SessionManager, "start" | "sendPrompt">;
    const historyCache = {
      get: (_adapter: ProviderAdapter, file: string) => ({
        messages: file.startsWith("codex")
          ? [{ id: "m1", role: "assistant", kind: "message", content: "보안 검증까지 완료", createdAt: "2026-07-31T00:00:00Z" }]
          : [],
      }),
    } as unknown as HistoryCache;
    const adapters = [
      { id: "codex", displayLabel: "Codex" },
      { id: "claude", displayLabel: "Claude" },
    ] as unknown as ProviderAdapter[];
    const bridge = new AgentBridge({
      database,
      adapters,
      historyCache,
      sessions,
      socketPath: path.join(dataDir, "web-agent-manager-agent.sock"),
    });

    const context = await bridge.execute({ method: "context.get", params: { chatId: 160 } }) as {
      chat: { id: number; busy: boolean };
      messages: Array<{ content: string }>;
    };
    const first = await bridge.execute({
      method: "delegation.send",
      params: {
        sourceChatId: 160,
        targetChatId: 163,
        prompt: "#160의 남은 작업을 마무리하세요.",
        idempotencyKey: "160-to-163",
      },
    }) as { delegation: { id: string; status: string } };
    const duplicate = await bridge.execute({
      method: "delegation.send",
      params: {
        sourceChatId: 160,
        targetChatId: 163,
        prompt: "#160의 남은 작업을 마무리하세요.",
        idempotencyKey: "160-to-163",
      },
    }) as { duplicate: boolean };
    const circular = bridge.execute({
      method: "delegation.send",
      params: {
        sourceChatId: 163,
        targetChatId: 160,
        parentDelegationId: first.delegation.id,
        prompt: "원본 채팅으로 다시 넘깁니다.",
        idempotencyKey: "163-back-to-160",
      },
    });

    expect(context.chat).toMatchObject({ id: 160, busy: true });
    expect(context.messages[0]?.content).toBe("보안 검증까지 완료");
    expect(first.delegation.status).toBe("sent");
    expect(duplicate.duplicate).toBe(true);
    await expect(circular).rejects.toThrow("조상 채팅으로 작업을 다시 전달할 수 없습니다.");
    expect(sent).toEqual([{ chatId: 163, text: "#160의 남은 작업을 마무리하세요." }]);
    database.close();
  });

  it("createNew 위임은 같은 공급자의 기존 채팅 대신 새 자식 채팅을 만든다", async () => {
    const dataDir = createRoot("web-agent-manager-bridge-data-");
    const projectPath = createRoot("web-agent-manager-bridge-project-");
    const database = createDatabase(dataDir);
    database.prepare("INSERT INTO projects(id, name, path) VALUES (1, 'sample', ?)").run(projectPath);
    database.prepare(`
      INSERT INTO chats(id, project_id, provider, tmux_name, status, title)
      VALUES (1, 1, 'codex', 'web_agent_manager_chat_1', 'running', '부모 작업')
    `).run();
    database.prepare(`
      INSERT INTO chats(id, project_id, provider, tmux_name, status, title)
      VALUES (2, 1, 'claude', 'web_agent_manager_chat_2', 'running', '기존 Claude 채팅')
    `).run();
    const started: number[] = [];
    const sent: Array<{ chatId: number; text: string }> = [];
    const bridge = new AgentBridge({
      database,
      adapters: [
        { id: "codex", displayLabel: "Codex" },
        { id: "claude", displayLabel: "Claude" },
      ] as unknown as ProviderAdapter[],
      historyCache: {} as HistoryCache,
      sessions: {
        start: (chatId: number) => { started.push(chatId); },
        sendPrompt: async (chatId: number, text: string) => { sent.push({ chatId, text }); },
      } as unknown as Pick<SessionManager, "start" | "sendPrompt">,
      socketPath: path.join(dataDir, "web-agent-manager-agent.sock"),
    });

    const result = await bridge.execute({
      method: "delegation.send",
      params: {
        sourceChatId: 1,
        projectId: 1,
        provider: "claude",
        prompt: "별도 세션에서 검증하세요.",
        idempotencyKey: "new-claude-child",
        createNew: true,
      },
    }) as { delegation: { target_chat_id: number; status: string } };

    expect(result.delegation).toMatchObject({ status: "sent" });
    expect(result.delegation.target_chat_id).not.toBe(2);
    expect(started).toEqual([result.delegation.target_chat_id]);
    expect(sent).toEqual([{ chatId: result.delegation.target_chat_id, text: "별도 세션에서 검증하세요." }]);
    database.close();
  });

  it("장문 첨부로 바뀐 실제 전달 문구 뒤의 완료 응답을 회수한다", async () => {
    const dataDir = createRoot("web-agent-manager-bridge-wait-data-");
    const projectPath = createRoot("web-agent-manager-bridge-wait-project-");
    const database = createDatabase(dataDir);
    database.prepare("INSERT INTO projects(id, name, path) VALUES (1, 'sample', ?)").run(projectPath);
    database.prepare(`
      INSERT INTO chats(id, project_id, provider, tmux_name, status, title, history_file, busy)
      VALUES (1, 1, 'codex', 'web_agent_manager_chat_1', 'running', '부모 작업', 'codex.jsonl', 0)
    `).run();
    database.prepare(`
      INSERT INTO chats(id, project_id, provider, tmux_name, status, title, history_file, busy)
      VALUES (2, 1, 'claude', 'web_agent_manager_chat_2', 'running', '자식 작업', 'claude.jsonl', 0)
    `).run();
    const messages: Array<{ id: string; role: "user" | "assistant"; kind: string; content: string; createdAt: string }> = [];
    const bridge = new AgentBridge({
      database,
      adapters: [
        { id: "codex", displayLabel: "Codex" },
        { id: "claude", displayLabel: "Claude" },
      ] as unknown as ProviderAdapter[],
      historyCache: {
        get: () => ({ messages }),
      } as unknown as HistoryCache,
      sessions: {
        start: () => undefined,
        sendPrompt: async (_chatId: number, text: string) => {
          const delivered = `긴 메시지 원문을 첨부 파일에서 읽으세요.\n[첨부: .uploads/${text.length}.txt]`;
          messages.push({ id: "user-1", role: "user", kind: "message", content: delivered, createdAt: new Date().toISOString() });
          database.prepare("UPDATE chats SET busy = 1 WHERE id = 2").run();
          setTimeout(() => {
            messages.push({ id: "assistant-1", role: "assistant", kind: "message", content: "검증 결과: 수정안이 안전합니다.", createdAt: new Date().toISOString() });
            database.prepare("UPDATE chats SET busy = 0 WHERE id = 2").run();
          }, 30);
          return delivered;
        },
      } as unknown as Pick<SessionManager, "start" | "sendPrompt">,
      socketPath: path.join(dataDir, "web-agent-manager-agent.sock"),
    });

    const completed = await bridge.execute({
      method: "delegation.send_wait",
      params: {
        sourceChatId: 1,
        targetChatId: 2,
        prompt: `독립적으로 검증하고 결과를 보고하세요.\n${"긴 위임 문맥입니다. ".repeat(80)}`,
        idempotencyKey: "wait-for-child-result",
        timeoutSeconds: 2,
      },
    }) as { delegation: { status: string; completed_at: string }; result: { response: string } };

    expect(completed.delegation.status).toBe("completed");
    expect(completed.delegation.completed_at).toBeTruthy();
    expect(completed.result.response).toBe("검증 결과: 수정안이 안전합니다.");
    const stored = database.prepare("SELECT history_prompt, result_json, completed_at FROM delegations WHERE idempotency_key = ?").get("wait-for-child-result") as { history_prompt: string; result_json: string; completed_at: string };
    expect(stored.history_prompt).toContain("[첨부:");
    expect(JSON.parse(stored.result_json)).toMatchObject({ response: "검증 결과: 수정안이 안전합니다." });
    expect(stored.completed_at).toBeTruthy();
    database.close();
  });

  it("소켓을 소유자 전용으로 열고 프로젝트 목록 요청에 응답한다", async () => {
    const dataDir = createRoot("web-agent-manager-bridge-data-");
    const projectPath = createRoot("web-agent-manager-bridge-project-");
    const database = createDatabase(dataDir);
    database.prepare("INSERT INTO projects(id, name, path) VALUES (1, 'sample', ?)").run(projectPath);
    const socketPath = path.join(dataDir, "web-agent-manager-agent.sock");
    const bridge = new AgentBridge({
      database,
      adapters: [],
      historyCache: {} as HistoryCache,
      sessions: { start: () => undefined, sendPrompt: async () => undefined } as unknown as Pick<SessionManager, "start" | "sendPrompt">,
      socketPath,
    });

    await bridge.start();
    const response = await socketCall(socketPath, "projects.list", {});

    expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(response).toMatchObject({ id: "test", ok: true });
    expect(response.result).toMatchObject({ projects: [{ id: 1, name: "sample" }] });
    await bridge.close();
    expect(fs.existsSync(socketPath)).toBe(false);
    database.close();
  });
});

describe("에이전트 스킬 설치", () => {
  it("Codex·Claude 프로젝트 스킬 링크를 만들고 기존 파일은 덮어쓰지 않는다", () => {
    const projectPath = createRoot("web-agent-manager-skills-project-");
    const rootDir = createRoot("web-agent-manager-skills-source-");
    for (const name of AGENT_SKILL_NAMES) {
      fs.mkdirSync(path.join(rootDir, "skills", name), { recursive: true });
      fs.writeFileSync(path.join(rootDir, "skills", name, "SKILL.md"), name);
    }
    fs.mkdirSync(path.join(projectPath, ".agents", "skills"), { recursive: true });
    fs.symlinkSync(
      path.join(rootDir, "skills", "myagent-session-context"),
      path.join(projectPath, ".agents", "skills", "myagent-session-context"),
      "dir",
    );
    fs.mkdirSync(path.join(projectPath, ".claude", "skills", "web-agent-manager-delegate"), { recursive: true });
    fs.writeFileSync(path.join(projectPath, ".claude", "skills", "web-agent-manager-delegate", "SKILL.md"), "사용자 파일");

    const result = installProjectAgentSkills(projectPath, rootDir);

    // 두 목적지(.agents·.claude) × 스킬 수에서 기존 파일로 막힌 하나를 뺀다.
    expect(result.installed).toHaveLength(AGENT_SKILL_NAMES.length * 2 - 1);
    expect(result.errors).toContain(`${path.join(projectPath, ".claude", "skills", "web-agent-manager-delegate")}: 기존 항목을 덮어쓰지 않았습니다.`);
    expect(fs.realpathSync(path.join(projectPath, ".agents", "skills", "web-agent-manager-session-context"))).toBe(
      fs.realpathSync(path.join(rootDir, "skills", "web-agent-manager-session-context")),
    );
    expect(fs.lstatSync(path.join(projectPath, ".agents", "skills", "myagent-session-context"), { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.readFileSync(path.join(projectPath, ".claude", "skills", "web-agent-manager-delegate", "SKILL.md"), "utf8")).toBe("사용자 파일");
  });

  it("사라진 프로젝트 경로를 스킬 설치 과정에서 다시 만들지 않는다", () => {
    const parent = createRoot("web-agent-manager-skills-missing-");
    const projectPath = path.join(parent, "removed-project");
    const rootDir = createRoot("web-agent-manager-skills-source-");
    for (const name of AGENT_SKILL_NAMES) {
      fs.mkdirSync(path.join(rootDir, "skills", name), { recursive: true });
    }

    const result = installProjectAgentSkills(projectPath, rootDir);

    expect(result.errors).toHaveLength(1);
    expect(fs.existsSync(projectPath)).toBe(false);
  });
});
