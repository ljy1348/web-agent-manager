import { Router } from "express";
import type { AppDatabase } from "../core/database";
import { requireAdmin, type AuthenticatedRequest } from "../core/auth";
import { writeAudit } from "../core/audit";
import { type CliAuthProvider, CliAuthManager } from "../services/cli-auth";

const PROVIDERS = new Set<CliAuthProvider>(["codex", "claude", "grok", "github"]);

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
  // accountId를 주면 그 계정 슬롯의 설정 디렉터리로 로그인한다. 생략하면 기본 계정이다(GitHub은 항상 무시).
  const readAccountId = (value: unknown): number | null => (value == null || value === "" ? null : Number(value));
  router.post("/cli-auth/:provider/start", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      const provider = String(request.params.provider) as CliAuthProvider;
      if (!PROVIDERS.has(provider)) throw new Error("지원하지 않는 인증 공급자입니다.");
      const accountId = readAccountId(request.body?.accountId);
      manager.start(provider, accountId);
      writeAudit(database, request.authUser!.id, "cli_auth.start", "provider", provider, { accountId });
      response.status(202).json({ accepted: true });
    } catch (error) {
      next(error);
    }
  });
  router.post("/cli-auth/:provider/stop", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      const provider = String(request.params.provider) as CliAuthProvider;
      if (!PROVIDERS.has(provider)) throw new Error("지원하지 않는 인증 공급자입니다.");
      const accountId = readAccountId(request.body?.accountId);
      manager.stop(provider, accountId);
      writeAudit(database, request.authUser!.id, "cli_auth.stop", "provider", provider, { accountId });
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });
  return router;
}
