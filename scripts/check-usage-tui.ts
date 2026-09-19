import * as pty from "node-pty";
import { TerminalScreen } from "../src/server/services/terminal-screen";
import { CodexAdapter } from "../src/server/providers/codex";
import { ClaudeAdapter } from "../src/server/providers/claude";
import { GrokAdapter } from "../src/server/providers/grok";
import type { ProviderAdapter } from "../src/server/providers/provider";

// 지정 시간 동안 TUI의 비동기 화면 갱신을 기다린다.
function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// 설치된 공급자 CLI를 실제 PTY로 실행해 사용량 명령 결과를 검증한다.
async function checkProvider(adapter: ProviderAdapter): Promise<void> {
  const screen = new TerminalScreen();
  const provider = adapter.id;
  const args = provider === "codex" ? ["--no-alt-screen"] : provider === "claude" ? ["--ax-screen-reader"] : [];
  const terminal = pty.spawn(provider, args, {
    name: "xterm-256color", cols: 120, rows: 40, cwd: process.cwd(), env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
  });
  terminal.onData((data) => screen.write(data));
  try {
    await wait(4_000);
    const attempts = provider === "claude" ? 2 : 1;
    let lastFallback: string | null = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      screen.reset();
      for (const command of adapter.usageCommands) {
        terminal.write(`${command}\r`);
        const confirmDelay = adapter.promptQuirks?.slashCommandConfirmDelayMs;
        if (confirmDelay) { await wait(confirmDelay); terminal.write("\r"); }
        await wait(adapter.promptQuirks?.usageCommandDelayMs ?? 6_000);
      }
      const parsed = adapter.parseUsage(screen.text());
      if (parsed.data_status === "fresh") {
        const details = JSON.parse(parsed.details_json ?? "{}");
        process.stdout.write(`${provider}: ${details.windows.map((window: { label: string; usedPercent: number }) => `${window.label}=${window.usedPercent}%`).join(", ")}\n`);
        return;
      }
      const controlledClaudeFallback = provider === "claude" && typeof parsed.error_code === "string"
        && (parsed.error_code.startsWith("usage_seeded_") || parsed.error_code === "usage_endpoint_throttled" || parsed.error_code === "usage_refreshing");
      if (!controlledClaudeFallback) throw new Error(`${provider} TUI 파싱 실패: ${parsed.error_code}`);
      if (parsed.used_percent !== null || parsed.remaining_percent !== null || parsed.reset_at !== null || parsed.details_json !== null) {
        throw new Error(`${provider} fallback 숫자가 신뢰값으로 노출되었습니다: ${parsed.error_code}`);
      }
      lastFallback = parsed.error_code ?? null;
      terminal.write(adapter.usageScreenCloseInput ?? "\u001b");
      await wait(500);
    }
    process.stdout.write(`${provider}: fallback 안전 분류=${lastFallback} (fresh 직접값은 다음 자동 조회에서 확인)\n`);
  } finally {
    terminal.write("\u001b");
    terminal.kill();
    screen.dispose();
  }
}

// 세 공급자의 실제 TUI를 순서대로 확인한다. Claude fallback은 실패가 아니라 숫자 미채택 계약을 검증한다.
async function main(): Promise<void> {
  await checkProvider(new CodexAdapter());
  await checkProvider(new ClaudeAdapter("", {}));
  await checkProvider(new GrokAdapter());
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
