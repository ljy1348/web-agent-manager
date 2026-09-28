import crypto from "node:crypto";
import { DEFAULT_TRUSTED_NETWORKS, isTrustedNetworkAddress } from "../core/network";
import type { NextFunction, Request, Response } from "express";
import type { AppDatabase } from "../core/database";
import type { AuthenticatedRequest } from "../core/auth";
import { createToken, hashToken } from "../core/security";
import type { CredentialVault } from "./credential-vault";
import { WebSocket } from "ws";
import { Readable } from "node:stream";

export interface FederationNode {
  id: string;
  name: string;
  base_url: string;
  token_credential_id: string;
  settings_mode: "follow" | "independent";
  created_at: string;
  updated_at: string;
}

export function normalizeFederationUrl(input: string): string {
  const url = new URL(input);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("WAM 주소는 경로·쿼리·계정 정보 없이 입력하세요.");
  const address = url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (address === "localhost" || isTrustedNetworkAddress(address, DEFAULT_TRUSTED_NETWORKS)))) {
    throw new Error("HTTP 연결은 로컬·사설망·Tailnet IP 주소에만 허용됩니다. 공개 주소나 DNS 이름에는 HTTPS를 사용하세요.");
  }
  return url.origin;
}

export function createFederationAgentToken(database: AppDatabase, userId: number): string {
  const token = createToken(32);
  database.prepare("INSERT INTO federation_agent_tokens(id, token_hash, created_by) VALUES (?, ?, ?)")
    .run(crypto.randomUUID(), hashToken(token), userId);
  return token;
}

export function authenticateFederationAgent(database: AppDatabase) {
  return (request: AuthenticatedRequest, _response: Response, next: NextFunction): void => {
    if (!/^\/api\/(?:federation\/(?:ping|push-events)|projects|chats|providers|usage|approvals|system|runtime|slack|ntfy|security|agent-accounts|session-backups|files|logs\/server|provider-settings|project-transfer|credential-sync|cli-auth)(?:\/|\?|$)/.test(request.originalUrl)) return next();
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) return next();
    const token = authorization.slice(7);
    if (token.length < 32 || token.length > 256) return next();
    const row = database.prepare(`SELECT u.id, u.username, u.role, u.access_scope, u.last_project_id,
      u.last_chat_id, u.chat_view_mode FROM federation_agent_tokens t JOIN users u ON u.id = t.created_by
      WHERE t.token_hash = ? AND t.revoked_at IS NULL AND u.role = 'admin'
        AND u.temporary_expires_at IS NULL`).get(hashToken(token)) as AuthenticatedRequest["authUser"] | undefined;
    if (row) {
      request.authUser = row;
      request.authSession = { id: -1, csrfToken: "", expiresAt: "", temporary: false, reauthenticatedAt: null };
      request.federationAuthenticated = true;
    }
    next();
  };
}

export class FederationService {
  private readonly sockets = new Set<WebSocket>();
  constructor(private readonly database: AppDatabase, private readonly vault: CredentialVault, private readonly publicUrl: string) {}

  list(): Array<Omit<FederationNode, "token_credential_id">> {
    return this.database.prepare(`SELECT id, name, base_url, settings_mode, created_at, updated_at FROM federation_nodes ORDER BY name`)
      .all() as Array<Omit<FederationNode, "token_credential_id">>;
  }

  get(id: string): FederationNode | undefined {
    return this.database.prepare("SELECT * FROM federation_nodes WHERE id = ?").get(id) as FederationNode | undefined;
  }

  async add(name: string, inputUrl: string, token: string, userId: number): Promise<FederationNode> {
    const trimmedName = name.trim();
    if (!trimmedName || trimmedName.length > 80) throw new Error("컴퓨터 이름은 1~80자로 입력하세요.");
    if (token.length < 32 || token.length > 256) throw new Error("연결 토큰 형식이 올바르지 않습니다.");
    const baseUrl = normalizeFederationUrl(inputUrl);
    if (baseUrl === new URL(this.publicUrl).origin) throw new Error("현재 WAM을 자기 자신에게 연결할 수 없습니다.");
    const reply = await fetch(`${baseUrl}/api/federation/ping`, {
      headers: { Authorization: `Bearer ${token}` }, redirect: "manual", signal: AbortSignal.timeout(10_000),
    });
    if (!reply.ok || (await reply.json().catch(() => null))?.protocol !== 1) throw new Error("원격 WAM 연결 또는 토큰 검증에 실패했습니다.");
    const id = crypto.randomUUID();
    const credentialId = this.vault.put("system", id, "federation", "agent-token", token);
    try {
      this.database.prepare(`INSERT INTO federation_nodes(id, name, base_url, token_credential_id, created_by)
        VALUES (?, ?, ?, ?, ?)`).run(id, trimmedName, baseUrl, credentialId, userId);
    } catch (error) {
      this.vault.remove(credentialId);
      throw error;
    }
    return this.get(id)!;
  }

  remove(id: string): boolean {
    const node = this.get(id);
    if (!node) return false;
    this.database.prepare("DELETE FROM federation_nodes WHERE id = ?").run(id);
    this.vault.remove(node.token_credential_id);
    return true;
  }

  // 원격 API 경로가 허용 목록 안이고 경로 조작이 없는지 확인한 뒤 노드를 돌려준다.
  private resolveRemote(nodeId: string, path: string): FederationNode {
    const node = this.get(nodeId);
    if (!node) throw Object.assign(new Error("연결된 컴퓨터를 찾을 수 없습니다."), { statusCode: 404 });
    if (!path.startsWith("/") || path.startsWith("//") || /\\|%2f|%5c|%25|\.\./i.test(path)) throw new Error("잘못된 원격 API 경로입니다.");
    const route = path.split("?", 1)[0];
    let decodedRoute: string;
    try { decodedRoute = decodeURIComponent(route); } catch { throw new Error("잘못된 원격 API 경로입니다."); }
    if (decodedRoute.split("/").some((segment) => segment === "." || segment === "..") || decodedRoute.includes("\\")) throw new Error("잘못된 원격 API 경로입니다.");
    if (!/^\/(?:federation\/push-events|projects|chats|providers|usage|approvals|system|runtime|slack|ntfy|security|agent-accounts|session-backups|files|logs\/server|provider-settings|project-transfer|credential-sync|cli-auth)(?:\/|$)/.test(route)) {
      throw Object.assign(new Error("이 API는 원격 관리 경로에서 사용할 수 없습니다."), { statusCode: 403 });
    }
    return node;
  }

  async request(nodeId: string, path: string, method = "GET", body?: unknown, timeoutMs = 120_000): Promise<{ status: number; body: Uint8Array; contentType: string }> {
    const node = this.resolveRemote(nodeId, path);
    let result!: { status: number; body: Uint8Array; contentType: string };
    await this.vault.withSecret(node.token_credential_id, `federation:${nodeId}`, async (token) => {
      const reply = await fetch(`${node.base_url}/api${path}`, {
        method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
      });
      result = { status: reply.status, body: new Uint8Array(await reply.arrayBuffer()), contentType: reply.headers.get("content-type") ?? "application/json" };
    });
    return result;
  }

  // 큰 본문(프로젝트 압축 스트림 등)을 메모리에 올리지 않고 원격 API로 흘려보낸다(#137).
  async upload(nodeId: string, path: string, body: Readable, headers: Record<string, string>, timeoutMs = 6 * 60 * 60_000): Promise<{ status: number; body: Uint8Array; contentType: string }> {
    const node = this.resolveRemote(nodeId, path);
    let result!: { status: number; body: Uint8Array; contentType: string };
    await this.vault.withSecret(node.token_credential_id, `federation-upload:${nodeId}`, async (token) => {
      const reply = await fetch(`${node.base_url}/api${path}`, {
        method: "POST", headers: { ...headers, Authorization: `Bearer ${token}` },
        body: Readable.toWeb(body) as ReadableStream, duplex: "half", redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
      } as RequestInit);
      result = { status: reply.status, body: new Uint8Array(await reply.arrayBuffer()), contentType: reply.headers.get("content-type") ?? "application/json" };
    });
    return result;
  }

  async relaySocket(nodeId: string, browser: WebSocket): Promise<void> {
    const node = this.get(nodeId);
    if (!node) { browser.close(1011, "연결된 컴퓨터를 찾을 수 없습니다."); return; }
    await this.vault.withSecret(node.token_credential_id, `federation-ws:${nodeId}`, async (token) => {
      const upstream = new WebSocket(`${node.base_url.replace(/^http/, "ws")}/ws/federation`, {
        headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 10_000, maxPayload: 2 * 1024 * 1024,
      });
      this.sockets.add(upstream);
      const pending: Array<{ data: Buffer; binary: boolean }> = [];
      let pendingBytes = 0;
      const close = (): void => {
        this.sockets.delete(upstream);
        if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
        if (browser.readyState === WebSocket.OPEN) browser.close(1011, "원격 연결이 종료되었습니다.");
      };
      browser.on("message", (data, binary) => {
        const bytes = Buffer.from(data as Buffer);
        if (upstream.readyState === WebSocket.OPEN) {
          if (upstream.bufferedAmount > 4 * 1024 * 1024) return close();
          upstream.send(bytes, { binary });
        } else if (upstream.readyState === WebSocket.CONNECTING && pendingBytes + bytes.length <= 1024 * 1024) {
          pending.push({ data: bytes, binary });
          pendingBytes += bytes.length;
        } else close();
      });
      browser.on("close", close);
      upstream.on("open", () => { for (const item of pending) upstream.send(item.data, { binary: item.binary }); pending.length = 0; });
      upstream.on("message", (data, binary) => {
        if (browser.readyState !== WebSocket.OPEN || browser.bufferedAmount > 4 * 1024 * 1024) return close();
        browser.send(data, { binary });
      });
      upstream.on("close", close);
      upstream.on("error", close);
    });
  }

  close(): void {
    for (const socket of this.sockets) socket.terminate();
    this.sockets.clear();
  }
}
