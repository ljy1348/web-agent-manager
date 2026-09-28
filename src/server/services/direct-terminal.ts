import * as pty from "node-pty";
import type { IPty } from "node-pty";
import { resolvePtyCommand } from "../core/windows-command";
import { findExecutable } from "./agent-integration";

// tmux가 없는 Windows 노드에서 CLI를 node-pty(ConPTY)로 직접 띄우는 터미널 백엔드(#144).
// tmux 세션 이름을 그대로 키로 써서 세션 관리자·입력 함수가 이름만 알면 같은 경로로 다룰 수 있다.
// 한계: tmux처럼 서버 밖에서 살아남지 않아, 서버가 재시작되면 실행 중이던 CLI도 끝난다(대화는 기록 파일로 재개).
export type TerminalBackend = "tmux" | "direct";

let backend: TerminalBackend = "tmux";
const sessions = new Map<string, IPty>();

export function setTerminalBackend(value: TerminalBackend): void {
  backend = value;
}

export function usesDirectTerminals(): boolean {
  return backend === "direct";
}

export function directTerminalExists(name: string): boolean {
  return sessions.has(name);
}

export function getDirectTerminal(name: string): IPty | undefined {
  return sessions.get(name);
}

// Windows node-pty는 경로 없는 이름을 PATH에서 확장자 그대로만 찾아 claude.cmd·claude.exe를 못 찾는다("File not found: ", Windows 실측).
// 그래서 .exe→.cmd→.bat 순서로 실제 파일 경로를 먼저 찾는다(#155와 같은 탐색).
export function resolveTerminalExecutable(command: string, platform: NodeJS.Platform = process.platform, find: (name: string) => string | null = findExecutable): string {
  if (platform !== "win32" || /[\\/]/.test(command)) return command;
  const found = find(command);
  if (!found) throw new Error(`${command} 실행 파일을 PATH에서 찾지 못했습니다. 이 PC에 설치되어 있는지 확인하세요.`);
  return found;
}

// CLI를 PTY로 직접 실행하고 등록한다. 프로세스가 끝나면 등록에서 빠진다.
export function spawnDirectTerminal(name: string, command: string, args: string[], options: { cwd: string; env: Record<string, string>; cols: number; rows: number }): IPty {
  if (sessions.has(name)) throw new Error("이미 실행 중인 터미널입니다.");
  const resolved = resolvePtyCommand(resolveTerminalExecutable(command), args);
  const child = pty.spawn(resolved.file, resolved.args as string[], {
    name: "xterm-256color",
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: { ...process.env, ...options.env, TERM: "xterm-256color" } as Record<string, string>,
  });
  sessions.set(name, child);
  child.onExit(() => { if (sessions.get(name) === child) sessions.delete(name); });
  return child;
}

// 등록된 세션이면 입력을 쓰고 true를 돌려준다. tmux 세션이면 false라 호출부가 tmux로 보낸다.
export function writeDirectTerminal(name: string, data: string): boolean {
  const child = sessions.get(name);
  if (!child) return false;
  child.write(data);
  return true;
}

export function resizeDirectTerminal(name: string, cols: number, rows: number): boolean {
  const child = sessions.get(name);
  if (!child) return false;
  child.resize(cols, rows);
  return true;
}

export function killDirectTerminal(name: string): boolean {
  const child = sessions.get(name);
  if (!child) return false;
  sessions.delete(name);
  child.kill();
  return true;
}
