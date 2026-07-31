import { Router } from "express";
import type { AppDatabase } from "../core/database";
import { requireAdmin, type AuthenticatedRequest } from "../core/auth";
import { writeAudit } from "../core/audit";
import type { AgentBridge } from "../services/agent-bridge";

// 프로젝트의 위임 에이전트 목록과 새 자식 세션 작업 전달 API를 구성한다.
export function createAgentDelegationRouter(database: AppDatabase, bridge: Pick<AgentBridge, "execute">): Router {
  const router = Router();

  router.get("/projects/:id/agent-delegations", requireAdmin, (request, response, next) => {
    try {
      const projectId = Number(request.params.id);
      const project = database.prepare("SELECT id FROM projects WHERE id = ? AND active = 1").get(projectId);
      if (!project) throw new Error("프로젝트를 찾을 수 없습니다.");
      const delegations = database.prepare(`
        SELECT d.id, d.parent_delegation_id, d.depth, d.source_chat_id, d.target_chat_id,
               d.prompt, CASE WHEN d.completed_at IS NOT NULL THEN 'completed' ELSE d.status END AS status,
               d.error, d.completed_at, d.created_at, d.updated_at,
               source.provider AS source_provider, source.title AS source_title,
               target.provider AS target_provider, target.title AS target_title,
               target.status AS target_status, target.busy AS target_busy, target.model AS target_model
        FROM delegations d
        LEFT JOIN chats source ON source.id = d.source_chat_id
        JOIN chats target ON target.id = d.target_chat_id
        WHERE target.project_id = ?
        ORDER BY d.updated_at DESC
        LIMIT 100
      `).all(projectId);
      response.json({ delegations });
    } catch (error) {
      next(error);
    }
  });

  router.post("/agent-delegations", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    try {
      const result = await bridge.execute({
        method: "delegation.send",
        params: {
          sourceChatId: request.body?.sourceChatId,
          targetChatId: request.body?.targetChatId,
          projectId: request.body?.projectId,
          provider: request.body?.provider,
          prompt: request.body?.prompt,
          parentDelegationId: request.body?.parentDelegationId,
          idempotencyKey: request.body?.idempotencyKey,
          createNew: request.body?.createNew === true,
        },
      });
      const delegation = (result as { delegation?: { id?: string; target_chat_id?: number } })?.delegation;
      writeAudit(database, request.authUser!.id, "agent.delegation_create", "delegation", delegation?.id ?? null, {
        sourceChatId: Number(request.body?.sourceChatId) || null,
        targetChatId: delegation?.target_chat_id ?? null,
      });
      response.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
