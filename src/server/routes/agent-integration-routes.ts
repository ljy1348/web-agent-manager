import { Router } from "express";
import type { AppDatabase } from "../core/database";
import { requireAdmin, type AuthenticatedRequest } from "../core/auth";
import { writeAudit } from "../core/audit";
import { AgentIntegrationManager, type AgentIntegrationProvider } from "../services/agent-integration";

// 공급자 설치 감지와 관리자 전용 web-agent-manager 스킬·MCP 연결 API를 구성한다.
export function createAgentIntegrationRouter(database: AppDatabase, integrations: AgentIntegrationManager): Router {
  const router = Router();
  router.get("/agent-integrations", requireAdmin, async (_request, response, next) => {
    try {
      response.json(await integrations.status());
    } catch (error) {
      next(error);
    }
  });
  router.post("/agent-integrations/:provider/install", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    try {
      const provider = request.params.provider as AgentIntegrationProvider;
      if (provider !== "codex" && provider !== "claude") throw new Error("지원하지 않는 공급자입니다.");
      const result = await integrations.install(provider);
      writeAudit(database, request.authUser!.id, "agent.integration_install", "provider", provider, {
        skillsInstalled: result.skills.installed.length,
        skillsSkipped: result.skills.skipped.length,
      });
      response.json(result);
    } catch (error) {
      next(error);
    }
  });
  return router;
}
