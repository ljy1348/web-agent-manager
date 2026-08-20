import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import packageMetadata from "../package.json" with { type: "json" };

interface BridgeResponse {
  id: string | number | null;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

const TOOL_DEFINITIONS = [
  {
    name: "web_agent_manager_list_projects",
    description: "web-agent-manager에 등록된 프로젝트를 조회합니다.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "web_agent_manager_list_chats",
    description: "프로젝트의 Claude·Codex 채팅 번호와 상태를 조회합니다.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "integer" },
        projectPath: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "web_agent_manager_get_context",
    description: "명시한 web-agent-manager 채팅 번호의 최근 작업 문맥을 읽습니다. '채팅 160 참고' 같은 요청에 사용합니다.",
    inputSchema: {
      type: "object",
      properties: {
        chatId: { type: "integer" },
        projectId: { type: "integer" },
        projectPath: { type: "string" },
        provider: { type: "string", enum: ["codex", "claude"] },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "web_agent_manager_snapshot_context",
    description: "다른 에이전트에 전달할 채팅 문맥을 7일짜리 불변 스냅샷으로 저장합니다.",
    inputSchema: {
      type: "object",
      properties: {
        chatId: { type: "integer" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      required: ["chatId"],
      additionalProperties: false,
    },
  },
  {
    name: "web_agent_manager_delegate",
    description: "web-agent-manager의 특정 채팅이나 프로젝트 공급자 세션에 작업을 명시적으로 전달합니다.",
    inputSchema: {
      type: "object",
      properties: {
        targetChatId: { type: "integer" },
        sourceChatId: { type: "integer" },
        parentDelegationId: { type: "string" },
        projectId: { type: "integer" },
        projectPath: { type: "string" },
        provider: { type: "string", enum: ["codex", "claude"] },
        prompt: { type: "string", minLength: 1, maxLength: 100000 },
        idempotencyKey: { type: "string", maxLength: 200 },
        createNew: { type: "boolean", description: "기존 채팅 대신 새 자식 채팅을 생성합니다." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "web_agent_manager_delegate_and_wait",
    description: "새 Claude·Codex 자식 채팅에 작업을 전달하고 완료 응답을 기다려 부모에게 결과를 반환합니다.",
    inputSchema: {
      type: "object",
      properties: {
        targetChatId: { type: "integer" },
        sourceChatId: { type: "integer" },
        parentDelegationId: { type: "string" },
        projectId: { type: "integer" },
        projectPath: { type: "string" },
        provider: { type: "string", enum: ["codex", "claude"] },
        prompt: { type: "string", minLength: 1, maxLength: 100000 },
        idempotencyKey: { type: "string", maxLength: 200 },
        createNew: { type: "boolean", description: "기본값 true. false면 최근 공급자 채팅을 재사용합니다." },
        timeoutSeconds: { type: "integer", minimum: 1, maximum: 900 },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "web_agent_manager_wait_delegation",
    description: "이미 전달한 작업이 완료될 때까지 기다리고 대상 에이전트의 새 응답을 반환합니다.",
    inputSchema: {
      type: "object",
      properties: {
        delegationId: { type: "string" },
        timeoutSeconds: { type: "integer", minimum: 1, maximum: 900 },
      },
      required: ["delegationId"],
      additionalProperties: false,
    },
  },
  {
    name: "web_agent_manager_delegation_status",
    description: "작업 전달 결과와 대상 채팅의 현재 실행 상태를 조회합니다.",
    inputSchema: {
      type: "object",
      properties: { delegationId: { type: "string" } },
      required: ["delegationId"],
      additionalProperties: false,
    },
  },
  {
    name: "web_agent_manager_experiment_summary",
    description: "실험의 Variant별 지표와 조건부 권고(확증·잠정·무차별)를 조회합니다.",
    inputSchema: {
      type: "object",
      properties: { experimentId: { type: "string" } },
      required: ["experimentId"],
      additionalProperties: false,
    },
  },
  {
    name: "web_agent_manager_experiment_list",
    description: "프로젝트의 실험과 Variant·최근 실행 목록을 조회합니다.",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "number" } },
      required: ["projectId"],
      additionalProperties: false,
    },
  },
  {
    name: "web_agent_manager_experiment_plan_start",
    description: "실험의 Variant를 arm 교차 순서로 펼친 실행 계획을 만들고 순차 실행을 시작합니다.",
    inputSchema: {
      type: "object",
      properties: {
        experimentId: { type: "string" },
        stage: { type: "string", enum: ["screening", "grid", "confirmation"] },
        repetitions: { type: "number" },
        cleanup: { type: "boolean" },
      },
      required: ["experimentId"],
      additionalProperties: false,
    },
  },
  {
    name: "web_agent_manager_experiment_plans",
    description: "실험의 실행 계획과 항목별 진행 상태를 조회합니다.",
    inputSchema: {
      type: "object",
      properties: { experimentId: { type: "string" } },
      required: ["experimentId"],
      additionalProperties: false,
    },
  },
  {
    name: "web_agent_manager_experiment_suite_summary",
    description: "여러 상황(셀)을 묶은 스위트의 셀별 집계와 셀을 가로지르는 조건부 권고를 조회합니다.",
    inputSchema: {
      type: "object",
      properties: { suiteId: { type: "string" } },
      required: ["suiteId"],
      additionalProperties: false,
    },
  },
  {
    name: "web_agent_manager_experiment_cleanup",
    description: "끝난 실험·스위트의 격리 작업공간과 스킬 bundle을 지금 정리합니다. 평가가 걸린 run은 남깁니다.",
    inputSchema: {
      type: "object",
      properties: { experimentId: { type: "string" }, suiteId: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "web_agent_manager_experiment_fixtures",
    description: "등록된 저장소 fixture와 적격성 게이트 상태를 조회합니다.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
] as const;

const TOOL_METHODS: Record<string, string> = {
  web_agent_manager_list_projects: "projects.list",
  web_agent_manager_list_chats: "chats.list",
  web_agent_manager_get_context: "context.get",
  web_agent_manager_snapshot_context: "context.snapshot",
  web_agent_manager_delegate: "delegation.send",
  web_agent_manager_delegate_and_wait: "delegation.send_wait",
  web_agent_manager_wait_delegation: "delegation.wait",
  web_agent_manager_delegation_status: "delegation.status",
  web_agent_manager_experiment_summary: "experiment.summary",
  web_agent_manager_experiment_list: "experiment.list",
  web_agent_manager_experiment_plan_start: "experiment.plan_start",
  web_agent_manager_experiment_plans: "experiment.plans",
  web_agent_manager_experiment_fixtures: "experiment.fixtures",
  web_agent_manager_experiment_suite_summary: "experiment.suite_summary",
  web_agent_manager_experiment_cleanup: "experiment.cleanup",
};

// 새·기존 환경변수와 설치·소스 경로 후보에서 실행 중인 web-agent-manager Unix 소켓을 찾는다.
function resolveSocketPath(): string {
  const configured = process.env.WEB_AGENT_MANAGER_BRIDGE_SOCKET ?? process.env.MYAGENT_BRIDGE_SOCKET;
  if (configured && fs.existsSync(path.resolve(configured))) return path.resolve(configured);
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const entryDir = path.dirname(path.resolve(process.argv[1]));
  const candidates = [
    path.resolve(entryDir, "..", "..", "..", "data", "web-agent-manager-agent.sock"),
    path.resolve(entryDir, "..", "data", "web-agent-manager-agent.sock"),
    path.resolve(scriptDir, "..", "data", "web-agent-manager-agent.sock"),
    path.resolve(scriptDir, "..", "..", "data", "web-agent-manager-agent.sock"),
    path.resolve(scriptDir, "..", "..", "..", "data", "web-agent-manager-agent.sock"),
    path.resolve(entryDir, "..", "..", "..", "data", "myagent-agent.sock"),
    path.resolve(entryDir, "..", "data", "myagent-agent.sock"),
    path.resolve(scriptDir, "..", "data", "myagent-agent.sock"),
    path.resolve(scriptDir, "..", "..", "data", "myagent-agent.sock"),
    path.resolve(scriptDir, "..", "..", "..", "data", "myagent-agent.sock"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

// Unix 소켓에 한 줄 JSON 요청을 보내 첫 응답을 반환한다.
async function callBridge(method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(resolveSocketPath());
    let buffer = "";
    socket.setEncoding("utf8");
    const requestedTimeout = Number(params.timeoutSeconds);
    const waitTimeout = method === "delegation.wait" || method === "delegation.send_wait"
      ? Math.min(900, Math.max(1, Number.isFinite(requestedTimeout) ? requestedTimeout : 300)) * 1000 + 5_000
      : 30_000;
    socket.setTimeout(waitTimeout);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id, method, params: { cwd: process.env.WEB_AGENT_MANAGER_CALLER_CWD ?? process.env.MYAGENT_CALLER_CWD ?? process.cwd(), ...params } })}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.end();
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as BridgeResponse;
        if (!response.ok) reject(new Error(response.error || "브리지 요청이 실패했습니다."));
        else resolve(response.result);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("timeout", () => socket.destroy(new Error("브리지 응답 시간이 초과되었습니다.")));
    socket.once("error", reject);
  });
}

// MCP 도구 호출명을 브리지 메서드로 변환해 표준 content 응답을 만든다.
async function callMcpTool(name: string, argumentsValue: unknown): Promise<Record<string, unknown>> {
  const method = TOOL_METHODS[name];
  if (!method) return { content: [{ type: "text", text: `알 수 없는 도구입니다: ${name}` }], isError: true };
  try {
    const params = argumentsValue && typeof argumentsValue === "object" ? argumentsValue as Record<string, unknown> : {};
    const result = await callBridge(method, params);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
  }
}

// MCP JSON-RPC 요청 한 건을 처리하고 알림은 응답 없이 넘긴다.
async function handleMcpRequest(request: JsonRpcRequest): Promise<Record<string, unknown> | null> {
  if (request.id === undefined) return null;
  if (request.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "web-agent-manager", version: packageMetadata.version },
      },
    };
  }
  if (request.method === "tools/list") return { jsonrpc: "2.0", id: request.id, result: { tools: TOOL_DEFINITIONS } };
  if (request.method === "tools/call") {
    const name = typeof request.params?.name === "string" ? request.params.name : "";
    return { jsonrpc: "2.0", id: request.id, result: await callMcpTool(name, request.params?.arguments) };
  }
  return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "지원하지 않는 MCP 메서드입니다." } };
}

// 표준 입력의 줄 단위 MCP 메시지를 순서대로 처리한다.
function runMcpServer(): void {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  let queue = Promise.resolve();
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        queue = queue.then(async () => {
          try {
            const response = await handleMcpRequest(JSON.parse(line) as JsonRpcRequest);
            if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
          } catch (error) {
            process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: error instanceof Error ? error.message : String(error) } })}\n`);
          }
        });
      }
      newline = buffer.indexOf("\n");
    }
  });
}

// CLI 또는 MCP 모드로 브리지 클라이언트를 실행한다.
async function main(): Promise<void> {
  if (process.argv[2] === "--mcp") {
    runMcpServer();
    return;
  }
  if (process.argv[2] !== "call" || !process.argv[3]) {
    throw new Error("사용법: web-agent-manager-agent call <method> '{\"key\":\"value\"}' 또는 web-agent-manager-agent --mcp");
  }
  const params = process.argv[4] ? JSON.parse(process.argv[4]) as Record<string, unknown> : {};
  const result = await callBridge(process.argv[3], params);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
