import { Router, type NextFunction, type Request, type Response } from "express";
import type { AppDatabase } from "../core/database";
import { requireAdmin, requireNonTemporarySession, type AuthenticatedRequest } from "../core/auth";
import { createFederationAgentToken, FederationService } from "../services/federation";
import type { PushEventJournal } from "../services/push-event-journal";

export function createFederationRouter(database: AppDatabase, federation: FederationService, pushEvents?: PushEventJournal): Router {
  const router = Router();
  router.get("/federation/ping", (_request, response) => response.json({ protocol: 1 }));
  router.get("/federation/push-events", requireAdmin, (request, response) => {
    if (!pushEvents) return response.status(503).json({ error: "알림 집계가 준비되지 않았습니다." });
    const raw = Number(request.query.after ?? 0);
    if (!Number.isSafeInteger(raw) || raw < 0) return response.status(400).json({ error: "잘못된 이벤트 위치입니다." });
    response.json({ latest: pushEvents.latest(), events: pushEvents.list(raw) });
  });
  router.post("/federation/agent-tokens", requireAdmin, requireNonTemporarySession, (request: AuthenticatedRequest, response) => {
    response.status(201).json({ token: createFederationAgentToken(database, request.authUser!.id) });
  });
  router.get("/federation/agent-tokens", requireAdmin, (_request, response) => {
    const tokens = database.prepare("SELECT id, created_at, revoked_at FROM federation_agent_tokens ORDER BY created_at DESC").all();
    response.json({ tokens });
  });
  router.delete("/federation/agent-tokens/:id", requireAdmin, requireNonTemporarySession, (request, response) => {
    const changed = database.prepare("UPDATE federation_agent_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND revoked_at IS NULL").run(request.params.id).changes;
    response.status(changed ? 204 : 404).end();
  });
  router.get("/federation/nodes", requireAdmin, (_request, response) => response.json({ nodes: federation.list() }));
  router.post("/federation/nodes", requireAdmin, requireNonTemporarySession, (request: AuthenticatedRequest, response, next) => {
    const { name, url, token } = request.body ?? {};
    if (typeof name !== "string" || typeof url !== "string" || typeof token !== "string") return response.status(400).json({ error: "컴퓨터 이름, WAM 주소, 연결 토큰이 필요합니다." });
    void federation.add(name, url, token, request.authUser!.id)
      .then((node) => response.status(201).json({ node: { id: node.id, name: node.name, base_url: node.base_url, created_at: node.created_at, updated_at: node.updated_at } }))
      .catch(next);
  });
  router.delete("/federation/nodes/:id", requireAdmin, requireNonTemporarySession, (request, response) => {
    response.status(federation.remove(String(request.params.id)) ? 204 : 404).end();
  });
  router.all("/federation/nodes/:id/api/*path", requireAdmin, requireNonTemporarySession, (request: Request, response: Response, next: NextFunction) => {
    const marker = `/api/federation/nodes/${request.params.id}/api`;
    const suffix = request.originalUrl.slice(marker.length);
    if (!request.originalUrl.startsWith(marker) || !suffix.startsWith("/")) return response.status(400).json({ error: "원격 API 경로가 올바르지 않습니다." });
    void federation.request(String(request.params.id), suffix, request.method, ["GET", "HEAD"].includes(request.method) ? undefined : request.body)
      .then((result) => {
        if (result.status >= 300 && result.status < 400) return response.status(502).json({ error: "원격 WAM이 예상치 못한 리다이렉트를 반환했습니다." });
        response.set("X-WAM-Federation-Upstream", "1");
        response.status(result.status).type(result.contentType).send(Buffer.from(result.body));
      }).catch(next);
  });
  return router;
}
