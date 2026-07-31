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
}

// Origin의 호스트와 프로토콜이 실제 또는 프록시 외부 요청 주소와 같은지 확인한다.
export function isSameOrigin(request: IncomingMessage, publicUrl?: string): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    if (originUrl.host !== request.headers.host) return false;
    let expectedProtocol = (request.socket as IncomingMessage["socket"] & { encrypted?: boolean }).encrypted ? "https:" : "http:";
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
  private subscribeHandler?: (chatId: number, user: AuthUser) => void;
  private authInputHandler?: (provider: string, data: string, user: AuthUser) => void;
  private authSubscribeHandler?: (provider: string, user: AuthUser) => void;

  constructor(httpServer: Server, private readonly database: AppDatabase, publicUrl?: string) {
    httpServer.on("upgrade", (request, socket, head) => {
      if (!request.url?.startsWith("/ws") || !isSameOrigin(request, publicUrl)) {
        socket.destroy();
        return;
      }
      const user = this.authenticate(request);
      if (!user) {
        socket.destroy();
        return;
      }
      this.server.handleUpgrade(request, socket, head, (webSocket) => this.accept(webSocket, user));
    });
  }

  // 터미널 입력과 구독 요청을 처리할 콜백을 등록한다.
  setTerminalHandlers(
    inputHandler: (chatId: number, data: string, user: AuthUser) => void,
    subscribeHandler: (chatId: number, user: AuthUser) => void,
  ): void {
    this.inputHandler = inputHandler;
    this.subscribeHandler = subscribeHandler;
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
  broadcast(type: string, payload: unknown): void {
    const encoded = JSON.stringify({ type, payload });
    for (const client of this.clients) if (client.socket.readyState === WebSocket.OPEN) client.socket.send(encoded);
  }

  // 특정 채팅 터미널을 구독한 클라이언트에 출력 데이터를 보낸다.
  terminal(chatId: number, data: string): void {
    const encoded = JSON.stringify({ type: "terminal_output", payload: { chatId, data } });
    for (const client of this.clients) {
      if (client.terminalChatId === chatId && client.socket.readyState === WebSocket.OPEN) client.socket.send(encoded);
    }
  }

  // 선택한 CLI 인증 터미널을 구독한 관리자에게만 출력 데이터를 보낸다.
  authTerminal(provider: string, data: string): void {
    const encoded = JSON.stringify({ type: "auth_terminal_output", payload: { provider, data } });
    for (const client of this.clients) {
      if (client.authProvider === provider && client.socket.readyState === WebSocket.OPEN) client.socket.send(encoded);
    }
  }

  // 세션 Cookie로 WebSocket 요청 사용자를 확인한다.
  private authenticate(request: IncomingMessage): AuthUser | null {
    const cookies = parseCookies(request.headers.cookie);
    const token = cookies.web_agent_manager_session ?? cookies.myagent_session;
    if (!token) return null;
    const row = this.database.prepare(`
      SELECT u.id, u.username, u.role FROM web_sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > datetime('now')
    `).get(hashToken(token)) as AuthUser | undefined;
    return row ?? null;
  }

  // 새 WebSocket 클라이언트와 메시지 핸들러를 등록한다.
  private accept(socket: WebSocket, user: AuthUser): void {
    const client: ClientState = { socket, user, terminalChatId: null, authProvider: null };
    this.clients.add(client);
    socket.on("close", () => this.clients.delete(client));
    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as { type?: string; chatId?: number; provider?: string; data?: string };
        if (message.type === "subscribe_terminal" && Number.isInteger(message.chatId)) {
          if (user.role !== "admin") {
            socket.send(JSON.stringify({ type: "error", payload: { message: "관리자만 터미널을 구독할 수 있습니다." } }));
            return;
          }
          client.terminalChatId = message.chatId!;
          client.authProvider = null;
          this.subscribeHandler?.(message.chatId!, user);
        }
        if (message.type === "terminal_input" && Number.isInteger(message.chatId) && typeof message.data === "string") {
          if (user.role !== "admin") {
            socket.send(JSON.stringify({ type: "error", payload: { message: "관리자만 터미널에 입력할 수 있습니다." } }));
            return;
          }
          this.inputHandler?.(message.chatId!, message.data, user);
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
}
