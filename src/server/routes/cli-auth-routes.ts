import { Router } from "express";
import type { AppDatabase } from "../core/database";
import { requireAdmin, type AuthenticatedRequest } from "../core/auth";
import { writeAudit } from "../core/audit";
import { type CliAuthProvider, CliAuthManager } from "../services/cli-auth";

const PROVIDERS = new Set<CliAuthProvider>(["codex", "claude", "github"]);

// CLI 인증 상태 조회와 관리자 전용 로그인 PTY 제어 API를 구성한다.
export function createCliAuthRouter(database: AppDatabase, manager: CliAuthManager): Router {
  const router = Router();
  router.get("/cli-auth", requireAdmin, async (_request, response, next) => {
    try {
      response.json(await manager.status());
    } catch (error) {
      next(error);
    }
  });
  router.post("/cli-auth/:provider/start", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      const provider = String(request.params.provider) as CliAuthProvider;
      if (!PROVIDERS.has(provider)) throw new Error("지원하지 않는 인증 공급자입니다.");
      manager.start(provider);
      writeAudit(database, request.authUser!.id, "cli_auth.start", "provider", provider);
      response.status(202).json({ accepted: true });
    } catch (error) {
      next(error);
    }
  });
  router.post("/cli-auth/:provider/stop", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      const provider = String(request.params.provider) as CliAuthProvider;
      if (!PROVIDERS.has(provider)) throw new Error("지원하지 않는 인증 공급자입니다.");
      manager.stop(provider);
      writeAudit(database, request.authUser!.id, "cli_auth.stop", "provider", provider);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });
  return router;
}
