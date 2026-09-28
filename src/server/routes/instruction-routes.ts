import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Router } from "express";
import type { AppDatabase } from "../core/database";
import { requireAdmin, type AuthenticatedRequest } from "../core/auth";
import { writeAudit } from "../core/audit";
import { chatWorkspacePath, resolveProjectPath, writeFileAtomic } from "./helpers";
import type { GitWorkspaceService } from "../services/git-workspaces";
import { PROJECT_INSTRUCTION_FILES } from "../core/instruction-files";

const projectInstructions = PROJECT_INSTRUCTION_FILES;

// 전역 지침 파일 위치. Codex는 WAM이 실행할 때 쓰는 CODEX_HOME(설치 계정 홈의 ~/.codex)이어야 한다 —
// 프로세스 HOME 기준으로 두면 화면에서 고친 전역 지침을 WAM의 Codex가 읽지 않았다(#146).
export interface GlobalInstructionDirs { claudeHome: string; codexHome: string }

function globalInstructionFiles(dirs: GlobalInstructionDirs): Record<string, string> {
  return {
    "codex/AGENTS.md": path.join(dirs.codexHome, "AGENTS.md"),
    "codex/AGENTS.override.md": path.join(dirs.codexHome, "AGENTS.override.md"),
    "claude/CLAUDE.md": path.join(dirs.claudeHome, "CLAUDE.md"),
  };
}

// 허용 목록의 지침 파일 경로만 실제 경로로 변환한다.
function resolveInstruction(globalInstructions: Record<string, string>, database: AppDatabase, workspaces: GitWorkspaceService | undefined, scope: string, name: string, projectId?: number, chatId?: number | null): string {
  if (scope === "global") {
    const target = globalInstructions[name];
    if (!target) throw new Error("허용되지 않은 전역 지침 파일입니다.");
    return target;
  }
  if (!projectInstructions.includes(name) || !projectId) throw new Error("허용되지 않은 프로젝트 지침 파일입니다.");
  const root = chatWorkspacePath(database, workspaces, projectId, chatId);
  return resolveProjectPath(root, name, fs.existsSync(path.join(root, name)));
}

// Claude가 Codex용 AGENTS.md를 같은 지침으로 읽도록 CLAUDE.md import를 보장한다.
function ensureClaudeImportsAgents(agentsFile: string, claudeFile: string, importPath: string): { changed: boolean; content: string } {
  if (!fs.existsSync(agentsFile)) writeFileAtomic(agentsFile, "# 공통 에이전트 지침\n\n");
  const existing = fs.existsSync(claudeFile) ? fs.readFileSync(claudeFile, "utf8") : "";
  const importPattern = new RegExp(`^\\s*@${importPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
  if (importPattern.test(existing)) return { changed: false, content: existing };
  const header = `@${importPath}\n\n<!-- web-agent-manager: Claude가 Codex와 같은 공통 지침을 읽도록 AGENTS.md를 import합니다. -->`;
  const content = existing.trim() ? `${header}\n\n${existing.replace(/^\s+/, "")}` : `${header}\n\n## Claude 전용 지침\n\n`;
  writeFileAtomic(claudeFile, content);
  return { changed: true, content };
}

// scope에 맞는 AGENTS.md와 CLAUDE.md 경로, Claude import 경로를 계산한다.
function resolveInstructionPair(globalInstructions: Record<string, string>, database: AppDatabase, workspaces: GitWorkspaceService | undefined, scope: string, projectId?: number, chatId?: number | null): { agentsFile: string; claudeFile: string; importPath: string } {
  if (scope === "global") {
    const agentsFile = globalInstructions["codex/AGENTS.md"];
    const claudeFile = globalInstructions["claude/CLAUDE.md"];
    // 두 홈이 달라도(예: /root/.claude와 /home/ubuntu/.codex) 실제 Codex 지침을 가리키도록 상대 경로를 계산한다.
    return { agentsFile, claudeFile, importPath: path.relative(path.dirname(claudeFile), agentsFile).split(path.sep).join("/") };
  }
  if (!projectId) throw new Error("프로젝트가 필요합니다.");
  const root = chatWorkspacePath(database, workspaces, projectId, chatId);
  return {
    agentsFile: resolveProjectPath(root, "AGENTS.md", fs.existsSync(path.join(root, "AGENTS.md"))),
    claudeFile: resolveProjectPath(root, "CLAUDE.md", fs.existsSync(path.join(root, "CLAUDE.md"))),
    importPath: "AGENTS.md",
  };
}

// 프로젝트와 전역 AGENTS.md·CLAUDE.md 읽기·쓰기 API를 구성한다.
export function createInstructionRouter(database: AppDatabase, workspaces?: GitWorkspaceService, dirs: GlobalInstructionDirs = { claudeHome: path.join(os.homedir(), ".claude"), codexHome: path.join(os.homedir(), ".codex") }): Router {
  const router = Router();
  const globalInstructions = globalInstructionFiles(dirs);
  // 권한 정책: 지침 조회는 로그인 사용자에게 허용하고, 영구 지침 변경은 관리자만 허용한다.
  router.get("/instructions", (request, response, next) => {
    try {
      const scope = String(request.query.scope ?? "project");
      const name = String(request.query.name ?? "");
      const projectId = Number(request.query.projectId) || undefined;
      const target = resolveInstruction(globalInstructions, database, workspaces, scope, name, projectId, Number(request.query.chatId) || null);
      response.json({ scope, name, exists: fs.existsSync(target), content: fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "" });
    } catch (error) {
      next(error);
    }
  });
  router.put("/instructions", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      const scope = String(request.body?.scope ?? "project");
      const name = String(request.body?.name ?? "");
      const projectId = Number(request.body?.projectId) || undefined;
      const content = typeof request.body?.content === "string" ? request.body.content : "";
      if (Buffer.byteLength(content) > 512 * 1024) throw new Error("지침 파일은 512KiB를 초과할 수 없습니다.");
      const target = resolveInstruction(globalInstructions, database, workspaces, scope, name, projectId, Number(request.query.chatId) || null);
      writeFileAtomic(target, content);
      writeAudit(database, request.authUser!.id, "instruction.write", "instruction", `${scope}:${name}`, { projectId, bytes: Buffer.byteLength(content) });
      response.json({ saved: true });
    } catch (error) {
      next(error);
    }
  });
  router.post("/instructions/unify", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      const scope = String(request.body?.scope ?? "project");
      const projectId = Number(request.body?.projectId) || undefined;
      const pair = resolveInstructionPair(globalInstructions, database, workspaces, scope, projectId, Number(request.body?.chatId) || null);
      const result = ensureClaudeImportsAgents(pair.agentsFile, pair.claudeFile, pair.importPath);
      writeAudit(database, request.authUser!.id, "instruction.unify", "instruction", scope, { projectId, changed: result.changed });
      response.json({ saved: result.changed, scope, name: scope === "global" ? "claude/CLAUDE.md" : "CLAUDE.md", content: result.content });
    } catch (error) {
      next(error);
    }
  });
  router.get("/instructions/catalog", (_request, response) => {
    response.json({ project: projectInstructions, global: Object.keys(globalInstructions) });
  });
  return router;
}
