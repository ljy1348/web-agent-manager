import { describe, expect, it } from "vitest";
import { readTomlMcpServers, removeTomlServerBlock } from "../src/server/routes/tool-routes";

// 실제 `grok mcp add -e ... --header ...`가 남긴 형식(따옴표 없는 이름 + 서브테이블). 우리 자동 연동이
// 정확히 이 파일을 만들기 때문에, 여기서 깨지면 도구 카탈로그에 유령 서버가 올라온다.
const GROK_CONFIG = `[mcp_servers.web-agent-manager]
command = "/usr/bin/node"
args = [
    "/home/ubuntu/myagent/dist/server/scripts/web-agent-manager-agent.js",
    "--mcp",
]
enabled = true

[mcp_servers.web-agent-manager.env]
WEB_AGENT_MANAGER_BRIDGE_SOCKET = "/tmp/wam.sock"

[mcp_servers.remote-api]
url = "https://example.com/mcp"
enabled = true

[mcp_servers.remote-api.headers]
Authorization = "Bearer T"
`;

// WAM이 직접 쓰는 형식(따옴표 있는 이름 + inline 표기, Codex는 http_headers).
const WAM_CONFIG = `[mcp_servers."web-agent-manager"]
command = "node"
args = ["agent.js", "--mcp"]
env = { A = "b" }
http_headers = { Authorization = "Bearer T" }
`;

describe("MCP config.toml 파싱", () => {
  it("따옴표 없는 이름의 env·headers 서브테이블을 별개 서버로 오인하지 않는다", () => {
    const servers = readTomlMcpServers(GROK_CONFIG);
    expect(servers.map((server) => server.name)).toEqual(["web-agent-manager", "remote-api"]);
    expect(servers[0].env).toEqual({ WEB_AGENT_MANAGER_BRIDGE_SOCKET: "/tmp/wam.sock" });
    expect(servers[0].command).toBe("/usr/bin/node");
    // CLI는 긴 명령의 args를 여러 줄로 쓴다. 한 줄만 읽으면 args가 비고, 그 상태로 도구 화면에서
    // 저장·토글하면 블록을 다시 쓰면서 실행 인자가 사라진다.
    expect(servers[0].args).toEqual(["/home/ubuntu/myagent/dist/server/scripts/web-agent-manager-agent.js", "--mcp"]);
    expect(servers[1].headers).toEqual({ Authorization: "Bearer T" });
  });

  it("따옴표 있는 이름과 inline env·http_headers도 같은 구조로 읽는다", () => {
    const servers = readTomlMcpServers(WAM_CONFIG);
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ name: "web-agent-manager", args: ["agent.js", "--mcp"], env: { A: "b" }, headers: { Authorization: "Bearer T" } });
  });

  it("이름에 점이 있어도 서브테이블 접미사와 구분한다", () => {
    const servers = readTomlMcpServers(`[mcp_servers."foo.bar"]\ncommand = "node"\n\n[mcp_servers."foo.bar".env]\nA = "b"\n\n[mcp_servers.env]\ncommand = "x"\n`);
    expect(servers.map((server) => server.name)).toEqual(["foo.bar", "env"]);
    expect(servers[0].env).toEqual({ A: "b" });
  });

  it("서버를 지우면 그 서버의 서브테이블까지 함께 사라지고 다른 서버는 남는다", () => {
    const remaining = removeTomlServerBlock(GROK_CONFIG, "web-agent-manager");
    expect(remaining).not.toContain("web-agent-manager");
    expect(readTomlMcpServers(remaining).map((server) => server.name)).toEqual(["remote-api"]);
    expect(readTomlMcpServers(remaining)[0].headers).toEqual({ Authorization: "Bearer T" });
  });
});
