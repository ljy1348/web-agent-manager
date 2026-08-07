import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { AppDatabase } from "../core/database";

const SENSITIVE_SEGMENTS = new Set([".git", ".codex", ".claude", ".web-agent-manager-uploads", ".myagent-uploads", "agents.md", "agents.override.md", "claude.md", "claude.local.md"]);
interface FilePathAccess {
  // 내부망 요청 여부. 참이면 숨김 경로와 민감 경로 제한을 모두 적용하지 않는다.
  allowHidden?: boolean;
}

// 임시 파일에 먼저 쓰고 rename으로 교체해 중간에 실패해도 원본이 반쯤 덮인 상태로 남지 않게 한다.
// 기존 파일이 있으면 실행 권한 등 원래 모드를 유지하고, 새로 만들 때만 0600을 적용한다.
export function writeFileAtomic(target: string, content: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const mode = fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : 0o600;
  const temporary = `${target}.web-agent-manager-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, content, { mode });
  try {
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

// 선택한 채팅이 전용 worktree를 쓰면 그 경로를, 아니면 프로젝트 공유 checkout을 돌려준다.
// 파일 탭·지침처럼 "지금 이 채팅이 실제로 보고 있는 폴더"를 기준으로 동작해야 하는 API가 쓴다.
export function chatWorkspacePath(
  database: AppDatabase,
  workspaces: { workspacePath(projectId: number, chatId?: number | null): string } | undefined,
  projectId: number,
  chatId?: number | null,
): string {
  if (workspaces && chatId) {
    try {
      return workspaces.workspacePath(projectId, chatId);
    } catch {
      // 연결이 끊긴 worktree는 프로젝트 경로로 되돌아가 화면이 비지 않게 한다.
    }
  }
  return getProjectPath(database, projectId);
}

// 프로젝트 ID로 등록된 실제 프로젝트 경로를 조회한다.
export function getProjectPath(database: AppDatabase, projectId: number): string {
  const row = database.prepare("SELECT path FROM projects WHERE id = ? AND active = 1").get(projectId) as { path: string } | undefined;
  if (!row) throw new Error("프로젝트를 찾을 수 없습니다.");
  return fs.realpathSync(row.path);
}

// 두 실제 경로가 프로젝트 루트 안의 동일한 경계에 있는지 확인한다.
function assertInsideProject(projectRoot: string, target: string): void {
  if (target !== projectRoot && !target.startsWith(`${projectRoot}${path.sep}`)) throw new Error("프로젝트 경로를 벗어났습니다.");
}

// 프로젝트 상대 경로를 symlink 우회 없이 실제 또는 안전한 생성 예정 경로로 변환한다.
export function resolveProjectPath(projectRoot: string, relativePath: string, mustExist = true): string {
  if (path.isAbsolute(relativePath) || relativePath.includes("\0")) throw new Error("유효하지 않은 상대 경로입니다.");
  const actualRoot = fs.realpathSync(projectRoot);
  const candidate = path.resolve(actualRoot, relativePath || ".");
  assertInsideProject(actualRoot, candidate);
  if (mustExist || fs.existsSync(candidate)) {
    const actual = fs.realpathSync(candidate);
    assertInsideProject(actualRoot, actual);
    return actual;
  }
  let ancestor = path.dirname(candidate);
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error("생성 경로의 상위 디렉터리를 찾을 수 없습니다.");
    ancestor = parent;
  }
  assertInsideProject(actualRoot, fs.realpathSync(ancestor));
  return candidate;
}

// 일반 파일 API에서 접근하면 안 되는 민감 경로를 거부한다.
// 내부망(allowHidden) 요청은 사용자 결정에 따라 .env·.git 등 민감 경로까지 일반 파일처럼 다룬다.
export function assertNonSensitiveRelativePath(relativePath: string, access: FilePathAccess = {}): void {
  if (access.allowHidden) return;
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  if (segments.some((segment) => {
    const normalized = segment.toLowerCase();
    return SENSITIVE_SEGMENTS.has(normalized) || normalized.startsWith(".env");
  })) {
    throw new Error("일반 파일 기능으로 접근할 수 없는 경로입니다.");
  }
  if (segments.some((segment) => segment.startsWith("."))) {
    throw new Error("외부 네트워크에서는 숨김 경로에 접근할 수 없습니다.");
  }
}

// symlink 해석 후의 실제 프로젝트 상대 경로에도 민감 세그먼트가 없는지 확인한다.
export function assertNonSensitiveResolvedPath(projectRoot: string, target: string, access: FilePathAccess = {}): void {
  const actualRoot = fs.realpathSync(projectRoot);
  const relative = path.relative(actualRoot, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("프로젝트 경로를 벗어났습니다.");
  if (!relative) return;
  assertNonSensitiveRelativePath(relative, access);
}

// 일반 파일 API용으로 경계 검증과 민감 경로 검증을 모두 적용해 프로젝트 경로를 해석한다.
export function resolveNonSensitiveProjectPath(projectRoot: string, relativePath: string, mustExist = true, access: FilePathAccess = {}): string {
  assertNonSensitiveRelativePath(relativePath, access);
  const target = resolveProjectPath(projectRoot, relativePath, mustExist);
  assertNonSensitiveResolvedPath(projectRoot, target, access);
  return target;
}
