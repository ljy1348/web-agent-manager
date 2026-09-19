import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

type SocketWatchdog = { check: () => void };
type WatchdogOptions = {
  silenceLimitMs: number;
  isVisible: () => boolean;
  getLastMessageAt: () => number;
  markChecked: () => void;
  onSilent: () => void;
  now?: () => number;
};

// main.tsx의 createSocketWatchdog를 타입 제거 후 같은 구현으로 로드한다.
function loadCreateSocketWatchdog(): (options: WatchdogOptions) => SocketWatchdog {
  const text = fs.readFileSync(path.resolve("src/client/main.tsx"), "utf8");
  const start = text.indexOf("function createSocketWatchdog(");
  const end = text.indexOf("// end createSocketWatchdog");
  if (start < 0 || end < 0) throw new Error("createSocketWatchdog 구현을 찾지 못했습니다.");
  const source = stripTypeScriptTypes(`${text.slice(start, end)}\nglobalThis.__factory = createSocketWatchdog;`);
  const context: Record<string, unknown> = {};
  vm.createContext(context);
  vm.runInContext(source, context);
  return (context as { __factory: (options: WatchdogOptions) => SocketWatchdog }).__factory;
}

// 앱을 켜둔 채 대기하는 동안 close 없이 죽는 좀비 소켓을 잡아내는 판정이다(#54).
describe("소켓 침묵 감시", () => {
  const createSocketWatchdog = loadCreateSocketWatchdog();

  // 지정한 조건으로 감시자를 만들고, 되살리기가 몇 번 호출됐는지 셀 수 있게 한다.
  function setup(options: { silentFor: number; visible?: boolean }): { watchdog: SocketWatchdog; onSilent: ReturnType<typeof vi.fn>; lastMessageAt: () => number } {
    const now = 1_000_000;
    let lastMessageAt = now - options.silentFor;
    const onSilent = vi.fn();
    const watchdog = createSocketWatchdog({
      silenceLimitMs: 70_000,
      isVisible: () => options.visible ?? true,
      getLastMessageAt: () => lastMessageAt,
      markChecked: () => { lastMessageAt = now; },
      onSilent,
      now: () => now,
    });
    return { watchdog, onSilent, lastMessageAt: () => lastMessageAt };
  }

  it("하트비트가 정상적으로 오는 동안에는 소켓을 건드리지 않는다", () => {
    // 서버는 25초마다 ping을 보내므로 그 사이 침묵은 정상이다.
    const { watchdog, onSilent } = setup({ silentFor: 30_000 });
    watchdog.check();
    expect(onSilent).not.toHaveBeenCalled();
  });

  it("침묵이 한계를 넘으면 좀비로 보고 되살린다", () => {
    const { watchdog, onSilent } = setup({ silentFor: 90_000 });
    watchdog.check();
    expect(onSilent).toHaveBeenCalledTimes(1);
  });

  it("한 번 되살린 뒤에는 곧바로 다시 걸지 않는다", () => {
    // 기준 시각을 미루지 않으면 감시 주기마다 소켓을 계속 갈아끼우게 된다.
    const { watchdog, onSilent } = setup({ silentFor: 90_000 });
    watchdog.check();
    watchdog.check();
    watchdog.check();
    expect(onSilent).toHaveBeenCalledTimes(1);
  });

  it("화면이 안 보이면 판정하지 않는다", () => {
    // 백그라운드에서는 WebView가 타이머를 멈추고 소켓도 유지되지 않는다. 복귀는 복귀 훅이 맡는다.
    const { watchdog, onSilent } = setup({ silentFor: 90_000, visible: false });
    watchdog.check();
    expect(onSilent).not.toHaveBeenCalled();
  });
});
