import { Router } from "express";
import type { AppDatabase } from "../core/database";
import { requireAdmin, type AuthenticatedRequest } from "../core/auth";
import { requireTrustedNetwork } from "../core/network";
import { writeAudit } from "../core/audit";
import type { RemoteWorkerService } from "../services/remote-worker";

export function createRemoteWorkerRouter(database: AppDatabase, workers: RemoteWorkerService): Router {
  const router = Router();
  router.get("/remote-workers", requireAdmin, (_request, response, next) => {
    try { response.json({ hosts: workers.list() }); } catch (error) { next(error); }
  });
  router.get("/remote-worker-mappings", requireAdmin, (_request, response, next) => {
    try { response.json({ mappings: workers.listMappings() }); } catch (error) { next(error); }
  });
  router.put("/projects/:projectId/remote-worker-mapping", requireAdmin, requireTrustedNetwork, (request: AuthenticatedRequest, response, next) => {
    try {
      const mapping = workers.saveMapping(Number(request.params.projectId), request.body ?? {}, request.authUser!.id);
      writeAudit(database, request.authUser!.id, "remote_worker.mapping.update", "project", String(request.params.projectId), { mappingId: mapping.id, hostId: mapping.hostId, enabled: mapping.enabled });
      response.json({ mapping });
    } catch (error) { next(error); }
  });
  router.delete("/projects/:projectId/remote-worker-mapping", requireAdmin, requireTrustedNetwork, (request: AuthenticatedRequest, response, next) => {
    try {
      workers.removeMapping(Number(request.params.projectId));
      writeAudit(database, request.authUser!.id, "remote_worker.mapping.delete", "project", String(request.params.projectId));
      response.status(204).end();
    } catch (error) { next(error); }
  });
  router.get("/tasks/:taskId/remote-dispatches", requireAdmin, (request, response, next) => {
    try { response.json(workers.listDispatches(String(request.params.taskId))); } catch (error) { next(error); }
  });
  router.post("/tasks/:taskId/remote-dispatches", requireAdmin, requireTrustedNetwork, async (request: AuthenticatedRequest, response, next) => {
    try {
      const result = await workers.dispatch(String(request.params.taskId), request.body?.capability, request.header("Idempotency-Key"), request.authUser!.id);
      writeAudit(database, request.authUser!.id, "remote_worker.dispatch", "agent_task", String(request.params.taskId), { dispatchId: result.dispatch.id, hostId: result.dispatch.hostId, capability: result.dispatch.capability, state: result.dispatch.state, replayed: result.replayed });
      response.status(result.replayed ? 200 : 202).json(result);
    } catch (error) { next(error); }
  });
  router.post("/tasks/:taskId/remote-dispatches/:dispatchId/refresh", requireAdmin, requireTrustedNetwork, async (request: AuthenticatedRequest, response, next) => {
    try {
      const dispatch = await workers.refreshDispatch(String(request.params.taskId), String(request.params.dispatchId));
      writeAudit(database, request.authUser!.id, "remote_worker.dispatch.refresh", "remote_worker_dispatch", String(dispatch.id), { hostId: dispatch.hostId, capability: dispatch.capability, state: dispatch.state });
      response.json({ dispatch });
    } catch (error) { next(error); }
  });
  router.post("/remote-workers", requireAdmin, requireTrustedNetwork, (request: AuthenticatedRequest, response, next) => {
    try {
      const host = workers.save(null, request.body ?? {}, request.authUser!.id);
      writeAudit(database, request.authUser!.id, "remote_worker.create", "remote_worker", String(host.id), { name: host.name, hostname: host.hostname, port: host.port, username: host.username, hostKeyFingerprint: host.hostKeyFingerprint });
      response.status(201).json({ host });
    } catch (error) { next(error); }
  });
  router.put("/remote-workers/:id", requireAdmin, requireTrustedNetwork, (request: AuthenticatedRequest, response, next) => {
    try {
      const host = workers.save(String(request.params.id), request.body ?? {}, request.authUser!.id);
      writeAudit(database, request.authUser!.id, "remote_worker.update", "remote_worker", String(host.id), { name: host.name, hostname: host.hostname, port: host.port, username: host.username, hostKeyFingerprint: host.hostKeyFingerprint, keyRotated: request.body?.privateKey !== undefined });
      response.json({ host });
    } catch (error) { next(error); }
  });
  router.post("/remote-workers/:id/probe", requireAdmin, requireTrustedNetwork, async (request: AuthenticatedRequest, response, next) => {
    try {
      const host = await workers.probe(String(request.params.id));
      writeAudit(database, request.authUser!.id, "remote_worker.probe", "remote_worker", String(host.id), { status: host.status, protocolVersion: host.protocolVersion, capabilities: host.capabilities, latencyMs: host.lastLatencyMs });
      response.json({ host });
    } catch (error) { next(error); }
  });
  router.delete("/remote-workers/:id", requireAdmin, requireTrustedNetwork, (request: AuthenticatedRequest, response, next) => {
    try {
      const id = String(request.params.id); workers.remove(id);
      writeAudit(database, request.authUser!.id, "remote_worker.delete", "remote_worker", id);
      response.status(204).end();
    } catch (error) { next(error); }
  });
  return router;
}
