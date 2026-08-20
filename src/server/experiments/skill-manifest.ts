import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Provider } from "../../shared/types";

export interface ExperimentSkillManifestEntry {
  id: string;
  path: string;
  sha256: string;
}

export interface ExperimentSkillManifestOptions {
  homeDir: string;
  codexSystemDir?: string;
  rootDir?: string;
}

export interface ExperimentSkillCandidate {
  id: string;
  name: string;
  source: "installed" | "project_lab" | "wam_library";
  scope: "project" | "user" | "system" | "lab" | "library";
  includedByDefault: boolean;
  skillFile: string;
  directory: string;
}

// 한 스킬 루트의 직계 하위 SKILL.md와 루트 자체가 SKILL.md인 경우를 제한적으로 찾는다.
function skillFiles(root: string): string[] {
  try {
    const stat = fs.statSync(root);
    if (stat.isFile()) return path.basename(root) === "SKILL.md" ? [fs.realpathSync(root)] : [];
    if (!stat.isDirectory()) return [];
    const direct = path.join(root, "SKILL.md");
    const files = fs.existsSync(direct) ? [fs.realpathSync(direct)] : [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)).slice(0, 500)) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const candidate = path.join(root, entry.name, "SKILL.md");
      try {
        if (fs.statSync(candidate).isFile()) files.push(fs.realpathSync(candidate));
      } catch {
        // 끊어진 링크나 접근 불가 스킬은 manifest에서 제외한다.
      }
    }
    return files;
  } catch {
    return [];
  }
}

// SKILL.md 본문 해시를 계산해 실행 시점 내용 변경을 감지한다.
function hashFile(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

// 공급자 공식 project/user/system 위치의 스킬을 중복 실제경로 없이 manifest로 고정한다.
export class ExperimentSkillManifestService {
  private readonly homeDir: string;
  private readonly codexSystemDir: string;
  private readonly rootDir: string | null;

  constructor(options: ExperimentSkillManifestOptions) {
    this.homeDir = path.resolve(options.homeDir);
    this.codexSystemDir = path.resolve(options.codexSystemDir ?? "/etc/codex/skills");
    this.rootDir = options.rootDir ? path.resolve(options.rootDir) : null;
  }

  // 공급자가 기본 발견하는 project/user/system 스킬 루트를 반환한다.
  private installedRoots(provider: Provider, workingDirectory: string, accountConfigDir?: string | null) {
    const configDir = path.resolve(accountConfigDir || path.join(this.homeDir, provider === "codex" ? ".codex" : ".claude"));
    return provider === "codex"
      ? [
        { scope: "project" as const, path: path.join(workingDirectory, ".agents", "skills") },
        { scope: "user" as const, path: path.join(configDir, "skills") },
        { scope: "system" as const, path: this.codexSystemDir },
      ]
      : [
        { scope: "project" as const, path: path.join(workingDirectory, ".claude", "skills") },
        { scope: "user" as const, path: path.join(configDir, "skills") },
      ];
  }

  // worktree 기준 project 스킬과 실제 계정 config의 사용자·시스템 스킬 ID·경로·해시를 반환한다.
  discover(provider: Provider, workingDirectory: string, accountConfigDir?: string | null): ExperimentSkillManifestEntry[] {
    const roots = this.installedRoots(provider, workingDirectory, accountConfigDir);
    const seen = new Set<string>();
    const manifest: ExperimentSkillManifestEntry[] = [];
    for (const root of roots) {
      for (const filePath of skillFiles(root.path)) {
        if (seen.has(filePath)) continue;
        seen.add(filePath);
        const name = path.basename(path.dirname(filePath));
        manifest.push({ id: `${root.scope}:${name}`, path: filePath, sha256: hashFile(filePath) });
      }
    }
    return manifest.sort((left, right) => left.id.localeCompare(right.id) || left.path.localeCompare(right.path));
  }

  // 현재 설치 스킬과 실험 전용·WAM 라이브러리 스킬을 overlay 후보로 반환한다.
  catalog(provider: Provider, workingDirectory: string, accountConfigDir?: string | null): ExperimentSkillCandidate[] {
    const candidates: ExperimentSkillCandidate[] = [];
    const installedDirectories = new Set<string>();
    for (const root of this.installedRoots(provider, workingDirectory, accountConfigDir)) {
      for (const skillFile of skillFiles(root.path)) {
        const directory = fs.realpathSync(path.dirname(skillFile));
        if (installedDirectories.has(directory)) continue;
        installedDirectories.add(directory);
        const name = path.basename(path.dirname(skillFile));
        candidates.push({
          id: `installed:${root.scope}:${name}`, name, source: "installed", scope: root.scope,
          includedByDefault: true, skillFile, directory,
        });
      }
    }
    const extraRoots = [
      { source: "project_lab" as const, scope: "lab" as const, path: path.join(workingDirectory, ".agent-lab", "skills") },
      ...(this.rootDir ? [{ source: "wam_library" as const, scope: "library" as const, path: path.join(this.rootDir, "skills") }] : []),
    ];
    for (const root of extraRoots) {
      for (const skillFile of skillFiles(root.path)) {
        const name = path.basename(path.dirname(skillFile));
        candidates.push({
          id: `${root.scope}:${name}`, name, source: root.source, scope: root.scope,
          includedByDefault: false, skillFile, directory: path.dirname(skillFile),
        });
      }
    }
    const ids = new Set<string>();
    return candidates.sort((left, right) => left.id.localeCompare(right.id)).filter((candidate) => {
      if (ids.has(candidate.id)) throw new Error(`중복된 실험 스킬 후보 ID입니다: ${candidate.id}`);
      ids.add(candidate.id);
      return true;
    });
  }
}
