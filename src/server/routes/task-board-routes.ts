import { Router } from "express";
import type { AppDatabase } from "../core/database";
import { requireAdmin, type AuthenticatedRequest } from "../core/auth";
import { writeAudit } from "../core/audit";
import type { Provider } from "../../shared/types";
import { TaskBoardService } from "../services/task-board";

function idempotencyKey(request: AuthenticatedRequest): string {
  const value = String(request.header("Idempotency-Key") ?? "").trim();
  if (!value || value.length > 200) throw new Error("유효한 Idempotency-Key가 필요합니다.");
  return value;
}

export function createTaskBoardRouter(database: AppDatabase, board: TaskBoardService): Router {
  const router = Router();
  router.get("/task-board", (request, response, next) => {
    try { response.json(board.list(request.query.limit === undefined ? 500 : Number(request.query.limit))); }
    catch (error) { next(error); }
  });
  router.patch("/tasks/:taskId/plan", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      const taskId = String(request.params.taskId);
      const result = board.update(taskId, request.body ?? {}, idempotencyKey(request));
      writeAudit(database, request.authUser!.id, "task.plan_update", "agent_task", taskId);
      response.json(result);
    } catch (error) { next(error); }
  });
  router.post("/tasks/:taskId/routing/recommend", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      const taskId = String(request.params.taskId);
      const result = board.recommend(taskId, idempotencyKey(request), request.authUser!.id);
      writeAudit(database, request.authUser!.id, "task.routing_recommend", "agent_task", taskId, { recommendationId: (result.recommendation as Record<string, unknown>).id });
      response.status(201).json(result);
    } catch (error) { next(error); }
  });
  router.post("/tasks/:taskId/routing/apply", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      const taskId = String(request.params.taskId);
      const provider = String(request.body?.provider) as Provider;
      if (!["codex", "claude", "grok"].includes(provider)) throw new Error("공급자가 올바르지 않습니다.");
      const accountId = Number(request.body?.accountId);
      if (!Number.isSafeInteger(accountId) || accountId < 1) throw new Error("계정 ID가 올바르지 않습니다.");
      const recommendationId = String(request.body?.recommendationId ?? "");
      const result = board.apply(taskId, recommendationId, provider, accountId, request.authUser!.id);
      writeAudit(database, request.authUser!.id, "task.routing_apply", "agent_task", taskId, { recommendationId, provider, accountId });
      response.json(result);
    } catch (error) { next(error); }
  });
  router.put("/task-board/limits/:scopeType/:scopeId", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      const scopeType = String(request.params.scopeType) as "project" | "provider" | "account";
      const scopeId = String(request.params.scopeId);
      board.setLimit(scopeType, scopeId, Number(request.body?.maxRunning), request.authUser!.id);
      writeAudit(database, request.authUser!.id, "task.concurrency_limit_update", "task_concurrency_limit", `${scopeType}:${scopeId}`, { maxRunning: Number(request.body?.maxRunning) });
      response.json({ limits: board.limits() });
    } catch (error) { next(error); }
  });
  router.post("/task-board/queue/reconcile", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      const result = board.reconcileQueue();
      writeAudit(database, request.authUser!.id, "task.queue_reconcile", "task_queue", "global", { admitted: result.admitted.length, released: result.released.length });
      response.json(result);
    } catch (error) { next(error); }
  });
  return router;
}
