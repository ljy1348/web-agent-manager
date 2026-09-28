import { describe, expect, it } from "vitest";
import { executableCandidates } from "../src/server/services/agent-integration";

// Windows 실측(#155): Volta·npm 전역 폴더에 확장자 없는 codex(실행 불가, spawn ENOENT)와 codex.cmd가 함께 있다.
describe("Windows CLI 실행 파일 후보 (#155)", () => {
  it("Windows는 확장자 없는 이름을 후보에서 빼고 .exe → .cmd → .bat 순서로 본다", () => {
    expect(executableCandidates("codex", "win32")).toEqual(["codex.exe", "codex.cmd", "codex.bat"]);
    expect(executableCandidates("codex.cmd", "win32")).toEqual(["codex.cmd"]);
  });

  it("Linux·macOS는 이름 그대로 찾는다", () => {
    expect(executableCandidates("codex", "linux")).toEqual(["codex"]);
    expect(executableCandidates("claude", "darwin")).toEqual(["claude"]);
  });
});
