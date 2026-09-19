import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import type { ProviderAdapter } from "../src/server/providers/provider";
import { AgentBridge } from "../src/server/services/agent-bridge";
import type { HistoryCache } from "../src/server/services/history-cache";
import type { SessionManager } from "../src/server/services/session-manager";

const temporaryRoots: string[] = [];
const scriptPath = path.resolve("scripts/web-agent-manager-agent.ts");
const tsxCli = path.resolve("node_modules/tsx/dist/cli.mjs");

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// 테스트용 임시 디렉터리를 만들고 종료 시 지운다.
function createRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

// 브리지 클라이언트 테스트에서 물려받으면 안 되는 채팅 번호 변수를 지운다.
function isolatedEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.WEB_AGENT_MANAGER_CHAT_ID;
  delete env.MYAGENT_CHAT_ID;
  delete env.WEB_AGENT_MANAGER_CALLER_CWD;
  delete env.MYAGENT_CALLER_CWD;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

// 가짜 Unix 소켓으로 브리지 클라이언트가 실은 params를 가로챈다.
async function captureAgentParams(
  envOverrides: Record<string, string | undefined>,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const root = createRoot("wam-agent-cli-");
  const socketPath = path.join(root, "agent.sock");
  const received: Array<{ params?: Record<string, unknown> }> = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      received.push(JSON.parse(buffer.slice(0, newline)) as { params?: Record<string, unknown> });
      socket.write(`${JSON.stringify({ id: "test", ok: true, result: { ok: true } })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  try {
    const stderr = await runAgentCall(isolatedEnv({
      ...envOverrides,
      WEB_AGENT_MANAGER_BRIDGE_SOCKET: socketPath,
    }), "ping", params);
    if (received.length !== 1) throw new Error(`브리지 요청을 받지 못했습니다: ${stderr}`);
    return received[0]?.params ?? {};
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// tsx로 브리지 CLI를 한 번 실행하고 실패 시 stderr를 돌려준다.
async function runAgentCall(env: NodeJS.ProcessEnv, method: string, params: Record<string, unknown>): Promise<string> {
  const child = spawn(process.execPath, [tsxCli, scriptPath, "call", method, JSON.stringify(params)], {
    env,
    cwd: path.resolve("."),
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  const [status] = await once(child, "exit") as [number | null];
  clearTimeout(timer);
  if (status !== 0) throw new Error(`agent cli 실패 (${status}): ${stderr}`);
  return stderr;
}

describe("브리지 CLI 기본 sourceChatId", () => {
  it("환경변수가 있으면 sourceChatId를 기본으로 실어 보낸다", async () => {
    const params = await captureAgentParams({ WEB_AGENT_MANAGER_CHAT_ID: "306" }, {});
    expect(params.sourceChatId).toBe(306);
  });

  it("예전 MYAGENT_CHAT_ID도 기본 부모로 읽는다", async () => {
    const params = await captureAgentParams({ MYAGENT_CHAT_ID: "42" }, {});
    expect(params.sourceChatId).toBe(42);
  });

  it("호출자가 명시한 sourceChatId가 환경변수보다 우선한다", async () => {
    const params = await captureAgentParams(
      { WEB_AGENT_MANAGER_CHAT_ID: "306" },
      { sourceChatId: 160 },
    );
    expect(params.sourceChatId).toBe(160);
  });

  it("환경변수가 없거나 이상한 값이면 sourceChatId를 넣지 않는다", async () => {
    const missing = await captureAgentParams({}, { prompt: "부모 없이" });
    const garbage = await captureAgentParams({ WEB_AGENT_MANAGER_CHAT_ID: "not-a-chat" }, {});
    expect(missing).not.toHaveProperty("sourceChatId");
    expect(garbage).not.toHaveProperty("sourceChatId");
  });

  it("환경변수의 채팅 번호를 기본 부모로 묶어 위임한다", async () => {
    const dataDir = createRoot("wam-agent-cli-bridge-data-");
    const projectPath = createRoot("wam-agent-cli-bridge-project-");
    const database = openDatabase({
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
    } as never);
    database.prepare("INSERT INTO projects(id, name, path) VALUES (1, 'sample', ?)").run(projectPath);
    database.prepare(`
      INSERT INTO chats(id, project_id, provider, tmux_name, status, title)
      VALUES (1, 1, 'codex', 'web_agent_manager_chat_1', 'running', '부모')
    `).run();
    database.prepare(`
      INSERT INTO chats(id, project_id, provider, tmux_name, status, title)
      VALUES (2, 1, 'claude', 'web_agent_manager_chat_2', 'running', '자식')
    `).run();
    const socketPath = path.join(dataDir, "web-agent-manager-agent.sock");
    const bridge = new AgentBridge({
      database,
      adapters: [
        { id: "codex", displayLabel: "Codex" },
        { id: "claude", displayLabel: "Claude" },
      ] as unknown as ProviderAdapter[],
      historyCache: {} as HistoryCache,
      sessions: {
        start: () => undefined,
        sendPrompt: async () => undefined,
      } as unknown as Pick<SessionManager, "start" | "sendPrompt">,
      socketPath,
    });
    await bridge.start();
    try {
      await runAgentCall(isolatedEnv({
        WEB_AGENT_MANAGER_CHAT_ID: "1",
        WEB_AGENT_MANAGER_BRIDGE_SOCKET: socketPath,
      }), "delegation.send", {
        targetChatId: 2,
        prompt: "환경변수 부모로 위임",
        idempotencyKey: "env-parent",
      });
      const row = database.prepare(
        "SELECT source_chat_id AS sourceChatId, status FROM delegations WHERE idempotency_key = ?",
      ).get("env-parent") as { sourceChatId: number; status: string };
      expect(row).toMatchObject({ sourceChatId: 1, status: "sent" });
    } finally {
      await bridge.close();
      (database as AppDatabase).close();
    }
  });
});
