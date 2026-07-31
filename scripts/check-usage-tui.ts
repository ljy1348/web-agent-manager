import * as pty from "node-pty";
import { TerminalScreen } from "../src/server/services/terminal-screen";
import { CodexAdapter } from "../src/server/providers/codex";
import { ClaudeAdapter } from "../src/server/providers/claude";
import type { ProviderAdapter } from "../src/server/providers/provider";

// 지정 시간 동안 TUI의 비동기 화면 갱신을 기다린다.
function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// 설치된 공급자 CLI를 실제 PTY로 실행해 사용량 명령 결과를 검증한다.
async function checkProvider(adapter: ProviderAdapter): Promise<void> {
  const screen = new TerminalScreen();
  const provider = adapter.id;
  const terminal = pty.spawn(provider === "codex" ? "codex" : "claude", provider === "codex" ? ["--no-alt-screen"] : ["--ax-screen-reader"], {
    name: "xterm-256color", cols: 120, rows: 40, cwd: process.cwd(), env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
  });
  terminal.onData((data) => screen.write(data));
  try {
    await wait(4_000);
    for (const command of adapter.usageCommands) {
      terminal.write(`${command}\r`);
      const confirmDelay = adapter.promptQuirks?.slashCommandConfirmDelayMs;
      if (confirmDelay) { await wait(confirmDelay); terminal.write("\r"); }
      await wait(adapter.promptQuirks?.usageCommandDelayMs ?? 6_000);
    }
    const parsed = adapter.parseUsage(screen.text());
    if (parsed.data_status !== "fresh") throw new Error(`${provider} TUI 파싱 실패: ${parsed.error_code}`);
    const details = JSON.parse(parsed.details_json ?? "{}");
    process.stdout.write(`${provider}: ${details.windows.map((window: { label: string; usedPercent: number }) => `${window.label}=${window.usedPercent}%`).join(", ")}\n`);
    terminal.write("\u001b");
  } finally {
    terminal.kill();
    screen.dispose();
  }
}

// Codex와 Claude 실제 TUI 검증을 순서대로 실행한다.
async function main(): Promise<void> {
  await checkProvider(new CodexAdapter());
  await checkProvider(new ClaudeAdapter("", {}));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
