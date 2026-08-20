import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import type { AppConfig } from "../core/config";
import type { AppDatabase } from "../core/database";
import { safeBasename } from "../core/security";
import { processMultipartFiles, streamToFile } from "../core/uploads";
import { writeAudit } from "../core/audit";
import { requireAdmin, type AuthenticatedRequest } from "../core/auth";
import { requireTrustedNetwork } from "../core/network";
import { resolveProjectPath } from "./helpers";
import type { Provider } from "../../shared/types";
import { CHAT_ATTACHMENT_MAX_FILES, CHAT_ATTACHMENT_MAX_FILE_BYTES, CHAT_ATTACHMENT_MAX_TOTAL_BYTES } from "../../shared/chat-attachments";
import type { SessionManager } from "../services/session-manager";
import type { ProviderAdapter } from "../providers/provider";
import type { HistoryCache } from "../services/history-cache";
import type { SessionBackupService } from "../services/session-backups";
import { installProjectAgentSkills } from "../services/agent-skill-installer";
import { GithubProjectService } from "../services/github-projects";
import type { GitWorkspaceService } from "../services/git-workspaces";
import type { AgentAccountService } from "../services/agent-accounts";

// 채팅 첨부 파일을 저장할 프로젝트 내 전용 디렉터리 이름.
const ATTACHMENTS_DIRNAME = ".web-agent-manager-uploads";
const DEFAULT_MESSAGE_LIMIT = 60;
const MAX_MESSAGE_LIMIT = 200;

// 채팅 선택/전송 흐름을 서버 로그에서 추적하기 위한 민감정보 없는 구조화 로그를 남긴다.
function logChatServer(event: string, details: Record<string, unknown>): void {
  console.debug("[web-agent-manager:chat:server]", event, { at: new Date().toISOString(), ...details });
}

// 이미 등록된 내부 공급자 세션을 채팅 목록 응답에서 제외한다.
function visibleChats(chats: Array<Record<string, unknown>>, adapterById: Map<Provider, ProviderAdapter>): Array<Record<string, unknown>> {
  return chats.filter((chat) => {
    const provider = chat.provider as Provider;
    const historyFile = typeof chat.history_file === "string" ? chat.history_file : "";
    const adapter = adapterById.get(provider);
    return !historyFile || !adapter?.isHiddenHistoryFile?.(historyFile);
  });
}

// 프로젝트·채팅·메시지 생명주기 API를 구성한다.
export function createProjectRouter(database: AppDatabase, config: AppConfig, sessions: SessionManager, adapters: ProviderAdapter[], accounts: AgentAccountService, historyCache: HistoryCache, backups?: SessionBackupService, gitWorkspaces?: GitWorkspaceService): Router {
  const router = Router();
  const adapterById = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  const githubProjects = new GithubProjectService(database, config);
  // 권한 정책: 조회·메시지 전송·승인 응답은 일반 사용자에게 열고, 프로젝트/세션/터미널 제어성 변경은 관리자만 허용한다.
  router.get("/projects", (_request, response) => {
    const projects = database.prepare(`
      SELECT p.*, COUNT(c.id) AS chat_count FROM projects p LEFT JOIN chats c ON c.project_id = p.id
      WHERE p.active = 1 GROUP BY p.id ORDER BY p.updated_at DESC
    `).all();
    // 프로젝트 추가 프롬프트 기본값·경로 표시 축약 기준: web-agent-manager가 설치된 계정의 홈 디렉터리(config.homeDir).
    response.json({ projects, defaultPath: config.homeDir });
  });
  router.post("/projects", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    try {
      const inputPath = typeof request.body?.path === "string" ? request.body.path : "";
      const result = await githubProjects.registerLocal({
        projectPath: inputPath,
        name: typeof request.body?.name === "string" ? request.body.name : undefined,
        createGithub: request.body?.createGithub === true,
        repository: typeof request.body?.repository === "string" ? request.body.repository : undefined,
        visibility: typeof request.body?.visibility === "string" ? request.body.visibility : undefined,
        description: typeof request.body?.description === "string" ? request.body.description : undefined,
      });
      const project = result.project;
      const integration = installProjectAgentSkills(project.path, config.rootDir);
      writeAudit(database, request.authUser!.id, "project.save", "project", (project as { id: number }).id, {
        path: project.path,
        githubRepository: result.repository?.nameWithOwner ?? null,
        installedAgentSkills: integration.installed.length,
        agentSkillErrors: integration.errors,
      });
      response.status(201).json({ project, repository: result.repository, agentSkills: integration });
    } catch (error) {
      next(error);
    }
  });
  // 인증된 GitHub 계정의 저장소와 프로젝트 연결 여부를 조회한다.
  router.get("/github/repositories", requireAdmin, async (_request, response, next) => {
    try {
      response.json(await githubProjects.listRepositories());
    } catch (error) {
      next(error);
    }
  });
  // 저장소를 clone하거나 이미 연결된 프로젝트를 재활성화한다.
  router.post("/github/projects", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    try {
      const repository = typeof request.body?.repository === "string" ? request.body.repository : "";
      const destination = typeof request.body?.destination === "string" ? request.body.destination : undefined;
      const result = await githubProjects.cloneProject(repository, destination);
      const integration = installProjectAgentSkills(result.project.path, config.rootDir);
      writeAudit(database, request.authUser!.id, "github.project.clone", "project", result.project.id, {
        repository,
        path: result.project.path,
        reused: result.reused,
        installedAgentSkills: integration.installed.length,
        agentSkillErrors: integration.errors,
      });
      response.status(result.reused ? 200 : 201).json({ ...result, agentSkills: integration });
    } catch (error) {
      next(error);
    }
  });
  // 프로젝트를 실제로 지우지 않고 active=0으로만 표시해 목록에서 숨긴다(채팅 기록·백업은 그대로 보존).
  router.delete("/projects/:id", requireAdmin, requireTrustedNetwork, (request: AuthenticatedRequest, response, next) => {
    try {
      const projectId = Number(request.params.id);
      const project = database.prepare("SELECT * FROM projects WHERE id = ? AND active = 1").get(projectId) as { id: number; path: string } | undefined;
      if (!project) throw new Error("프로젝트를 찾을 수 없습니다.");
      database.prepare("UPDATE projects SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(projectId);
      writeAudit(database, request.authUser!.id, "project.delete", "project", projectId, { path: project.path });
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });
  router.get("/chats", (request, response) => {
    const projectId = Number(request.query.projectId);
    const chats = Number.isInteger(projectId) && projectId > 0
      ? database.prepare(`
        SELECT c.*, CASE WHEN r.chat_id IS NULL THEN 0 ELSE 1 END AS rate_limit_waiting
        FROM chats c LEFT JOIN rate_limit_waits r ON r.chat_id = c.id
        WHERE c.project_id = ? ORDER BY c.updated_at DESC
      `).all(projectId)
      : database.prepare(`
        SELECT c.*, CASE WHEN r.chat_id IS NULL THEN 0 ELSE 1 END AS rate_limit_waiting
        FROM chats c LEFT JOIN rate_limit_waits r ON r.chat_id = c.id
        ORDER BY c.updated_at DESC LIMIT 300
      `).all();
    const visible = visibleChats(chats as Array<Record<string, unknown>>, adapterById);
    logChatServer("chats:list", {
      userId: (request as AuthenticatedRequest).authUser?.id ?? null,
      projectId: Number.isInteger(projectId) && projectId > 0 ? projectId : null,
      count: visible.length,
      firstChatId: visible[0]?.id ?? null,
    });
    response.json({ chats: visible });
  });
  router.get("/chats/:id", (request, response, next) => {
    try {
      const chatId = Number(request.params.id);
      logChatServer("chats:get", { userId: (request as AuthenticatedRequest).authUser?.id ?? null, chatId });
      const chat = database.prepare(`
        SELECT c.*, CASE WHEN r.chat_id IS NULL THEN 0 ELSE 1 END AS rate_limit_waiting
        FROM chats c LEFT JOIN rate_limit_waits r ON r.chat_id = c.id
        WHERE c.id = ?
      `).get(chatId) as Record<string, unknown> | undefined;
      if (!chat) throw new Error("채팅을 찾을 수 없습니다.");
      if (!visibleChats([chat], adapterById).length) throw new Error("채팅을 찾을 수 없습니다.");
      response.json({ chat });
    } catch (error) {
      next(error);
    }
  });
  router.get("/projects/:id/session-backups", (request, response, next) => {
    try {
      if (!backups) throw new Error("세션 백업 서비스가 준비되지 않았습니다.");
      response.json({ backups: backups.listProjectBackups(Number(request.params.id)) });
    } catch (error) {
      next(error);
    }
  });
  router.post("/session-backups/:id/restore", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      if (!backups) throw new Error("세션 백업 서비스가 준비되지 않았습니다.");
      const result = backups.restoreBackup(String(request.params.id), request.authUser!.id);
      response.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });
  router.delete("/session-backups/:id", requireAdmin, requireTrustedNetwork, (request: AuthenticatedRequest, response, next) => {
    try {
      if (!backups) throw new Error("세션 백업 서비스가 준비되지 않았습니다.");
      backups.deleteBackup(String(request.params.id), request.authUser!.id);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });
// 채팅 생성 시 고를 수 있는 preset 버전을 확정한다. 실행 중 preset이 바뀌어도 이미 시작한 작업이
// 흔들리지 않도록, 여기서 고른 버전의 설정 스냅샷을 채팅 행에 복사해 고정한다(14장).
function resolvePinnedPreset(
  database: AppDatabase,
  projectId: number,
  provider: Provider,
  body: { presetId?: unknown; presetVersionId?: unknown },
): { versionId: string; config: string; model: string | null } | null {
  const presetVersionId = typeof body.presetVersionId === "string" ? body.presetVersionId.trim() : "";
  const presetId = typeof body.presetId === "string" ? body.presetId.trim() : "";
  if (!presetVersionId && !presetId) return null;
  const row = presetVersionId
    ? database.prepare(`
        SELECT v.id, v.config_snapshot_json AS config, p.project_id AS projectId
        FROM agent_preset_versions v JOIN agent_presets p ON p.id = v.preset_id
        WHERE v.id = ?
      `).get(presetVersionId) as { id: string; config: string; projectId: number } | undefined
    : database.prepare(`
        SELECT v.id, v.config_snapshot_json AS config, p.project_id AS projectId
        FROM agent_presets p JOIN agent_preset_versions v ON v.preset_id = p.id AND v.version = p.active_version
        WHERE p.id = ?
      `).get(presetId) as { id: string; config: string; projectId: number } | undefined;
  if (!row) throw new Error("선택한 Agent preset 버전을 찾을 수 없습니다.");
  if (row.projectId !== projectId) throw new Error("다른 프로젝트의 Agent preset은 사용할 수 없습니다.");
  const config = JSON.parse(row.config) as { runtime?: { provider?: string; model?: string | null } };
  if (config.runtime?.provider && config.runtime.provider !== provider) {
    throw new Error(`이 preset은 ${config.runtime.provider} 전용이라 ${provider} 채팅에 쓸 수 없습니다.`);
  }
  return { versionId: row.id, config: row.config, model: config.runtime?.model ?? null };
}

  router.post("/chats", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    try {
      const projectId = Number(request.body?.projectId);
      const provider = request.body?.provider as Provider;
      const adapter = adapterById.get(provider);
      if (!Number.isInteger(projectId) || !adapter) throw new Error("프로젝트와 공급자가 필요합니다.");
      const project = database.prepare("SELECT id FROM projects WHERE id = ? AND active = 1").get(projectId);
      if (!project) throw new Error("프로젝트를 찾을 수 없습니다.");
      // 계정을 고르지 않았으면 그 공급자의 기본 계정(기존 ~/.claude·~/.codex 인증)으로 만든다.
      const account = accounts.requireForProvider(provider, request.body?.accountId != null ? Number(request.body.accountId) : null);
      const gitBranch = gitWorkspaces ? await gitWorkspaces.projectBranch(projectId).catch(() => null) : null;
      const pinned = resolvePinnedPreset(database, projectId, provider, request.body ?? {});
      const placeholder = `pending_${crypto.randomUUID().replaceAll("-", "")}`;
      const result = database.prepare(`
        INSERT INTO chats(project_id, provider, account_id, tmux_name, status, title, git_branch, preset_version_id, preset_config_json, model)
        VALUES (?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?)
      `).run(
        projectId, provider, account.id, placeholder, `새 ${adapter.displayLabel} 채팅`, gitBranch,
        pinned?.versionId ?? null, pinned?.config ?? null, pinned?.model ?? null,
      );
      const chatId = Number(result.lastInsertRowid);
      const tmuxName = `web_agent_manager_chat_${chatId}`;
      database.prepare("UPDATE chats SET tmux_name = ? WHERE id = ?").run(tmuxName, chatId);
      sessions.start(chatId, false);
      logChatServer("chats:create", { userId: request.authUser!.id, projectId, provider, chatId });
      writeAudit(database, request.authUser!.id, "chat.create", "chat", chatId, { provider, projectId });
      response.status(201).json({ chat: database.prepare("SELECT * FROM chats WHERE id = ?").get(chatId) });
    } catch (error) {
      next(error);
    }
  });
  // 이슈·브랜치로 작업을 시작할 때, 전용 worktree를 만들고 거기에 붙는 새 채팅을 함께 만든다.
  // 세션을 먼저 띄우면 실행 중 상태라 작업공간 전환이 막히므로, 채팅 행을 stopped로 만들어 worktree를
  // 붙인 다음 마지막에 세션을 시작한다.
  router.post("/chats/worktree", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    try {
      if (!gitWorkspaces) throw new Error("Git 작업공간 관리가 준비되지 않았습니다.");
      const projectId = Number(request.body?.projectId);
      const provider = request.body?.provider as Provider;
      const adapter = adapterById.get(provider);
      const branch = String(request.body?.branch ?? "").trim();
      const create = request.body?.create !== false;
      // 이미 존재하는 worktree 폴더를 지정하면 새로 만들지 않고 그 폴더에 채팅을 붙인다.
      // 앱 밖에서 만든 외부 worktree는 앱 관리 경로에 없어 브랜치만으로는 연결할 수 없기 때문이다.
      const worktreePath = String(request.body?.worktreePath ?? "").trim();
      if (!Number.isInteger(projectId) || !adapter) throw new Error("프로젝트와 공급자가 필요합니다.");
      if (!branch && !worktreePath) throw new Error("브랜치 이름이 필요합니다.");
      const project = database.prepare("SELECT id FROM projects WHERE id = ? AND active = 1").get(projectId);
      if (!project) throw new Error("프로젝트를 찾을 수 없습니다.");
      const title = typeof request.body?.title === "string" && request.body.title.trim()
        ? request.body.title.trim().slice(0, 120)
        : `${branch || path.basename(worktreePath)} 작업`;
      const account = accounts.requireForProvider(provider, request.body?.accountId != null ? Number(request.body.accountId) : null);
      const placeholder = `pending_${crypto.randomUUID().replaceAll("-", "")}`;
      const result = database.prepare(`
        INSERT INTO chats(project_id, provider, account_id, tmux_name, status, title) VALUES (?, ?, ?, ?, 'stopped', ?)
      `).run(projectId, provider, account.id, placeholder, title);
      const chatId = Number(result.lastInsertRowid);
      database.prepare("UPDATE chats SET tmux_name = ? WHERE id = ?").run(`web_agent_manager_chat_${chatId}`, chatId);
      try {
        if (worktreePath) await gitWorkspaces.attachWorktree(projectId, chatId, worktreePath);
        else await gitWorkspaces.switchBranch(projectId, { chatId, branch, create, mode: "worktree" });
      } catch (error) {
        // worktree를 못 만들면 빈 채팅만 남으므로 되돌린다.
        database.prepare("DELETE FROM chats WHERE id = ?").run(chatId);
        throw error;
      }
      sessions.start(chatId, false);
      logChatServer("chats:create_worktree", { userId: request.authUser!.id, projectId, provider, chatId, branch, worktreePath: worktreePath || null });
      writeAudit(database, request.authUser!.id, "chat.create_worktree", "chat", chatId, { provider, projectId, branch, create, worktreePath: worktreePath || null });
      response.status(201).json({ chat: database.prepare("SELECT * FROM chats WHERE id = ?").get(chatId) });
    } catch (error) {
      next(error);
    }
  });
  // DB에 미러링하지 않고 매 요청 JSONL을 다시 읽어 응답한다(history-cache가 파일 변경 없으면 재파싱을 건너뜀).
  // before=<messageId>로 그 이전 구간을 커서 페이지네이션하여, 세션이 아무리 길어도 응답 크기를 제한한다.
  router.get("/chats/:id/messages", (request, response, next) => {
    try {
      const chatId = Number(request.params.id);
      const chat = database.prepare("SELECT provider, history_file FROM chats WHERE id = ?").get(chatId) as { provider: Provider; history_file: string | null } | undefined;
      if (!chat) throw new Error("채팅을 찾을 수 없습니다.");
      const adapter = adapterById.get(chat.provider);
      if (!chat.history_file || !adapter) {
        response.json({ messages: [], hasMore: false });
        return;
      }
      const all = historyCache.get(adapter, chat.history_file)?.messages ?? [];
      const limit = Math.min(MAX_MESSAGE_LIMIT, Math.max(1, Number(request.query.limit) || DEFAULT_MESSAGE_LIMIT));
      const before = typeof request.query.before === "string" ? request.query.before : "";
      let endIndex = all.length;
      if (before) {
        const cursor = all.findIndex((message) => message.id === before);
        if (cursor >= 0) endIndex = cursor;
      }
      const startIndex = Math.max(0, endIndex - limit);
      response.json({ messages: all.slice(startIndex, endIndex), hasMore: startIndex > 0 });
    } catch (error) {
      next(error);
    }
  });
  router.post("/chats/:id/messages", async (request: AuthenticatedRequest, response, next) => {
    try {
      const chatId = Number(request.params.id);
      const text = typeof request.body?.text === "string" ? request.body.text.trim() : "";
      if (!text || text.length > 100_000) throw new Error("메시지는 1자 이상 100,000자 이하여야 합니다.");
      logChatServer("messages:send", { userId: request.authUser?.id ?? null, chatId, textLength: text.length });
      await sessions.sendPrompt(chatId, text, request.authUser!);
      response.status(202).json({ accepted: true });
    } catch (error) {
      next(error);
    }
  });
  router.post("/chats/:id/model", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    try {
      const modelIndex = Number(request.body?.modelIndex);
      const modelId = typeof request.body?.modelId === "string" && request.body.modelId.trim() ? request.body.modelId.trim() : null;
      const effortId = typeof request.body?.effortId === "string" && request.body.effortId.trim() ? request.body.effortId.trim() : null;
      await sessions.changeModel(Number(request.params.id), modelIndex, modelId, effortId, request.authUser!);
      response.status(202).json({ accepted: true });
    } catch (error) {
      next(error);
    }
  });
  router.post("/chats/:id/rename", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    try {
      const name = typeof request.body?.name === "string" ? request.body.name : "";
      await sessions.renameSession(Number(request.params.id), name, request.authUser!);
      response.status(202).json({ accepted: true });
    } catch (error) {
      next(error);
    }
  });
  router.post("/chats/:id/attachments", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    const chatId = Number(request.params.id);
    let projectPath: string;
    let chatProjectId: number;
    try {
      const chat = database.prepare(`
        SELECT c.project_id, p.path AS project_path FROM chats c JOIN projects p ON p.id = c.project_id WHERE c.id = ?
      `).get(chatId) as { project_id: number; project_path: string } | undefined;
      if (!chat) throw new Error("채팅을 찾을 수 없습니다.");
      chatProjectId = chat.project_id;
      projectPath = fs.realpathSync(chat.project_path);
    } catch (error) {
      next(error);
      return;
    }
    try {
      const uploadRelativeDir = path.join(ATTACHMENTS_DIRNAME, String(chatId));
      const uploadDir = resolveProjectPath(projectPath, uploadRelativeDir, false);
      fs.mkdirSync(uploadDir, { recursive: true, mode: 0o700 });
      const actualUploadDir = resolveProjectPath(projectPath, uploadRelativeDir);
      const uploads: Array<{ name: string; path: string; size: number }> = [];
      void processMultipartFiles(request, {
        destinationDir: actualUploadDir,
        maxFileBytes: CHAT_ATTACHMENT_MAX_FILE_BYTES,
        maxTotalBytes: CHAT_ATTACHMENT_MAX_TOTAL_BYTES,
        maxFiles: CHAT_ATTACHMENT_MAX_FILES,
      }, async (stream, info, accountBytes) => {
        const original = safeBasename(info.filename || "붙여넣기");
        const filename = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}_${original}`;
        const { size } = await streamToFile(stream, actualUploadDir, filename, {
          maxBytes: CHAT_ATTACHMENT_MAX_FILE_BYTES,
          accountBytes,
        });
        const relativePath = path.relative(projectPath, path.join(actualUploadDir, filename));
        const workspacePath = gitWorkspaces?.workspacePath(chatProjectId, chatId);
        if (workspacePath && workspacePath !== projectPath) {
          const workspaceUploadDir = resolveProjectPath(workspacePath, uploadRelativeDir, false);
          fs.mkdirSync(workspaceUploadDir, { recursive: true, mode: 0o700 });
          fs.copyFileSync(path.join(actualUploadDir, filename), resolveProjectPath(workspacePath, relativePath, false));
        }
        uploads.push({ name: original, path: relativePath, size });
      }).then(() => {
        writeAudit(database, request.authUser!.id, "chat.attachment", "chat", chatId, { uploads });
        response.status(201).json({ uploads });
      }).catch(next);
    } catch (error) {
      next(error);
    }
  });
  // 종료된 채팅을 웹에서 다시 시작한다. 저장된 공급자 세션 ID가 있으면 이어서 재개한다.
  router.post("/chats/:id/start", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      const chatId = Number(request.params.id);
      const chat = database.prepare("SELECT provider_session_id FROM chats WHERE id = ?").get(chatId) as { provider_session_id: string | null } | undefined;
      if (!chat) throw new Error("채팅을 찾을 수 없습니다.");
      sessions.start(chatId, !!chat.provider_session_id);
      writeAudit(database, request.authUser!.id, "chat.start", "chat", chatId);
      response.status(202).json({ accepted: true });
    } catch (error) {
      next(error);
    }
  });
  router.post("/chats/:id/stop", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    try {
      await sessions.stop(Number(request.params.id), request.authUser!);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });
  // 작업중인 응답을 ESC로 중단시킨다(터미널 자체는 유지, stop과 달리 세션을 끝내지 않는다).
  router.post("/chats/:id/interrupt", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    try {
      await sessions.interrupt(Number(request.params.id), request.authUser!);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });
  // Shift+Tab을 보내 Claude Code CLI의 기본·auto-accept edits·plan mode를 순환 전환한다.
  router.post("/chats/:id/mode-cycle", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    try {
      sessions.cycleMode(Number(request.params.id), request.authUser!);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });
  router.post("/chats/:id/backup", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      if (!backups) throw new Error("세션 백업 서비스가 준비되지 않았습니다.");
      const backup = backups.backupChat(Number(request.params.id), request.authUser!.id);
      response.status(201).json({ backup });
    } catch (error) {
      next(error);
    }
  });
  router.delete("/chats/:id", requireAdmin, requireTrustedNetwork, async (request: AuthenticatedRequest, response, next) => {
    try {
      if (!backups) throw new Error("세션 백업 서비스가 준비되지 않았습니다.");
      const chatId = Number(request.params.id);
      const chat = database.prepare("SELECT status FROM chats WHERE id = ?").get(chatId) as { status: string } | undefined;
      if (!chat) throw new Error("채팅을 찾을 수 없습니다.");
      if (chat.status !== "stopped") await sessions.stop(chatId, request.authUser!);
      const backup = request.query.backup === "0" ? null : backups.backupChat(chatId, request.authUser!.id);
      const workspace = await gitWorkspaces?.removeChatWorktree(chatId);
      backups.deleteChat(chatId, request.authUser!.id);
      response.json({ deleted: true, backup, workspace: workspace ?? null });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
