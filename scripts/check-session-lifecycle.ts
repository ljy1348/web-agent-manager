import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import { TerminalScreen } from "../src/server/services/terminal-screen";
import type { Provider } from "../src/shared/types";

interface TestTerminal {
  pty: IPty;
  screen: TerminalScreen;
  exited: Promise<void>;
  isExited: () => boolean;
}

// 지정 시간 동안 CLI의 비동기 화면 갱신을 기다린다.
function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// 실제 공급자 CLI를 PTY와 headless 화면 버퍼에 연결한다.
function spawnCli(provider: Provider, resumeId?: string): TestTerminal {
  const screen = new TerminalScreen();
  const args = provider === "codex"
    ? resumeId ? ["resume", resumeId, "--no-alt-screen"] : ["--no-alt-screen"]
    : resumeId ? ["--ax-screen-reader", "--resume", resumeId] : ["--ax-screen-reader"];
  const child = pty.spawn(provider, args, {
    name: "xterm-256color", cols: 120, rows: 40, cwd: process.cwd(), env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
  });
  let ended = false;
  child.onData((data) => screen.write(data));
  const exited = new Promise<void>((resolve) => child.onExit(() => { ended = true; resolve(); }));
  return { pty: child, screen, exited, isExited: () => ended };
}

// CLI에 정상 종료 명령을 전달하고 제한 시간 뒤 강제 정리한다.
async function closeCli(provider: Provider, terminal: TestTerminal): Promise<void> {
  if (terminal.isExited()) return;
  terminal.pty.write("/exit\r");
  if (provider === "codex") { await wait(250); terminal.pty.write("\r"); }
  await Promise.race([terminal.exited, wait(5_000)]);
  if (!terminal.isExited()) terminal.pty.kill();
}

// Codex 전역 저장소의 세션 JSONL 경로만 재귀적으로 수집한다.
function listCodexSessionFiles(): string[] {
  const root = path.join(os.homedir(), ".codex", "sessions");
  const files: string[] = [];
  const walk = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(target);
    }
  };
  walk(root);
  return files;
}

// 검증 중 새로 생성된 Codex JSONL의 첫 세션 메타에서 ID를 찾는다.
function findNewCodexSession(startedAt: number, existingFiles: Set<string>): string | undefined {
  const candidates = listCodexSessionFiles()
    .filter((file) => !existingFiles.has(file))
    .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .filter((candidate) => candidate.mtime >= startedAt - 1_000)
    .sort((left, right) => right.mtime - left.mtime);
  for (const candidate of candidates) {
    const descriptor = fs.openSync(candidate.file, "r");
    const buffer = Buffer.alloc(16 * 1024);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    fs.closeSync(descriptor);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
    try {
      const record = JSON.parse(firstLine) as { type?: string; payload?: { id?: string; cwd?: string } };
      if (record.type === "session_meta" && record.payload?.cwd === process.cwd()) return record.payload.id;
    } catch {
      // 기록 중인 불완전 메타 파일은 다음 후보로 건너뛴다.
    }
  }
  return undefined;
}

// 새 세션 ID를 얻고 종료한 뒤 같은 ID로 resume되는지 검증한다.
async function verifyLifecycle(provider: Provider): Promise<void> {
  const existingCodexFiles = provider === "codex" ? new Set(listCodexSessionFiles()) : new Set<string>();
  const startedAt = Date.now();
  const first = spawnCli(provider);
  let sessionId: string | undefined;
  try {
    await wait(4_000);
    first.pty.write("Reply with only OK.\r");
    await wait(12_000);
    if (provider === "codex") {
      await closeCli(provider, first);
      await wait(500);
      sessionId = findNewCodexSession(startedAt, existingCodexFiles);
    } else {
      await closeCli(provider, first);
      await wait(500);
      sessionId = first.screen.text().match(/claude --resume\s+([0-9a-f-]{36})/i)?.[1];
    }
    if (!sessionId) throw new Error(`${provider} 세션 ID를 감지하지 못했습니다.`);
  } finally {
    if (!first.isExited()) first.pty.kill();
    first.screen.dispose();
  }

  const resumed = spawnCli(provider, sessionId);
  try {
    await wait(5_000);
    const text = resumed.screen.text();
    if (resumed.isExited()) throw new Error(`${provider} 세션 resume에 실패했습니다.`);
    process.stdout.write(`${provider}: 새 세션 종료 후 동일 ID resume 성공\n`);
    await closeCli(provider, resumed);
  } finally {
    if (!resumed.isExited()) resumed.pty.kill();
    resumed.screen.dispose();
  }
}

// 두 공급자의 세션 생명주기 검증을 순서대로 실행한다.
async function main(): Promise<void> {
  await verifyLifecycle("codex");
  await verifyLifecycle("claude");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
