import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

function source(relative: string): string {
  return fs.readFileSync(path.resolve(relative), "utf8");
}

type SubscribeSocket = {
  readyState: number;
  send: (data: string) => void;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
};

type SubscribeTerminalWhenReady = (options: {
  socket: SubscribeSocket;
  chatId: number;
  resolveRows: () => number;
  onReady?: () => void;
}) => () => void;

// TerminalPanel의 재구독 헬퍼를 타입 제거 후 같은 구현으로 로드한다.
function loadSubscribeTerminalWhenReady(): SubscribeTerminalWhenReady {
  const text = source("src/client/features/terminal/TerminalPanel.tsx");
  const start = text.indexOf("function subscribeTerminalWhenReady(");
  const end = text.indexOf("export function TerminalPanel(");
  if (start < 0 || end < 0) throw new Error("subscribeTerminalWhenReady 함수를 찾지 못했습니다.");
  const js = stripTypeScriptTypes(text.slice(start, end));
  const sandbox = {
    WebSocket: { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
    subscribeTerminalWhenReady: undefined as undefined | SubscribeTerminalWhenReady,
  };
  vm.runInNewContext(`${js}\nthis.subscribeTerminalWhenReady = subscribeTerminalWhenReady;`, sandbox);
  if (!sandbox.subscribeTerminalWhenReady) throw new Error("subscribeTerminalWhenReady를 실행하지 못했습니다.");
  return sandbox.subscribeTerminalWhenReady;
}

function fakeSocket(readyState: number) {
  const listeners = new Map<string, Set<() => void>>();
  const socket = {
    readyState,
    send: vi.fn(),
    addEventListener(type: string, listener: () => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener);
    },
    open() {
      socket.readyState = 1;
      for (const listener of [...(listeners.get("open") ?? [])]) listener();
    },
    listenerCount(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
  return socket;
}

describe("터미널 복귀 재구독", () => {
  it("열린 소켓이면 프레임 대기 없이 바로 구독한다", () => {
    const subscribeTerminalWhenReady = loadSubscribeTerminalWhenReady();
    const socket = fakeSocket(1);
    const onReady = vi.fn();
    subscribeTerminalWhenReady({ socket, chatId: 12, resolveRows: () => 36, onReady });
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: "subscribe_terminal", chatId: 12, rows: 36 }));
    expect(socket.listenerCount("open")).toBe(0);
  });

  it("연결 중인 소켓은 open이 난 뒤에 구독한다", () => {
    const subscribeTerminalWhenReady = loadSubscribeTerminalWhenReady();
    const socket = fakeSocket(0);
    const onReady = vi.fn();
    let rows = 36;
    subscribeTerminalWhenReady({ socket, chatId: 7, resolveRows: () => rows, onReady });
    expect(socket.send).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
    rows = 48;
    socket.open();
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: "subscribe_terminal", chatId: 7, rows: 48 }));
  });

  it("정리하면 이전 소켓의 open에서 구독이 나가지 않는다", () => {
    const subscribeTerminalWhenReady = loadSubscribeTerminalWhenReady();
    const socket = fakeSocket(0);
    const dispose = subscribeTerminalWhenReady({ socket, chatId: 3, resolveRows: () => 36 });
    dispose();
    socket.open();
    expect(socket.send).not.toHaveBeenCalled();
  });

  it("닫힌 소켓은 구독을 보내지 않는다", () => {
    const subscribeTerminalWhenReady = loadSubscribeTerminalWhenReady();
    const socket = fakeSocket(3);
    subscribeTerminalWhenReady({ socket, chatId: 3, resolveRows: () => 36 });
    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.listenerCount("open")).toBe(0);
  });
});

describe("터미널 인스턴스 수명", () => {
  it("xterm 생성 이펙트는 소켓이 아니라 채팅 id만 본다", () => {
    const text = source("src/client/features/terminal/TerminalPanel.tsx");
    expect(text).toMatch(/instance\.dispose\(\);\s*terminal\.current = null;\s*\};\s*\}, \[chat\?\.id\]\);/);
    expect(text).not.toMatch(/instance\.dispose\(\);\s*terminal\.current = null;\s*\};\s*\}, \[chat\?\.id, socket\]\);/);
    expect(text).toContain("소켓 교체는 파괴 없이 재구독한다");
  });

  it("입력·스크롤·리사이즈는 교체된 소켓을 ref로 따른다", () => {
    const text = source("src/client/features/terminal/TerminalPanel.tsx");
    expect(text).toContain("const socketRef = useRef(socket)");
    expect(text).toContain("socketRef.current = socket");
    expect(text).toContain("const currentSocket = socketRef.current");
    expect(text).toContain("const currentChat = chatRef.current");
  });

  it("재구독은 rAF에 의존하지 않고 현재 행 수를 다시 계산한다", () => {
    const text = source("src/client/features/terminal/TerminalPanel.tsx");
    const start = text.indexOf("return subscribeTerminalWhenReady(");
    const end = text.indexOf("}, [chat?.id, socket]);", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const subscribeEffect = text.slice(text.lastIndexOf("useEffect(() => {", start), end);
    expect(subscribeEffect).toContain("subscribeTerminalWhenReady");
    expect(subscribeEffect).toContain("terminalRowsForHeight(instance, hostElement)");
    expect(subscribeEffect).not.toContain("requestAnimationFrame");
    expect(subscribeEffect).toContain("terminal.current?.clear()");
  });
});
