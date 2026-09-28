import { afterEach, describe, expect, it } from "vitest";
import { directTerminalExists, killDirectTerminal, resolveTerminalExecutable, setTerminalBackend, spawnDirectTerminal, usesDirectTerminals } from "../src/server/services/direct-terminal";
import { isTmuxCopyMode, pastePromptToTmux, resizeTmuxWindow, scrollTmuxHistory, sendTmuxBackspace, sendTmuxEnter } from "../src/server/services/tmux-input";

// 입력을 받은 그대로 16진수로 다시 출력하는 작은 프로그램. PTY에 무엇이 쓰였는지 정확히 본다.
const ECHO_HEX = "process.stdin.setRawMode?.(true);process.stdin.on('data',(d)=>process.stdout.write('<'+d.toString('hex')+'>'));process.stdout.on('resize',()=>process.stdout.write('[size '+process.stdout.columns+'x'+process.stdout.rows+']'));";

afterEach(() => {
  killDirectTerminal("wam-direct-test");
  setTerminalBackend("tmux");
});

describe("직접 PTY 터미널 백엔드 (#144, Windows 노드)", () => {
  it("tmux 입력 함수가 등록된 세션에는 tmux 대신 제어 문자로 쓴다", async () => {
    setTerminalBackend("direct");
    expect(usesDirectTerminals()).toBe(true);
    const child = spawnDirectTerminal("wam-direct-test", process.execPath, ["-e", ECHO_HEX], { cwd: process.cwd(), env: {}, cols: 100, rows: 30 });
    let output = "";
    child.onData((data) => { output += data; });
    await new Promise((resolve) => setTimeout(resolve, 400));
    pastePromptToTmux("wam-direct-test", "안녕");
    sendTmuxEnter("wam-direct-test");
    sendTmuxBackspace("wam-direct-test", 2);
    resizeTmuxWindow("wam-direct-test", 120, 40);
    expect(scrollTmuxHistory("wam-direct-test", 5)).toBe(false);
    expect(isTmuxCopyMode("wam-direct-test")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 600));
    // 에코 프로그램이 받은 바이트를 순서대로 이어 붙이면 붙여넣기 → Enter → Backspace 2번이어야 한다.
    const received = [...output.matchAll(/<([0-9a-f]+)>/g)].map((match) => match[1]).join("");
    expect(received).toBe(Buffer.from("\x1b[200~안녕\x1b[201~\r\x7f\x7f").toString("hex"));
    expect(output).toContain("[size 120x40]");
  });

  it("프로세스가 끝나면 등록에서 빠지고, 같은 이름은 중복 실행하지 않는다", async () => {
    setTerminalBackend("direct");
    const child = spawnDirectTerminal("wam-direct-test", process.execPath, ["-e", "setTimeout(()=>{},200)"], { cwd: process.cwd(), env: {}, cols: 80, rows: 24 });
    expect(() => spawnDirectTerminal("wam-direct-test", process.execPath, ["-e", ""], { cwd: process.cwd(), env: {}, cols: 80, rows: 24 })).toThrow(/이미 실행 중/);
    await new Promise<void>((resolve) => child.onExit(() => resolve()));
    expect(directTerminalExists("wam-direct-test")).toBe(false);
  });
});

// Windows node-pty는 "claude"를 claude.cmd로 찾지 못해 "File not found: "로 채팅 전송이 실패했다(Windows 실측).
describe("Windows 채팅 터미널 실행 파일 탐색", () => {
  it("경로 없는 이름만 PATH 탐색 결과로 바꾸고, 못 찾으면 알아볼 수 있는 오류를 낸다", () => {
    const find = (name: string) => (name === "claude" ? "C:\\Users\\me\\AppData\\Local\\Volta\\bin\\claude.cmd" : null);
    expect(resolveTerminalExecutable("claude", "win32", find)).toBe("C:\\Users\\me\\AppData\\Local\\Volta\\bin\\claude.cmd");
    expect(resolveTerminalExecutable("C:\\tools\\codex.exe", "win32", () => null)).toBe("C:\\tools\\codex.exe");
    expect(resolveTerminalExecutable("claude", "linux", () => null)).toBe("claude");
    expect(() => resolveTerminalExecutable("grok", "win32", find)).toThrow(/grok 실행 파일을 PATH에서 찾지 못했습니다/);
  });
});
