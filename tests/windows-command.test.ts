import { describe, expect, it } from "vitest";
import { isWindowsScript, resolveCommand, resolvePtyCommand } from "../src/server/core/windows-command";

describe("Windows 스크립트형 CLI 실행 (#143)", () => {
  it("Linux·macOS와 Windows .exe는 그대로 실행한다", () => {
    expect(resolveCommand("/usr/bin/codex", ["app-server"], "linux")).toEqual({ command: "/usr/bin/codex", args: ["app-server"], verbatim: false });
    expect(resolveCommand("C:\\Tools\\codex.exe", ["app-server"], "win32")).toEqual({ command: "C:\\Tools\\codex.exe", args: ["app-server"], verbatim: false });
  });

  it("Windows .cmd·.bat은 cmd.exe로 감싸고 공백·따옴표 인자만 따옴표 처리한다", () => {
    const resolved = resolveCommand("C:\\Users\\my name\\AppData\\Roaming\\npm\\codex.cmd", ["mcp", "add", "web-agent-manager", "--env", "SOCK=\\\\.\\pipe\\wam-1", "--", "node", "C:\\Program Files\\wam\\agent.js"], "win32", "C:\\Windows\\system32\\cmd.exe");
    expect(resolved.command).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(resolved.verbatim).toBe(true);
    expect(resolved.args).toEqual(["/d", "/s", "/c", "\"\"C:\\Users\\my name\\AppData\\Roaming\\npm\\codex.cmd\" mcp add web-agent-manager --env SOCK=\\\\.\\pipe\\wam-1 -- node \"C:\\Program Files\\wam\\agent.js\"\""]);
    expect(isWindowsScript("claude.CMD")).toBe(true);
    expect(isWindowsScript("gh.exe")).toBe(false);
  });

  it("로그인 터미널(node-pty)에는 명령줄 문자열을 넘긴다", () => {
    expect(resolvePtyCommand("C:\\npm\\claude.cmd", ["auth", "login", "--claudeai"], "win32", "cmd.exe")).toEqual({ file: "cmd.exe", args: "/d /s /c \"\"C:\\npm\\claude.cmd\" auth login --claudeai\"" });
    expect(resolvePtyCommand("/usr/bin/claude", ["auth", "login"], "linux")).toEqual({ file: "/usr/bin/claude", args: ["auth", "login"] });
  });
});
