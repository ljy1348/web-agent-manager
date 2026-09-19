import { Router } from "express";
import { requireAdmin, requireTestOperator, type AuthenticatedRequest } from "../core/auth";
import type { VerificationService } from "../services/verification-service";
import { writeAudit } from "../core/audit";
import type { AppDatabase } from "../core/database";

export function createVerificationRouter(database: AppDatabase, verifications: VerificationService): Router {
  const router = Router();
  router.get("/chats/:chatId/current-task", (request, response, next) => {
    try {
      const chatId = Number(request.params.chatId);
      if (!Number.isInteger(chatId) || chatId < 1) throw new Error("채팅 ID가 올바르지 않습니다.");
      response.json(verifications.currentForChat(chatId));
    } catch (error) { next(error); }
  });
  router.get("/tasks/:taskId/verifications", (request, response, next) => {
    try {
      const requestedLimit = request.query.limit === undefined ? 100 : Number(request.query.limit);
      if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) throw new Error("검증 조회 개수는 1~100이어야 합니다.");
      response.json({ verifications: verifications.list(String(request.params.taskId), requestedLimit) });
    } catch (error) { next(error); }
  });
  router.post("/tasks/:taskId/verifications", requireTestOperator, async (request: AuthenticatedRequest, response, next) => {
    try {
      const idempotencyKey = String(request.header("Idempotency-Key") ?? "").trim();
      if (!idempotencyKey || idempotencyKey.length > 200) throw new Error("유효한 Idempotency-Key가 필요합니다.");
      const taskId = String(request.params.taskId);
      const rawPullRequestNumber = request.body?.pullRequestNumber;
      const pullRequestNumber = rawPullRequestNumber === undefined || rawPullRequestNumber === null || rawPullRequestNumber === "" ? undefined : Number(rawPullRequestNumber);
      if (pullRequestNumber !== undefined && (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1)) throw new Error("PR 번호가 올바르지 않습니다.");
      const verification = await verifications.run(taskId, idempotencyKey, request.authUser!.id, { pullRequestNumber });
      writeAudit(database, request.authUser!.id, "task.verification_run", "agent_task", taskId, { idempotencyKey, pullRequestNumber: pullRequestNumber ?? null, state: (verification.run as Record<string, unknown>).state });
      response.status(202).json({ verification });
    } catch (error) { next(error); }
  });
  router.get("/verification-artifacts/:artifactId", requireAdmin, (request, response, next) => {
    try {
      const artifact = verifications.artifactForDownload(String(request.params.artifactId));
      response.type(artifact.mimeType);
      response.download(artifact.path, artifact.filename, (error) => { if (error && !response.headersSent) next(error); });
    } catch (error) { next(error); }
  });
  router.post("/verifications/:runId/decision", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    try {
      const idempotencyKey = String(request.header("Idempotency-Key") ?? "").trim();
      const decision = String(request.body?.decision ?? "");
      if (!idempotencyKey || idempotencyKey.length > 200) throw new Error("유효한 Idempotency-Key가 필요합니다.");
      if (decision !== "approve" && decision !== "decline") throw new Error("검증 승인 결정을 확인해주세요.");
      const runId = String(request.params.runId);
      const verification = await verifications.decideBlockedRun(runId, decision, idempotencyKey, request.authUser!.id);
      writeAudit(database, request.authUser!.id, "task.verification_decision", "verification_run", runId, { decision, state: (verification.run as Record<string, unknown>).state });
      response.json({ verification });
    } catch (error) { next(error); }
  });
  router.post("/verifications/:runId/rerun", requireTestOperator, async (request: AuthenticatedRequest, response, next) => {
    try {
      const idempotencyKey = String(request.header("Idempotency-Key") ?? "").trim();
      if (!idempotencyKey || idempotencyKey.length > 200) throw new Error("유효한 Idempotency-Key가 필요합니다.");
      const sourceRunId = String(request.params.runId);
      const verification = await verifications.rerun(sourceRunId, idempotencyKey, request.authUser!.id);
      writeAudit(database, request.authUser!.id, "task.verification_rerun", "verification_run", sourceRunId, {
        idempotencyKey, newRunId: (verification.run as Record<string, unknown>).id, state: (verification.run as Record<string, unknown>).state,
      });
      response.status(202).json({ verification });
    } catch (error) { next(error); }
  });
  return router;
}
