import { Router } from "express";
import type { AppDatabase } from "../core/database";
import { requireAdmin, type AuthenticatedRequest } from "../core/auth";
import { requireTrustedNetwork } from "../core/network";
import { writeAudit } from "../core/audit";
import type { LivePreviewService } from "../services/live-preview";

export function createLivePreviewRouter(database: AppDatabase, previews: LivePreviewService): Router {
  const router = Router();
  router.get("/projects/:projectId/preview-target", (request, response, next) => {
    try { response.json({ target: previews.target(Number(request.params.projectId)) }); }
    catch (error) { next(error); }
  });
  router.get("/projects/:projectId/preview-candidates", requireAdmin, async (request, response, next) => {
    try { response.json({ candidates: await previews.discoverTargets(Number(request.params.projectId)) }); }
    catch (error) { next(error); }
  });
  router.put("/projects/:projectId/preview-target", requireAdmin, requireTrustedNetwork, (request: AuthenticatedRequest, response, next) => {
    try {
      const projectId = Number(request.params.projectId);
      const target = previews.setTarget(projectId, request.body ?? {}, request.authUser!.id);
      writeAudit(database, request.authUser!.id, "workbench.preview_target_update", "project", projectId, { url: target.url, viewportWidth: target.viewportWidth, viewportHeight: target.viewportHeight });
      response.json({ target });
    } catch (error) { next(error); }
  });
  router.post("/tasks/:taskId/preview-captures", requireAdmin, requireTrustedNetwork, async (request: AuthenticatedRequest, response, next) => {
    try {
      const taskId = String(request.params.taskId);
      const artifact = await previews.capture(taskId, request.authUser!.id);
      writeAudit(database, request.authUser!.id, "workbench.preview_capture", "agent_task", taskId, { artifactId: artifact.id, sha256: artifact.sha256, sizeBytes: artifact.sizeBytes });
      response.status(201).json({ artifact });
    } catch (error) { next(error); }
  });
  router.get("/tasks/:taskId/visual-baseline", requireAdmin, (request, response, next) => {
    try { response.json({ baseline: previews.visualBaseline(String(request.params.taskId)) }); }
    catch (error) { next(error); }
  });
  router.put("/tasks/:taskId/visual-baseline", requireAdmin, requireTrustedNetwork, (request: AuthenticatedRequest, response, next) => {
    try {
      const taskId = String(request.params.taskId);
      const baseline = previews.setVisualBaseline(taskId, String(request.body?.artifactId ?? ""), request.authUser!.id);
      writeAudit(database, request.authUser!.id, "workbench.visual_baseline_set", "agent_task", taskId, { artifactId: baseline.artifactId, sha256: baseline.sha256 });
      response.json({ baseline });
    } catch (error) { next(error); }
  });
  router.post("/tasks/:taskId/visual-checks", requireAdmin, requireTrustedNetwork, async (request: AuthenticatedRequest, response, next) => {
    try {
      const taskId = String(request.params.taskId);
      const result = await previews.visualCheck(taskId, request.authUser!.id);
      writeAudit(database, request.authUser!.id, "workbench.visual_check", "agent_task", taskId, { comparable: result.comparable,
        changedPixels: result.changedPixels ?? null, changedRatio: result.changedRatio ?? null, diffArtifactId: (result.diffArtifact as any)?.id ?? null });
      response.status(201).json({ result });
    } catch (error) { next(error); }
  });
  router.get("/tasks/:taskId/workbench-artifacts", requireAdmin, (request, response, next) => {
    try { response.json({ artifacts: previews.list(String(request.params.taskId)) }); }
    catch (error) { next(error); }
  });
  router.get("/workbench-artifacts/:artifactId", requireAdmin, (request, response, next) => {
    try {
      const artifact = previews.file(String(request.params.artifactId));
      response.type("image/png").set("Cache-Control", "private, no-store").download(artifact.path, artifact.filename);
    } catch (error) { next(error); }
  });
  return router;
}
