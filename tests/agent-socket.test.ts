import path from "node:path";
import { describe, expect, it } from "vitest";
import { agentSocketPath, isNamedPipe } from "../src/server/core/agent-socket";

describe("agent bridge socket path (#142)", () => {
  it("keeps the Unix socket in the data folder on Linux and macOS", () => {
    expect(agentSocketPath("/srv/wam/data", "linux")).toBe(path.join("/srv/wam/data", "web-agent-manager-agent.sock"));
    expect(agentSocketPath("/srv/wam/data", "darwin")).toBe(path.join("/srv/wam/data", "web-agent-manager-agent.sock"));
  });

  it("uses a stable per-data-folder named pipe on Windows", () => {
    const pipe = agentSocketPath("C:\\Users\\me\\wam\\data", "win32");
    expect(pipe).toMatch(/^\\\\\.\\pipe\\web-agent-manager-agent-[0-9a-f]{16}$/);
    expect(isNamedPipe(pipe)).toBe(true);
    expect(agentSocketPath("c:\\users\\ME\\wam\\data", "win32")).toBe(pipe);
    expect(agentSocketPath("D:\\wam\\data", "win32")).not.toBe(pipe);
    expect(isNamedPipe("/srv/wam/data/web-agent-manager-agent.sock")).toBe(false);
  });
});
