import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Router } from "express";
import type { AppDatabase } from "../core/database";
import { requireAdmin, type AuthenticatedRequest } from "../core/auth";
import { writeAudit } from "../core/audit";
import { getProjectPath, resolveProjectPath } from "./helpers";

const projectInstructions = ["AGENTS.md", "AGENTS.override.md", "CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"];
const globalInstructions: Record<string, string> = {
  "codex/AGENTS.md": path.join(os.homedir(), ".codex", "AGENTS.md"),
  "codex/AGENTS.override.md": path.join(os.homedir(), ".codex", "AGENTS.override.md"),
  "claude/CLAUDE.md": path.join(os.homedir(), ".claude", "CLAUDE.md"),
};

// 허용 목록의 지침 파일 경로만 실제 경로로 변환한다.
function resolveInstruction(database: AppDatabase, scope: string, name: string, projectId?: number): string {
  if (scope === "global") {
    const target = globalInstructions[name];
    if (!target) throw new Error("허용되지 않은 전역 지침 파일입니다.");
    return target;
  }
  if (!projectInstructions.includes(name) || !projectId) throw new Error("허용되지 않은 프로젝트 지침 파일입니다.");
  return resolveProjectPath(getProjectPath(database, projectId), name, fs.existsSync(path.join(getProjectPath(database, projectId), name)));
}

// 파일을 임시 파일에 쓴 뒤 rename으로 교체한다.
function writeInstructionFile(target: string, content: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.web-agent-manager-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, content, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

// Claude가 Codex용 AGENTS.md를 같은 지침으로 읽도록 CLAUDE.md import를 보장한다.
function ensureClaudeImportsAgents(agentsFile: string, claudeFile: string, importPath: string): { changed: boolean; content: string } {
  if (!fs.existsSync(agentsFile)) writeInstructionFile(agentsFile, "# 공통 에이전트 지침\n\n");
  const existing = fs.existsSync(claudeFile) ? fs.readFileSync(claudeFile, "utf8") : "";
  const importPattern = new RegExp(`^\\s*@${importPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
  if (importPattern.test(existing)) return { changed: false, content: existing };
  const header = `@${importPath}\n\n<!-- web-agent-manager: Claude가 Codex와 같은 공통 지침을 읽도록 AGENTS.md를 import합니다. -->`;
  const content = existing.trim() ? `${header}\n\n${existing.replace(/^\s+/, "")}` : `${header}\n\n## Claude 전용 지침\n\n`;
  writeInstructionFile(claudeFile, content);
  return { changed: true, content };
}

// scope에 맞는 AGENTS.md와 CLAUDE.md 경로, Claude import 경로를 계산한다.
function resolveInstructionPair(database: AppDatabase, scope: string, projectId?: number): { agentsFile: string; claudeFile: string; importPath: string } {
  if (scope === "global") return {
    agentsFile: globalInstructions["codex/AGENTS.md"],
    claudeFile: globalInstructions["claude/CLAUDE.md"],
    importPath: "../.codex/AGENTS.md",
  };
  if (!projectId) throw new Error("프로젝트가 필요합니다.");
  const root = getProjectPath(database, projectId);
  return {
    agentsFile: resolveProjectPath(root, "AGENTS.md", fs.existsSync(path.join(root, "AGENTS.md"))),
    claudeFile: resolveProjectPath(root, "CLAUDE.md", fs.existsSync(path.join(root, "CLAUDE.md"))),
    importPath: "AGENTS.md",
  };
}

// 프로젝트와 전역 AGENTS.md·CLAUDE.md 읽기·쓰기 API를 구성한다.
export function createInstructionRouter(database: AppDatabase): Router {
  const router = Router();
  // 권한 정책: 지침 조회는 로그인 사용자에게 허용하고, 영구 지침 변경은 관리자만 허용한다.
  router.get("/instructions", (request, response, next) => {
    try {
      const scope = String(request.query.scope ?? "project");
      const name = String(request.query.name ?? "");
      const projectId = Number(request.query.projectId) || undefined;
      const target = resolveInstruction(database, scope, name, projectId);
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
      const target = resolveInstruction(database, scope, name, projectId);
      writeInstructionFile(target, content);
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
      const pair = resolveInstructionPair(database, scope, projectId);
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
