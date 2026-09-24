import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebSocketConnectionManager, type ManagedWebSocket } from "../src/client/lib/websocket-connection-manager";

class FakeSocket implements ManagedWebSocket {
  readyState: WebSocket["readyState"] = 0;
  onopen: ((event: Event) => unknown) | null = null;
  onmessage: ((event: MessageEvent) => unknown) | null = null;
  onclose: ((event: CloseEvent) => unknown) | null = null;
  close = vi.fn(() => { this.readyState = 3; });

  open(): void {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }

  message(data = "message"): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  networkClose(): void {
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }
}

function setup(options?: { autoAuthorize?: boolean }) {
  vi.useFakeTimers();
  const sockets: FakeSocket[] = [];
  const opened: ManagedWebSocket[] = [];
  const messages: Array<{ socket: ManagedWebSocket; data: string }> = [];
  const cleared: ManagedWebSocket[] = [];
  const reconnectAuthorizations: Array<() => void> = [];
  const manager = createWebSocketConnectionManager({
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    connectTimeoutMs: 15_000,
    reconnectDelayMs: 2_000,
    onOpen: (socket) => opened.push(socket),
    onMessage: (socket, event) => messages.push({ socket, data: event.data }),
    onSocketCleared: (socket) => cleared.push(socket),
    onUnexpectedClose: (scheduleReconnect) => {
      reconnectAuthorizations.push(scheduleReconnect);
      if (options?.autoAuthorize) scheduleReconnect();
    },
  });
  return { manager, sockets, opened, messages, cleared, reconnectAuthorizations };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("WebSocket 연결 상태기계", () => {
  it("CONNECTING에서 OPEN으로 전이한 현재 generation만 공개한다", () => {
    const ctx = setup();
    ctx.manager.connect();
    expect(ctx.sockets).toHaveLength(1);
    expect(ctx.manager.getSocket()).toBe(ctx.sockets[0]);
    ctx.sockets[0].open();
    ctx.sockets[0].message("current");
    expect(ctx.opened).toEqual([ctx.sockets[0]]);
    expect(ctx.messages).toEqual([{ socket: ctx.sockets[0], data: "current" }]);
    ctx.manager.dispose();
  });

  it.each([
    ["CONNECTING", 0],
    ["OPEN", 1],
    ["CLOSING", 2],
    ["CLOSED-event-missing", 3],
  ])("복귀 교체는 %s readyState도 신뢰하지 않고 새 generation을 만든다", (_label, readyState) => {
    const ctx = setup();
    ctx.manager.connect();
    const previous = ctx.sockets[0];
    previous.readyState = readyState as WebSocket["readyState"];
    ctx.manager.replace();
    expect(previous.close).toHaveBeenCalledTimes(1);
    expect(ctx.sockets).toHaveLength(2);
    expect(ctx.manager.getSocket()).toBe(ctx.sockets[1]);
    expect(ctx.cleared).toEqual([previous]);
    ctx.manager.dispose();
  });

  it("CONNECTING 제한시간이 지나면 close 이벤트 없이도 즉시 다시 연결한다", () => {
    const ctx = setup();
    ctx.manager.connect();
    const stuck = ctx.sockets[0];
    vi.advanceTimersByTime(14_999);
    expect(ctx.sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(stuck.close).toHaveBeenCalledTimes(1);
    expect(ctx.cleared).toEqual([stuck]);
    expect(ctx.sockets).toHaveLength(2);
    expect(ctx.manager.getSocket()).toBe(ctx.sockets[1]);
    ctx.manager.dispose();
  });

  it("현재 소켓의 예기치 않은 close만 인증 확인 뒤 한 번 재연결한다", () => {
    const ctx = setup();
    ctx.manager.connect();
    const first = ctx.sockets[0];
    first.open();
    first.networkClose();
    expect(ctx.reconnectAuthorizations).toHaveLength(1);
    expect(ctx.manager.getSocket()).toBeNull();
    ctx.reconnectAuthorizations[0]();
    ctx.reconnectAuthorizations[0]();
    vi.advanceTimersByTime(1_999);
    expect(ctx.sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(ctx.sockets).toHaveLength(2);
    ctx.manager.dispose();
  });

  it("인증 확인이 늦게 끝나도 그 사이 생긴 새 generation을 덮지 않는다", () => {
    const ctx = setup();
    ctx.manager.connect();
    ctx.sockets[0].networkClose();
    const delayedReconnect = ctx.reconnectAuthorizations[0];
    ctx.manager.replace();
    const replacement = ctx.sockets[1];
    delayedReconnect();
    vi.advanceTimersByTime(2_000);
    expect(ctx.sockets).toHaveLength(2);
    expect(ctx.manager.getSocket()).toBe(replacement);
    ctx.manager.dispose();
  });

  it("옛 generation의 늦은 open·message·close는 새 연결을 건드리지 않는다", () => {
    const ctx = setup();
    ctx.manager.connect();
    const old = ctx.sockets[0];
    ctx.manager.replace();
    const current = ctx.sockets[1];
    current.open();
    old.open();
    old.message("stale");
    old.networkClose();
    expect(ctx.opened).toEqual([current]);
    expect(ctx.messages).toEqual([]);
    expect(ctx.reconnectAuthorizations).toEqual([]);
    expect(ctx.manager.getSocket()).toBe(current);
    ctx.manager.dispose();
  });

  it("옛 소켓의 intentional close가 새 소켓의 장애를 삼키지 않는다", () => {
    const ctx = setup();
    ctx.manager.connect();
    const old = ctx.sockets[0];
    old.open();
    ctx.manager.replace();
    const current = ctx.sockets[1];
    current.open();
    current.networkClose();
    expect(ctx.reconnectAuthorizations).toHaveLength(1);
    ctx.reconnectAuthorizations[0]();
    vi.advanceTimersByTime(2_000);
    expect(ctx.sockets).toHaveLength(3);
    const newest = ctx.sockets[2];
    old.networkClose();
    expect(ctx.reconnectAuthorizations).toHaveLength(1);
    expect(ctx.manager.getSocket()).toBe(newest);
    ctx.manager.dispose();
  });

  it("dispose는 연결·재연결 timer와 늦은 이벤트를 모두 무효화한다", () => {
    const ctx = setup({ autoAuthorize: true });
    ctx.manager.connect();
    const socket = ctx.sockets[0];
    socket.networkClose();
    ctx.manager.dispose();
    socket.open();
    socket.message("late");
    vi.advanceTimersByTime(30_000);
    expect(ctx.sockets).toHaveLength(1);
    expect(ctx.opened).toEqual([]);
    expect(ctx.messages).toEqual([]);
    expect(ctx.manager.getSocket()).toBeNull();
  });
});
