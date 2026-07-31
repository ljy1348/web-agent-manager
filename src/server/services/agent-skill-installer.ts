import fs from "node:fs";
import path from "node:path";

export const AGENT_SKILL_NAMES = ["web-agent-manager-session-context", "web-agent-manager-delegate"] as const;
const LEGACY_AGENT_SKILL_NAMES = ["myagent-session-context", "myagent-delegate"] as const;

export interface SkillInstallResult {
  installed: string[];
  skipped: string[];
  errors: string[];
}

// 이 저장소의 이름 변경 전 원본만 가리키는 기존 symlink를 안전하게 정리한다.
function removeLegacySkillLinks(destinationRoot: string, rootDir: string): void {
  for (const skillName of LEGACY_AGENT_SKILL_NAMES) {
    const destination = path.join(destinationRoot, skillName);
    try {
      if (!fs.lstatSync(destination).isSymbolicLink()) continue;
      const linkedPath = path.resolve(path.dirname(destination), fs.readlinkSync(destination));
      if (linkedPath === path.join(rootDir, "skills", skillName)) fs.unlinkSync(destination);
    } catch {
      // 없거나 사용자가 관리하는 항목이면 그대로 둔다.
    }
  }
}

// 검증된 스킬 대상 루트들에 중앙 web-agent-manager 스킬 링크를 기존 항목 보존 방식으로 설치한다.
function installAgentSkills(destinationRoots: string[], rootDir: string): SkillInstallResult {
  const result: SkillInstallResult = { installed: [], skipped: [], errors: [] };
  try {
    for (const skillName of AGENT_SKILL_NAMES) {
      if (!fs.statSync(path.join(rootDir, "skills", skillName)).isDirectory()) throw new Error(`${skillName} 원본 스킬을 찾을 수 없습니다.`);
    }
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
    return result;
  }
  for (const destinationRoot of destinationRoots) {
    try {
      fs.mkdirSync(destinationRoot, { recursive: true, mode: 0o700 });
      removeLegacySkillLinks(destinationRoot, rootDir);
    } catch (error) {
      result.errors.push(`${destinationRoot}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const skillName of AGENT_SKILL_NAMES) {
      const source = path.join(rootDir, "skills", skillName);
      const destination = path.join(destinationRoot, skillName);
      try {
        const existing = fs.lstatSync(destination, { throwIfNoEntry: false });
        if (existing) {
          const sameTarget = existing.isSymbolicLink() && fs.realpathSync(destination) === fs.realpathSync(source);
          (sameTarget ? result.skipped : result.errors).push(sameTarget ? destination : `${destination}: 기존 항목을 덮어쓰지 않았습니다.`);
          continue;
        }
        fs.symlinkSync(source, destination, "dir");
        result.installed.push(destination);
      } catch (error) {
        result.errors.push(`${destination}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return result;
}

// 등록 프로젝트에 Codex·Claude가 공통으로 발견할 web-agent-manager 스킬 링크를 추가한다.
export function installProjectAgentSkills(projectPath: string, rootDir: string): SkillInstallResult {
  let actualProjectPath: string;
  try {
    actualProjectPath = fs.realpathSync(projectPath);
    if (!fs.statSync(actualProjectPath).isDirectory()) throw new Error("프로젝트 경로가 디렉터리가 아닙니다.");
  } catch (error) {
    return { installed: [], skipped: [], errors: [`${projectPath}: ${error instanceof Error ? error.message : String(error)}`] };
  }
  return installAgentSkills([
    path.join(actualProjectPath, ".agents", "skills"),
    path.join(actualProjectPath, ".claude", "skills"),
  ], rootDir);
}

// 공급자 사용자 홈의 공식 스킬 디렉터리에 중앙 web-agent-manager 스킬 링크를 설치한다.
export function installGlobalAgentSkills(provider: "codex" | "claude", homeDir: string, rootDir: string): SkillInstallResult {
  const destination = provider === "codex"
    ? path.join(homeDir, ".codex", "skills")
    : path.join(homeDir, ".claude", "skills");
  return installAgentSkills([destination], rootDir);
}

// 공급자 사용자 홈의 web-agent-manager 스킬 링크가 모두 현재 중앙 원본을 가리키는지 확인한다.
export function globalAgentSkillsInstalled(provider: "codex" | "claude", homeDir: string, rootDir: string): boolean {
  const destination = provider === "codex"
    ? path.join(homeDir, ".codex", "skills")
    : path.join(homeDir, ".claude", "skills");
  return AGENT_SKILL_NAMES.every((skillName) => {
    const target = path.join(destination, skillName);
    try {
      return fs.lstatSync(target).isSymbolicLink()
        && fs.realpathSync(target) === fs.realpathSync(path.join(rootDir, "skills", skillName));
    } catch {
      return false;
    }
  });
}
