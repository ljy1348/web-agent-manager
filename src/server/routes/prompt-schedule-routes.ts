import { Router } from "express";
import { requireAdmin, type AuthenticatedRequest } from "../core/auth";
import type { Provider } from "../../shared/types";
import { PromptScheduler, type PromptScheduleInput, type PromptScheduleMode } from "../services/prompt-scheduler";

function scheduleInput(body: Record<string, unknown> | undefined): PromptScheduleInput {
  return {
    name: typeof body?.name === "string" ? body.name : "",
    projectId: Number(body?.projectId),
    mode: body?.mode as PromptScheduleMode,
    provider: typeof body?.provider === "string" ? body.provider as Provider : null,
    accountId: body?.accountId == null || body.accountId === "" ? null : Number(body.accountId),
    chatId: body?.chatId == null || body.chatId === "" ? null : Number(body.chatId),
    prompt: typeof body?.prompt === "string" ? body.prompt : "",
    dailyTime: typeof body?.dailyTime === "string" ? body.dailyTime : "",
    timezone: typeof body?.timezone === "string" ? body.timezone : "",
    runDate: typeof body?.runDate === "string" ? body.runDate : null,
    enabled: body?.enabled !== false,
  };
}

// 관리자용 영구 프롬프트 일정 CRUD와 즉시 실행 API를 제공한다.
export function createPromptScheduleRouter(scheduler: PromptScheduler): Router {
  const router = Router();

  router.get("/prompt-schedules", requireAdmin, (_request, response) => {
    response.json({ schedules: scheduler.list() });
  });

  router.post("/prompt-schedules", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      response.status(201).json({ schedule: scheduler.create(scheduleInput(request.body), request.authUser!.id) });
    } catch (error) { next(error); }
  });

  router.put("/prompt-schedules/:id", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      response.json({ schedule: scheduler.update(Number(request.params.id), scheduleInput(request.body), request.authUser!.id) });
    } catch (error) { next(error); }
  });

  router.post("/prompt-schedules/:id/enabled", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      if (typeof request.body?.enabled !== "boolean") throw new Error("활성화 여부가 필요합니다.");
      response.json({ schedule: scheduler.setEnabled(Number(request.params.id), request.body.enabled, request.authUser!.id) });
    } catch (error) { next(error); }
  });

  router.post("/prompt-schedules/:id/run", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    try {
      response.json({ schedule: await scheduler.runNow(Number(request.params.id), request.authUser!.id) });
    } catch (error) { next(error); }
  });

  router.delete("/prompt-schedules/:id", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      const id = Number(request.params.id);
      scheduler.delete(id, request.authUser!.id);
      response.status(204).end();
    } catch (error) { next(error); }
  });

  return router;
}
