import type { IncomingMessage } from "node:http";
import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { AppDatabase } from "../core/database";
import { hashToken, parseCookies } from "../core/security";
import type { AuthUser } from "../../shared/types";

interface ClientState {
  socket: WebSocket;
  user: AuthUser;
  terminalChatId: number | null;
  authProvider: string | null;
  // 마지막으로 이 클라이언트가 살아있다고 확인된 시각(pong 또는 아무 메시지 수신).
  lastSeenAt: number;
  sessionExpiresAt: number;
  temporary: boolean;
  sessionId: number;
  mobileTrustedDeviceId: string | null;
  networkAccessAllowed: number;
  lastAuthValidatedAt: number;
  lastActivityPersistedAt: number;
}

interface AuthenticatedSocketSession {
  user: AuthUser;
  expiresAt: number;
  temporary: boolean;
  sessionId: number;
  mobileTrustedDeviceId: string | null;
  networkAccessAllowed: number;
}

// 모바일 네트워크에서는 NAT 유휴 타임아웃이나 셀룰러↔WiFi 전환으로 TCP가 close 프레임 없이 조용히
// 끊긴다. 하트비트가 없으면 서버는 죽은 클라이언트를 계속 broadcast 대상으로 들고 있고, 클라이언트는
// readyState가 OPEN인 좀비 소켓을 붙잡은 채 이벤트가 안 오는 상태가 된다(실사용 보고 #54:
// "나갔다 들어오든 그냥 대기하든 자꾸 끊긴다"). 브라우저 WebSocket API는 프로토콜 ping/pong을
// 노출하지 않아 클라이언트가 프로토콜 ping을 볼 수 없으므로, 애플리케이션 레벨 메시지로 주고받아
// 양쪽 모두 상대의 침묵을 감지할 수 있게 한다(프록시 통과에도 유리하다).
const HEARTBEAT_INTERVAL_MS = 25_000;
// 이 시간 동안 pong이든 다른 메시지든 아무것도 못 받으면 죽은 연결로 보고 정리한다.
// 하트비트 두 번을 놓칠 여유를 준다.
const HEARTBEAT_TIMEOUT_MS = HEARTBEAT_INTERVAL_MS * 2 + 5_000;
const AUTH_REVALIDATE_INTERVAL_MS = 1_000;

// Origin의 호스트와 프로토콜이 실제 또는 프록시 외부 요청 주소와 같은지 확인한다.
export function isSameOrigin(request: IncomingMessage, publicUrl?: string): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    if (originUrl.host !== request.headers.host) return false;
    let expectedProtocol = (request.socket as IncomingMessage["socket"] & { encrypted?: boolean }).encrypted ? "https:" : "http:";
    const forwardedProto = String(request.headers["x-forwarded-proto"] ?? "").split(",", 1)[0].trim().toLowerCase();
    if (["http", "https"].includes(forwardedProto)) expectedProtocol = `${forwardedProto}:`;
    if (publicUrl) {
      const configuredUrl = new URL(publicUrl);
      if (configuredUrl.host === request.headers.host) expectedProtocol = configuredUrl.protocol;
    }
    return originUrl.protocol === expectedProtocol;
  } catch {
    return false;
  }
}

// HTTP 서버에 인증된 실시간 이벤트와 터미널 채널을 연결한다.
export class RealtimeHub {
  private readonly server = new WebSocketServer({ noServer: true });
  private readonly clients = new Set<ClientState>();
  private inputHandler?: (chatId: number, data: string, user: AuthUser) => void;
  private subscribeHandler?: (chatId: number, user: AuthUser, rows?: number) => void;
  private scrollHandler?: (chatId: number, lines: number, user: AuthUser) => void;
  private resizeHandler?: (chatId: number, rows: number, user: AuthUser) => void;
  private authInputHandler?: (provider: string, data: string, user: AuthUser) => void;
  private authSubscribeHandler?: (provider: string, user: AuthUser) => void;
  private heartbeatTimer?: NodeJS.Timeout;
  private authTimer?: NodeJS.Timeout;
  private readonly heartbeatTimeoutMs: number;
  private readonly idleMinutes: number;
  private readonly activityPersistIntervalMs: number;

  // heartbeat 옵션은 테스트에서 실제 25초를 기다리지 않고 동작을 확인하기 위한 것이다.
  constructor(httpServer: Server, private readonly database: AppDatabase, publicUrl?: string, heartbeat?: { intervalMs: number; timeoutMs: number; authRevalidateMs?: number }, idleMinutes = 720) {
    this.heartbeatTimeoutMs = heartbeat?.timeoutMs ?? HEARTBEAT_TIMEOUT_MS;
    this.idleMinutes = idleMinutes;
    this.activityPersistIntervalMs = Math.max(30_000, Math.min(5 * 60_000, idleMinutes * 30_000));
    this.heartbeatTimer = setInterval(() => this.sweepHeartbeat(), heartbeat?.intervalMs ?? HEARTBEAT_INTERVAL_MS);
    // 하트비트 때문에 프로세스가 종료되지 못하는 일이 없도록 이벤트 루프를 붙잡지 않는다.
    this.heartbeatTimer.unref();
    this.authTimer = setInterval(() => this.sweepAuthorization(), heartbeat?.authRevalidateMs ?? AUTH_REVALIDATE_INTERVAL_MS);
    this.authTimer.unref();
    httpServer.on("upgrade", (request, socket, head) => {
      if (!request.url?.startsWith("/ws") || !isSameOrigin(request, publicUrl)) {
        socket.destroy();
        return;
      }
      const session = this.authenticate(request);
      if (!session) {
        socket.destroy();
        return;
      }
      this.server.handleUpgrade(request, socket, head, (webSocket) => this.accept(webSocket, session));
    });
  }

  // 터미널 입력·구독·기록 스크롤·세로 리사이즈 요청을 처리할 콜백을 등록한다.
  setTerminalHandlers(
    inputHandler: (chatId: number, data: string, user: AuthUser) => void,
    subscribeHandler: (chatId: number, user: AuthUser, rows?: number) => void,
    scrollHandler?: (chatId: number, lines: number, user: AuthUser) => void,
    resizeHandler?: (chatId: number, rows: number, user: AuthUser) => void,
  ): void {
    this.inputHandler = inputHandler;
    this.subscribeHandler = subscribeHandler;
    this.scrollHandler = scrollHandler;
    this.resizeHandler = resizeHandler;
  }

  // CLI 인증 터미널의 입력과 구독 콜백을 등록한다.
  setAuthTerminalHandlers(
    inputHandler: (provider: string, data: string, user: AuthUser) => void,
    subscribeHandler: (provider: string, user: AuthUser) => void,
  ): void {
    this.authInputHandler = inputHandler;
    this.authSubscribeHandler = subscribeHandler;
  }

  // 모든 로그인 클라이언트에 애플리케이션 이벤트를 전송한다.
  // skipTemporary는 일회용 코드로 만든 임시 세션을 제외한다. 승인 요청처럼 payload에 도구 이름과
  // 인자가 실리는 이벤트는 HTTP GET을 막아도 이 채널로 그대로 새기 때문에 같이 닫아야 한다.
  broadcast(type: string, payload: unknown, options?: { skipTemporary?: boolean }): void {
    const encoded = JSON.stringify({ type, payload });
    for (const client of [...this.clients]) {
      if (options?.skipTemporary && client.temporary) continue;
      if (this.isUsable(client)) client.socket.send(encoded);
    }
  }

  // 특정 채팅 터미널을 구독한 클라이언트에 출력 데이터를 보낸다.
  terminal(chatId: number, data: string): void {
    const encoded = JSON.stringify({ type: "terminal_output", payload: { chatId, data } });
    for (const client of [...this.clients]) {
      if (client.terminalChatId === chatId && this.isUsable(client)) client.socket.send(encoded);
    }
  }

  // 선택한 CLI 인증 터미널을 구독한 관리자에게만 출력 데이터를 보낸다.
  authTerminal(provider: string, data: string): void {
    const encoded = JSON.stringify({ type: "auth_terminal_output", payload: { provider, data } });
    for (const client of [...this.clients]) {
      if (client.authProvider === provider && this.isUsable(client)) client.socket.send(encoded);
    }
  }

  // 종료 시 열린 실시간 연결과 업그레이드 서버를 닫는다. 승격된 WebSocket 소켓이 남아 있으면 http 서버의
  // close 콜백이 끝내 호출되지 않아 프로세스가 종료되지 못하므로, 정상 종료 핸드셰이크를 기다리지 않고 바로 끊는다.
  close(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.authTimer) clearInterval(this.authTimer);
    for (const client of this.clients) client.socket.terminate();
    this.clients.clear();
    this.server.close();
  }

  // 살아있는 클라이언트에는 ping을 보내고, 정해진 시간 동안 아무 응답도 없는 연결은 끊어 정리한다.
  // 죽은 연결을 계속 들고 있으면 broadcast가 허공에 나가고, 클라이언트도 자기가 끊긴 걸 모른다.
  private sweepHeartbeat(): void {
    const now = Date.now();
    for (const client of [...this.clients]) {
      if (client.socket.readyState !== WebSocket.OPEN) {
        this.clients.delete(client);
        continue;
      }
      if (now >= client.sessionExpiresAt) {
        this.clients.delete(client);
        client.socket.terminate();
        continue;
      }
      if (now - client.lastSeenAt > this.heartbeatTimeoutMs) {
        // 정상 종료 핸드셰이크를 기다리면 이미 끊긴 연결에서는 끝내 완료되지 않으므로 바로 끊는다.
        this.clients.delete(client);
        client.socket.terminate();
        continue;
      }
      try {
        client.socket.send(JSON.stringify({ type: "ping", payload: { at: now } }));
      } catch {
        // 전송 실패 자체가 죽은 연결이라는 신호다. 다음 주기의 타임아웃에서 정리된다.
      }
    }
  }

  private sweepAuthorization(): void {
    for (const client of [...this.clients]) this.isUsable(client, true);
  }

  // 세션 Cookie로 WebSocket 요청 사용자를 확인한다.
  private authenticate(request: IncomingMessage): AuthenticatedSocketSession | null {
    const cookies = parseCookies(request.headers.cookie);
    const token = cookies.web_agent_manager_session ?? cookies.myagent_session;
    if (!token) return null;
    const row = this.database.prepare(`
      SELECT u.id, u.username, u.role, u.access_scope, s.id AS session_id, s.expires_at, s.mobile_trusted_device_id,
        s.network_access_allowed, d.active AS mobile_device_active, u.temporary_expires_at FROM web_sessions s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN mobile_trusted_devices d ON d.id = s.mobile_trusted_device_id AND d.user_id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > datetime('now')
        AND COALESCE(s.last_seen_at, s.created_at) > datetime('now', ?)
        AND (u.temporary_expires_at IS NULL OR u.temporary_expires_at > datetime('now'))
    `).get(hashToken(token), `-${this.idleMinutes} minutes`) as (AuthUser & { session_id: number; expires_at: string; temporary_expires_at: string | null; mobile_trusted_device_id: string | null; network_access_allowed: number; mobile_device_active: number | null }) | undefined;
    if (!row) return null;
    if (row.mobile_trusted_device_id !== null && row.mobile_device_active !== 1) return null;
    const expiresAt = Date.parse(`${row.expires_at.replace(" ", "T")}Z`);
    if (!Number.isFinite(expiresAt)) return null;
    return { user: row, expiresAt, temporary: row.temporary_expires_at !== null, sessionId: Number(row.session_id), mobileTrustedDeviceId: row.mobile_trusted_device_id, networkAccessAllowed: row.network_access_allowed };
  }

  // 새 WebSocket 클라이언트와 메시지 핸들러를 등록한다.
  private accept(socket: WebSocket, session: AuthenticatedSocketSession): void {
    const user = session.user;
    const client: ClientState = { socket, user, terminalChatId: null, authProvider: null, lastSeenAt: Date.now(), sessionExpiresAt: session.expiresAt, temporary: session.temporary, sessionId: session.sessionId, mobileTrustedDeviceId: session.mobileTrustedDeviceId, networkAccessAllowed: session.networkAccessAllowed, lastAuthValidatedAt: Date.now(), lastActivityPersistedAt: Date.now() };
    this.clients.add(client);
    socket.on("close", () => this.clients.delete(client));
    // 브라우저가 프로토콜 ping에 자동으로 답하는 pong도 생존 신호로 받는다.
    socket.on("pong", () => { client.lastSeenAt = Date.now(); });
    socket.on("message", (raw) => {
      if (!this.isUsable(client, true)) return;
      // 어떤 메시지든 도착했다면 연결은 살아있다.
      client.lastSeenAt = Date.now();
      if (client.lastSeenAt - client.lastActivityPersistedAt >= this.activityPersistIntervalMs) {
        this.database.prepare("UPDATE web_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?").run(client.sessionId);
        client.lastActivityPersistedAt = client.lastSeenAt;
      }
      try {
        const message = JSON.parse(raw.toString()) as { type?: string; chatId?: number; provider?: string; data?: string; lines?: number; rows?: number };
        // 클라이언트가 우리 ping에 답한 것. 위에서 이미 생존 시각을 갱신했으므로 더 할 일이 없다.
        if (message.type === "pong") return;
        // 클라이언트가 먼저 살아있는지 물어보는 경우엔 즉시 답해 준다.
        if (message.type === "ping") {
          socket.send(JSON.stringify({ type: "pong", payload: { at: Date.now() } }));
          return;
        }
        if (message.type === "subscribe_terminal" && Number.isInteger(message.chatId)) {
          if (user.role !== "admin") {
            socket.send(JSON.stringify({ type: "error", payload: { message: "관리자만 터미널을 구독할 수 있습니다." } }));
            return;
          }
          client.terminalChatId = message.chatId!;
          client.authProvider = null;
          this.subscribeHandler?.(message.chatId!, user, Number.isInteger(message.rows) ? message.rows : undefined);
        }
        if (message.type === "terminal_input" && Number.isInteger(message.chatId) && typeof message.data === "string") {
          if (user.role !== "admin") {
            socket.send(JSON.stringify({ type: "error", payload: { message: "관리자만 터미널에 입력할 수 있습니다." } }));
            return;
          }
          this.inputHandler?.(message.chatId!, message.data, user);
        }
        // 기록 스크롤은 화면을 되짚어 보는 읽기 동작이지만 결국 그 채팅의 tmux pane을 움직이므로
        // 입력과 같은 관리자 권한을 요구한다.
        if (message.type === "terminal_scroll" && Number.isInteger(message.chatId) && Number.isFinite(message.lines)) {
          if (user.role !== "admin") {
            socket.send(JSON.stringify({ type: "error", payload: { message: "관리자만 터미널을 조작할 수 있습니다." } }));
            return;
          }
          this.scrollHandler?.(message.chatId!, message.lines!, user);
        }
        // 세로 리사이즈도 공유 tmux pane의 상태를 바꾸므로 터미널 입력과 같은 관리자 권한을 요구한다.
        if (message.type === "terminal_resize" && Number.isInteger(message.chatId) && Number.isInteger(message.rows)) {
          if (user.role !== "admin") {
            socket.send(JSON.stringify({ type: "error", payload: { message: "관리자만 터미널을 조작할 수 있습니다." } }));
            return;
          }
          this.resizeHandler?.(message.chatId!, message.rows!, user);
        }
        if (message.type === "subscribe_auth_terminal" && typeof message.provider === "string") {
          if (user.role !== "admin") {
            socket.send(JSON.stringify({ type: "error", payload: { message: "관리자만 인증 터미널을 구독할 수 있습니다." } }));
            return;
          }
          client.authProvider = message.provider;
          client.terminalChatId = null;
          this.authSubscribeHandler?.(message.provider, user);
        }
        if (message.type === "auth_terminal_input" && typeof message.provider === "string" && typeof message.data === "string") {
          if (user.role !== "admin") {
            socket.send(JSON.stringify({ type: "error", payload: { message: "관리자만 인증 터미널에 입력할 수 있습니다." } }));
            return;
          }
          this.authInputHandler?.(message.provider, message.data, user);
        }
      } catch {
        socket.send(JSON.stringify({ type: "error", payload: { message: "잘못된 실시간 요청입니다." } }));
      }
    });
  }

  // 만료된 세션은 새 메시지를 처리하거나 이벤트를 보내기 전에 즉시 연결에서 제거한다.
  private isUsable(client: ClientState, forceAuthorization = false): boolean {
    const now = Date.now();
    if (client.socket.readyState === WebSocket.OPEN && now < client.sessionExpiresAt) {
      if (!forceAuthorization && now - client.lastAuthValidatedAt < AUTH_REVALIDATE_INTERVAL_MS) return true;
      const row = this.database.prepare(`SELECT u.id, u.role, u.access_scope, u.temporary_expires_at, s.expires_at,
        s.mobile_trusted_device_id, s.network_access_allowed, d.active AS mobile_device_active FROM web_sessions s JOIN users u ON u.id = s.user_id
        LEFT JOIN mobile_trusted_devices d ON d.id = s.mobile_trusted_device_id AND d.user_id = s.user_id
        WHERE s.id = ? AND s.expires_at > datetime('now') AND COALESCE(s.last_seen_at, s.created_at) > datetime('now', ?)
          AND (u.temporary_expires_at IS NULL OR u.temporary_expires_at > datetime('now'))`).get(client.sessionId, `-${this.idleMinutes} minutes`) as Record<string, unknown> | undefined;
      const valid = !!row && row.id === client.user.id && row.role === client.user.role && row.access_scope === client.user.access_scope
        && row.mobile_trusted_device_id === client.mobileTrustedDeviceId && row.network_access_allowed === client.networkAccessAllowed
        && (row.mobile_trusted_device_id === null || row.mobile_device_active === 1);
      if (valid) { client.lastAuthValidatedAt = now; return true; }
    }
    this.clients.delete(client);
    if (client.socket.readyState === WebSocket.OPEN) client.socket.terminate();
    return false;
  }
}
