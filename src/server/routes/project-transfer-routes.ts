import { Router, type Request } from "express";
import type { AppDatabase } from "../core/database";
import { requireAdmin, requireNonTemporarySession, type AuthenticatedRequest } from "../core/auth";
import { writeAudit } from "../core/audit";
import type { FederationService } from "../services/federation";
import { scanProject, type ProjectTransferReceiver, type ProjectTransferSender } from "../services/project-transfer";

interface ProjectRow { id: number; name: string; path: string }

function activeProject(database: AppDatabase, request: Request): ProjectRow {
  const project = database.prepare("SELECT id, name, path FROM projects WHERE id = ? AND active = 1").get(Number(request.params.id)) as ProjectRow | undefined;
  if (!project) throw Object.assign(new Error("프로젝트를 찾을 수 없습니다."), { statusCode: 404 });
  return project;
}

// 작업 중인 채팅이 있으면 복사 도중 파일이 바뀌어 어긋난 스냅샷이 넘어가므로 막는다.
function busyChatIds(database: AppDatabase, projectId: number): number[] {
  return (database.prepare("SELECT id FROM chats WHERE project_id = ? AND busy = 1").all(projectId) as Array<{ id: number }>).map((row) => row.id);
}

// 프로젝트를 연결 컴퓨터로 복사하는 메인 쪽 API와, 분할 업로드를 받아 등록·환경 재구성하는 서브 쪽 API를 구성한다(#137).
export function createProjectTransferRouter(database: AppDatabase, federation: FederationService, sender: ProjectTransferSender, receiver: ProjectTransferReceiver): Router {
  const router = Router();
  router.get("/projects/:id/transfer-preview", requireAdmin, (request, response) => {
    const project = activeProject(database, request);
    const scan = scanProject(project.path);
    response.json({ fileCount: scan.fileCount, bytes: scan.bytes, steps: scan.steps, warnings: scan.warnings.slice(0, 50), busyChats: busyChatIds(database, project.id) });
  });
  router.post("/projects/:id/transfer", requireAdmin, requireNonTemporarySession, (request: AuthenticatedRequest, response, next) => {
    const project = activeProject(database, request);
    const nodeId = String(request.body?.nodeId ?? "");
    if (!federation.get(nodeId)) return response.status(404).json({ error: "연결된 컴퓨터를 찾을 수 없습니다." });
    const busy = busyChatIds(database, project.id);
    if (busy.length) return response.status(409).json({ error: `작업 중인 채팅(${busy.map((id) => `#${id}`).join(", ")})이 끝난 뒤에 옮기세요.` });
    const destinationPath = typeof request.body?.destinationPath === "string" && request.body.destinationPath.trim() ? request.body.destinationPath.trim() : undefined;
    const name = typeof request.body?.name === "string" && request.body.name.trim() ? request.body.name.trim() : project.name;
    const scan = scanProject(project.path);
    void sender.start(nodeId, project.id, project.path, scan, { name, destinationPath, sourcePath: project.path, steps: scan.steps }).then((transfer) => {
      writeAudit(database, request.authUser!.id, "project.transfer", "project", project.id, { nodeId, destination: transfer.destination, files: scan.fileCount, bytes: scan.bytes, steps: scan.steps.length });
      response.status(202).json({ transfer, warnings: scan.warnings.slice(0, 50) });
    }).catch(next);
  });
  router.get("/project-transfers/:id", requireAdmin, (request, response) => {
    const transfer = sender.get(String(request.params.id));
    if (!transfer) return response.status(404).json({ error: "보내기 작업을 찾을 수 없습니다. 서버가 재시작되었다면 대상 컴퓨터의 프로젝트 목록을 확인하세요." });
    response.json({ transfer });
  });

  // 아래는 대상(서브) 쪽 API. 메인 WAM이 federation 연결 토큰으로 호출한다.
  router.post("/project-transfer/uploads", requireAdmin, requireNonTemporarySession, (request, response) => {
    response.status(201).json(receiver.startUpload(request.body?.plan));
  });
  router.post("/project-transfer/uploads/:id/chunks/:index", requireAdmin, requireNonTemporarySession, (request, response, next) => {
    void receiver.appendChunk(String(request.params.id), Number(request.params.index), request).then((result) => response.json(result)).catch(next);
  });
  router.post("/project-transfer/uploads/:id/complete", requireAdmin, requireNonTemporarySession, (request: AuthenticatedRequest, response, next) => {
    void receiver.completeUpload(String(request.params.id)).then((job) => {
      writeAudit(database, request.authUser!.id, "project.transfer_receive", "project", job.projectId, { federation: Boolean(request.federationAuthenticated), path: job.projectPath, steps: job.steps.length });
      response.status(201).json({ job });
    }).catch(next);
  });
  router.delete("/project-transfer/uploads/:id", requireAdmin, requireNonTemporarySession, (request, response) => {
    receiver.abortUpload(String(request.params.id));
    response.status(204).end();
  });
  router.get("/project-transfer/jobs/:id", requireAdmin, (request, response) => {
    const job = receiver.getJob(String(request.params.id));
    if (!job) return response.status(404).json({ error: "이전 작업을 찾을 수 없습니다." });
    response.json({ job });
  });
  return router;
}
