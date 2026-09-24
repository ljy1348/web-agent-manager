export type ManagedWebSocket = Pick<WebSocket, "readyState" | "close"> & {
  onopen: ((event: Event) => unknown) | null;
  onmessage: ((event: MessageEvent) => unknown) | null;
  onclose: ((event: CloseEvent) => unknown) | null;
};

export type WebSocketConnectionManager = {
  connect: () => void;
  replace: () => void;
  dispose: () => void;
  getSocket: () => ManagedWebSocket | null;
};

// WebSocket 수명을 한 곳에서 관리한다. generation이 바뀌면 옛 소켓의 늦은 open/message/close는
// 전부 무시하고, 의도적 close도 socket별로 기억해 다른 연결의 장애를 삼키지 않는다.
export function createWebSocketConnectionManager(options: {
  createSocket: () => ManagedWebSocket;
  connectTimeoutMs: number;
  reconnectDelayMs: number;
  onOpen: (socket: ManagedWebSocket) => void;
  onMessage: (socket: ManagedWebSocket, event: MessageEvent) => void;
  onSocketCleared: (socket: ManagedWebSocket) => void;
  onUnexpectedClose: (scheduleReconnect: () => void) => void;
}): WebSocketConnectionManager {
  let disposed = false;
  let generation = 0;
  let current: ManagedWebSocket | null = null;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const intentionalClosures = new WeakSet<object>();

  function clearConnectTimer(): void {
    if (!connectTimer) return;
    clearTimeout(connectTimer);
    connectTimer = null;
  }

  function clearReconnectTimer(): void {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function isCurrent(socket: ManagedWebSocket, socketGeneration: number): boolean {
    return !disposed && current === socket && generation === socketGeneration;
  }

  function retireCurrent(): void {
    const socket = current;
    if (!socket) return;
    current = null;
    intentionalClosures.add(socket);
    options.onSocketCleared(socket);
    try { socket.close(); } catch { /* 이미 폐기된 WebView 소켓은 close 자체가 실패할 수 있다. */ }
  }

  function scheduleReconnect(expectedGeneration: number): void {
    if (disposed || current || generation !== expectedGeneration || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (disposed || current || generation !== expectedGeneration) return;
      startConnection();
    }, options.reconnectDelayMs);
  }

  function startConnection(): void {
    if (disposed) return;
    clearConnectTimer();
    clearReconnectTimer();
    retireCurrent();
    const socketGeneration = ++generation;
    let socket: ManagedWebSocket;
    try {
      socket = options.createSocket();
    } catch {
      options.onUnexpectedClose(() => scheduleReconnect(socketGeneration));
      return;
    }
    current = socket;
    socket.onopen = () => {
      if (!isCurrent(socket, socketGeneration)) {
        intentionalClosures.add(socket);
        try { socket.close(); } catch { /* 구세대 소켓 폐기 실패는 현재 연결과 무관하다. */ }
        return;
      }
      clearConnectTimer();
      options.onOpen(socket);
    };
    socket.onmessage = (event) => {
      if (isCurrent(socket, socketGeneration)) options.onMessage(socket, event);
    };
    socket.onclose = () => {
      const intentional = intentionalClosures.delete(socket);
      if (!isCurrent(socket, socketGeneration)) return;
      clearConnectTimer();
      current = null;
      options.onSocketCleared(socket);
      if (intentional || disposed) return;
      options.onUnexpectedClose(() => scheduleReconnect(socketGeneration));
    };
    connectTimer = setTimeout(() => {
      if (!isCurrent(socket, socketGeneration) || socket.readyState !== WebSocket.CONNECTING) return;
      // visible 상태의 최초 연결도 CONNECTING에서 영구 정지할 수 있다. close 이벤트를 기다리지 않고
      // 이 generation을 폐기한 뒤 곧바로 새 연결을 만든다.
      intentionalClosures.add(socket);
      current = null;
      options.onSocketCleared(socket);
      try { socket.close(); } catch { /* 새 generation 생성은 계속 진행한다. */ }
      startConnection();
    }, options.connectTimeoutMs);
  }

  return {
    connect() {
      if (!current && !disposed) startConnection();
    },
    replace() {
      if (!disposed) startConnection();
    },
    getSocket: () => current,
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      clearConnectTimer();
      clearReconnectTimer();
      retireCurrent();
    },
  };
}
