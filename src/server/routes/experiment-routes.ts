import { Router } from "express";
import type { AppDatabase } from "../core/database";
import { requireAdmin, type AuthenticatedRequest } from "../core/auth";
import { writeAudit } from "../core/audit";
import { ExperimentCapacityError, type ExperimentService } from "../services/experiment-service";
import { AgentPresetService } from "../services/agent-preset-service";
import { parseExperimentVariantConfig } from "../../shared/experiments";

// Agent Lab 실험·Variant·run 조회와 관리자 쓰기 API를 구성한다.
export function createExperimentRouter(database: AppDatabase, service: ExperimentService): Router {
  const router = Router();
  const repository = service.repository;
  const presets = new AgentPresetService(database);

  // 실험 생성·조회 대상이 현재 활성 프로젝트인지 공통 검증한다.
  function requireActiveProject(projectId: number): void {
    if (!Number.isInteger(projectId) || projectId < 1) throw new Error("프로젝트 ID가 올바르지 않습니다.");
    const project = database.prepare("SELECT id FROM projects WHERE id = ? AND active = 1").get(projectId);
    if (!project) throw new Error("프로젝트를 찾을 수 없습니다.");
  }

  router.get("/projects/:id/experiments", requireAdmin, (request, response, next) => {
    try {
      const projectId = Number(request.params.id);
      requireActiveProject(projectId);
      const experiments = repository.listExperiments(projectId).map((experiment) => ({
        ...experiment,
        variants: repository.listVariants(experiment.id).map((variant) => ({
          ...variant, runs: repository.listRuns({ variantId: variant.id, limit: 20 }).map((run) => {
            const scores = repository.listJudgments(run.id).flatMap((judgment) => judgment.score === null ? [] : [judgment.score]);
            return {
              ...run,
              judgmentSummary: {
                count: scores.length,
                meanScore: scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null,
              },
            };
          }),
        })),
      }));
      response.json({ experiments });
    } catch (error) {
      next(error);
    }
  });

  router.post("/projects/:id/experiments", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      const projectId = Number(request.params.id);
      requireActiveProject(projectId);
      const experiment = repository.createExperiment({
        projectId, createdBy: request.authUser!.id,
        name: request.body?.name, command: request.body?.command,
        design: request.body?.design, rubric: request.body?.rubric,
      });
      writeAudit(database, request.authUser!.id, "experiment.create", "experiment", experiment.id, { projectId: experiment.projectId });
      response.status(201).json({ experiment });
    } catch (error) {
      next(error);
    }
  });

  router.post("/experiments/:id/variants", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      const config = parseExperimentVariantConfig(request.body?.config);
      service.assertSkillIsolationVariant(String(request.params.id), config);
      const variant = repository.createVariant({
        experimentId: String(request.params.id), name: request.body?.name,
        config, ordinal: request.body?.ordinal,
      });
      writeAudit(database, request.authUser!.id, "experiment.variant_create", "experiment_variant", variant.id, { experimentId: variant.experimentId });
      response.status(201).json({ variant });
    } catch (error) {
      next(error);
    }
  });

  router.get("/projects/:id/experiment-skills", requireAdmin, (request, response, next) => {
    try {
      const projectId = Number(request.params.id);
      requireActiveProject(projectId);
      const provider = request.query.provider;
      if (provider !== "codex" && provider !== "claude") throw new Error("스킬 후보 공급자가 올바르지 않습니다.");
      const rawAccountId = request.query.accountId;
      const accountId = rawAccountId == null || rawAccountId === "" ? null : Number(rawAccountId);
      if (accountId !== null && (!Number.isInteger(accountId) || accountId < 1)) throw new Error("스킬 후보 계정 ID가 올바르지 않습니다.");
      response.json({ candidates: service.listSkillCandidates(projectId, provider, accountId) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/experiment-variants/:id/runs", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    try {
      const run = await service.startVariant(String(request.params.id));
      writeAudit(database, request.authUser!.id, "experiment.run_start", "experiment_run", run.id, { variantId: run.variantId });
      response.status(202).json({ run });
    } catch (error) {
      if (error instanceof ExperimentCapacityError) {
        response.setHeader("Retry-After", "2");
        response.status(429).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  router.get("/experiments/:id/summary", requireAdmin, (request, response, next) => {
    try {
      response.json(service.summary(String(request.params.id)));
    } catch (error) {
      next(error);
    }
  });

  router.get("/experiments/:id/run-plans", requireAdmin, (request, response, next) => {
    try {
      response.json({ plans: service.repository.listRunPlans(String(request.params.id)) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/experiments/:id/run-plans", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      const plan = service.startRunPlan(String(request.params.id), request.body ?? {});
      writeAudit(database, request.authUser!.id, "experiment.run_plan_start", "experiment_run_plan", plan!.id, {
        stage: plan!.stage, items: plan!.items.length,
      });
      response.status(201).json({ plan });
    } catch (error) {
      next(error);
    }
  });

  router.post("/experiment-run-plans/:id/cancel", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      const plan = service.cancelRunPlan(String(request.params.id));
      writeAudit(database, request.authUser!.id, "experiment.run_plan_cancel", "experiment_run_plan", plan!.id, { status: plan!.status });
      response.json({ plan });
    } catch (error) {
      next(error);
    }
  });

  router.get("/projects/:id/experiment-fixtures", requireAdmin, (request, response, next) => {
    try {
      response.json({ fixtures: service.repository.listFixtures() });
    } catch (error) {
      next(error);
    }
  });

  router.post("/experiment-fixtures", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      const fixture = service.repository.createFixture(request.body);
      writeAudit(database, request.authUser!.id, "experiment.fixture_create", "experiment_fixture", fixture.id, {
        name: fixture.name, sizeClass: fixture.sizeClass,
      });
      response.status(201).json({ fixture });
    } catch (error) {
      next(error);
    }
  });

  router.get("/experiment-runs/:id", requireAdmin, (request, response, next) => {
    try {
      response.json(service.detail(String(request.params.id), Number(request.query.afterSequence) || 0));
    } catch (error) {
      next(error);
    }
  });

  router.post("/experiment-runs/:id/cancel", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    try {
      const run = await service.cancel(String(request.params.id));
      writeAudit(database, request.authUser!.id, "experiment.run_cancel", "experiment_run", run.id, { status: run.status });
      response.json({ run });
    } catch (error) {
      next(error);
    }
  });

  router.post("/experiment-runs/:id/evaluations", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    try {
      const evaluation = await service.startEvaluation(String(request.params.id), request.body?.evaluators);
      writeAudit(database, request.authUser!.id, "experiment.evaluation_start", "experiment_evaluation", evaluation.id, {
        runId: String(request.params.id), evaluatorCount: Array.isArray(request.body?.evaluators) ? request.body.evaluators.length : 0,
      });
      response.status(202).json({ evaluation });
    } catch (error) {
      if (error instanceof ExperimentCapacityError) {
        response.setHeader("Retry-After", "2");
        response.status(429).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  router.get("/experiment-evaluations/:id", requireAdmin, (request, response, next) => {
    try {
      response.json(service.evaluationDetail(String(request.params.id)));
    } catch (error) {
      next(error);
    }
  });

  router.post("/experiment-evaluations/:id/cancel", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    try {
      const evaluation = await service.cancelEvaluation(String(request.params.id));
      writeAudit(database, request.authUser!.id, "experiment.evaluation_cancel", "experiment_evaluation", evaluation.id, { status: evaluation.status });
      response.json({ evaluation });
    } catch (error) {
      next(error);
    }
  });

  router.get("/projects/:id/agent-presets", requireAdmin, (request, response, next) => {
    try {
      const projectId = Number(request.params.id);
      requireActiveProject(projectId);
      response.json({ presets: presets.list(projectId) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/experiment-runs/:id/promote", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      const preset = presets.promote({
        runId: String(request.params.id), userId: request.authUser!.id,
        name: request.body?.name, note: request.body?.note, activate: request.body?.activate,
      });
      writeAudit(database, request.authUser!.id, "experiment.run_promote", "agent_preset", preset.id, {
        runId: String(request.params.id), activeVersion: preset.activeVersion,
      });
      response.status(201).json({ preset });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
