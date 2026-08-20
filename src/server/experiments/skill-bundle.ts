import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ExperimentSkillConfig } from "../../shared/experiments";
import type { ExperimentSkillOverlaySnapshot } from "./agent-runtime";
import { ExperimentSkillManifestService, type ExperimentSkillCandidate } from "./skill-manifest";

const MAX_SKILL_FILES = 500;
const MAX_SKILL_BYTES = 10 * 1024 * 1024;

export interface BundleFile {
  path: string;
  sha256: string;
  size: number;
  mode: number;
}

export interface MaterializedProjectSkills {
  provider: "codex" | "claude";
  root: string;
  files: BundleFile[];
  digest: string;
}

// 파일 내용을 노출하지 않고 SHA-256을 계산한다.
function fileHash(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

// 스킬 디렉터리의 일반 파일만 정렬해 수집하고 symlink·크기 우회를 차단한다.
function sourceFiles(directory: string): Array<{ absolute: string; relative: string; size: number; mode: number }> {
  const files: Array<{ absolute: string; relative: string; size: number; mode: number }> = [];
  let bytes = 0;
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(directory, absolute);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`스킬 내부 symlink는 격리 bundle에 포함할 수 없습니다: ${relative}`);
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) {
        bytes += stat.size;
        files.push({ absolute, relative, size: stat.size, mode: stat.mode & 0o777 });
        if (files.length > MAX_SKILL_FILES || bytes > MAX_SKILL_BYTES) throw new Error("스킬 bundle은 스킬당 500개 파일·10MiB를 초과할 수 없습니다.");
      } else throw new Error(`스킬에 일반 파일이 아닌 항목이 있습니다: ${relative}`);
    }
  };
  visit(directory);
  if (!files.some((file) => file.relative === "SKILL.md")) throw new Error("추가 스킬에 SKILL.md가 없습니다.");
  return files;
}

// 경로명에 쓸 수 있는 제한된 스킬 이름을 만들고 충돌은 순번으로 분리한다.
function safeName(value: string): string {
  return value.normalize("NFKC").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "skill";
}

// bundle 전체 파일 목록의 안정된 digest를 만든다.
function bundleDigest(files: BundleFile[]): string {
  return crypto.createHash("sha256").update(JSON.stringify(files)).digest("hex");
}

// SKILL.md frontmatter를 제외하고 SessionStart에 넣을 실제 지시 본문만 반환한다.
function skillInstructionBody(skillFile: string): string {
  return fs.readFileSync(skillFile, "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

// 추가 스킬 본문을 전역 쓰기 없는 Claude SessionStart 훅으로 고정한다.
function writeSessionStartActivation(bundleRoot: string, additions: Array<{ candidate: ExperimentSkillCandidate; directory: string }>): string {
  const hooksDirectory = path.join(bundleRoot, "hooks");
  fs.mkdirSync(hooksDirectory, { mode: 0o700 });
  const activationFile = path.join(hooksDirectory, "activation.txt");
  const sections = additions.map(({ candidate, directory }) => (
    `\n\n## Agent Lab additional skill: ${candidate.name}\n\n${skillInstructionBody(path.join(directory, "SKILL.md"))}`
  ));
  fs.writeFileSync(activationFile, `AGENT LAB SESSION-START SKILL ACTIVATION${sections.join("")}\n`, { mode: 0o444 });
  fs.writeFileSync(path.join(hooksDirectory, "activate.cjs"), [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'process.stdout.write(fs.readFileSync(path.join(__dirname, "activation.txt"), "utf8"));',
    "",
  ].join("\n"), { mode: 0o444 });
  const hooksFile = path.join(hooksDirectory, "hooks.json");
  fs.writeFileSync(hooksFile, `${JSON.stringify({
    hooks: {
      SessionStart: [{
        matcher: "startup|resume|clear|compact",
        hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/activate.cjs"', timeout: 5 }],
      }],
    },
  }, null, 2)}\n`, { mode: 0o444 });
  return "./hooks/hooks.json";
}

// 실행별 read-only skill bundle을 만들고 전체 파일 provenance를 고정한다.
export class ExperimentSkillBundleService {
  private readonly root: string;

  constructor(
    private readonly manifest: ExperimentSkillManifestService,
    dataDir: string,
  ) {
    this.root = path.resolve(dataDir, "experiment-skill-bundles");
  }

  // 선택 가능한 후보에서 원본 경로를 제외한 API용 목록을 만든다.
  catalog(provider: "codex" | "claude", workingDirectory: string, accountConfigDir?: string | null) {
    return this.manifest.catalog(provider, workingDirectory, accountConfigDir).map(({ skillFile: _skillFile, directory: _directory, ...candidate }) => candidate);
  }

  // 원본 checkout의 project 스킬을 detached worktree에 동일하게 복제하고 해시를 반환한다.
  materializeProjectSkills(input: {
    provider: "codex" | "claude";
    sourceDirectory: string;
    targetDirectory: string;
    accountConfigDir?: string | null;
  }): MaterializedProjectSkills {
    const relativeRoot = input.provider === "codex" ? path.join(".agents", "skills") : path.join(".claude", "skills");
    const targetRoot = path.join(input.targetDirectory, relativeRoot);
    const candidates = this.manifest.catalog(input.provider, input.sourceDirectory, input.accountConfigDir)
      .filter((entry) => entry.source === "installed" && entry.scope === "project");
    fs.rmSync(targetRoot, { recursive: true, force: true });
    fs.mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
    for (const candidate of candidates) {
      const target = path.join(targetRoot, safeName(candidate.name));
      fs.mkdirSync(target, { mode: 0o700 });
      this.copySkillDirectory(candidate.directory, target);
    }
    const files = this.snapshotFiles(targetRoot);
    return { provider: input.provider, root: targetRoot, files, digest: bundleDigest(files) };
  }

  // baseline과 additions만 다른 실행별 bundle·지시 파일을 생성한다.
  prepare(input: {
    key: string;
    provider: "codex" | "claude";
    workingDirectory: string;
    accountConfigDir?: string | null;
    additionalNativeDirectories?: string[];
    config: ExperimentSkillConfig;
  }): ExperimentSkillOverlaySnapshot | null {
    if (input.config.profile !== "isolated_overlay") return null;
    if (!/^[0-9a-f-]{36}$/i.test(input.key)) throw new Error("스킬 bundle 키가 올바르지 않습니다.");
    if (!input.config.comparisonId) throw new Error("격리 스킬 비교에는 comparisonId가 필요합니다.");
    const candidates = this.manifest.catalog(input.provider, input.workingDirectory, input.accountConfigDir);
    const selected = input.config.additions.map((id) => {
      const candidate = candidates.find((entry) => entry.id === id);
      if (!candidate) throw new Error(`추가 스킬 후보를 찾을 수 없습니다: ${id}`);
      return candidate;
    });
    const nativeDirectories = new Set([
      ...candidates.filter((entry) => entry.includedByDefault).map((entry) => fs.realpathSync(entry.directory)),
      ...(input.additionalNativeDirectories ?? []).map((entry) => fs.realpathSync(entry)),
    ]);
    if (input.config.baseline === "installed") {
      const duplicate = selected.find((entry) => nativeDirectories.has(fs.realpathSync(entry.directory)));
      if (duplicate) throw new Error(`현재 설치 baseline에 이미 포함된 스킬은 추가 treatment가 될 수 없습니다: ${duplicate.name}`);
    }
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const bundleRoot = path.join(this.root, input.key);
    if (fs.existsSync(bundleRoot)) throw new Error("같은 실행의 스킬 bundle이 이미 있습니다.");
    fs.mkdirSync(bundleRoot, { mode: 0o700 });
    const baseline = input.config.baseline === "installed" ? candidates.filter((entry) => entry.includedByDefault) : [];
    const bundleCandidates = [...baseline.map((candidate) => ({ candidate, kind: "baseline" as const })), ...selected.map((candidate) => ({ candidate, kind: "addition" as const }))];
    const copied: Array<{ candidate: ExperimentSkillCandidate; directory: string; kind: "baseline" | "addition" }> = [];
    try {
      bundleCandidates.forEach(({ candidate, kind }, index) => {
        const target = path.join(bundleRoot, "skills", `${String(index + 1).padStart(2, "0")}-${safeName(candidate.name)}`);
        fs.mkdirSync(target, { recursive: true, mode: 0o700 });
        this.copySkillDirectory(candidate.directory, target);
        copied.push({ candidate, directory: target, kind });
      });
      const pluginDirectory = path.join(bundleRoot, ".claude-plugin");
      fs.mkdirSync(pluginDirectory, { mode: 0o700 });
      const pluginManifest = path.join(pluginDirectory, "plugin.json");
      const hooks = input.config.activation === "session_start"
        ? writeSessionStartActivation(bundleRoot, copied.filter((entry) => entry.kind === "addition"))
        : undefined;
      fs.writeFileSync(pluginManifest, `${JSON.stringify({
        name: `agent-lab-overlay-${input.key.slice(0, 8)}`,
        version: "0.0.0",
        description: "WAM Agent Lab의 실행별 고정 스킬 overlay",
        ...(hooks ? { hooks } : {}),
      }, null, 2)}\n`, { mode: 0o444 });
      const files = this.snapshotFiles(bundleRoot);
      this.makeDirectoriesReadOnly(bundleRoot);
      fs.chmodSync(bundleRoot, 0o555);
      return {
        profile: "isolated_overlay", baseline: input.config.baseline, comparisonId: input.config.comparisonId,
        activation: input.config.activation,
        bundleRoot, pluginManifest,
        baselineSkills: copied.filter((entry) => entry.kind === "baseline").map((entry) => ({
          id: entry.candidate.id, name: entry.candidate.name, source: entry.candidate.source, directory: entry.directory,
        })),
        additions: copied.filter((entry) => entry.kind === "addition").map((entry) => ({
          id: entry.candidate.id, name: entry.candidate.name, source: entry.candidate.source, directory: entry.directory,
        })),
        files, digest: bundleDigest(files),
      };
    } catch (error) {
      this.makeDirectoriesWritable(bundleRoot);
      fs.rmSync(bundleRoot, { recursive: true, force: true });
      throw error;
    }
  }

  // 실행 전후 bundle 파일 목록·내용·mode가 snapshot과 같은지 검증한다.
  verify(snapshot: ExperimentSkillOverlaySnapshot): void {
    const files = this.snapshotFiles(snapshot.bundleRoot);
    if (bundleDigest(files) !== snapshot.digest) throw new Error("실행 중 스킬 overlay bundle이 변경되었습니다.");
  }

  // worktree에 고정 복제한 project 스킬의 실행 전후 동일성을 검증한다.
  verifyMaterialized(snapshot: MaterializedProjectSkills): void {
    const files = this.snapshotFiles(snapshot.root);
    if (bundleDigest(files) !== snapshot.digest) throw new Error(`${snapshot.provider} project 스킬이 실행 중 변경되었습니다.`);
  }

  // 앱 관리 root 바로 아래의 정확한 bundle만 제거한다.
  remove(bundleRoot: string): void {
    const resolved = path.resolve(bundleRoot);
    if (path.dirname(resolved) !== this.root) throw new Error("스킬 bundle 정리 경로가 관리 root 밖입니다.");
    if (!fs.existsSync(resolved)) return;
    this.makeDirectoriesWritable(resolved);
    fs.rmSync(resolved, { recursive: true, force: true });
  }

  // 스킬 디렉터리 전체를 상대 경로·실행 비트만 보존해 복사한다.
  private copySkillDirectory(source: string, target: string): void {
    for (const file of sourceFiles(fs.realpathSync(source))) {
      const destination = path.join(target, file.relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.copyFileSync(file.absolute, destination);
      fs.chmodSync(destination, file.mode & 0o555 ? file.mode & 0o555 : 0o444);
    }
  }

  // bundle 하위 디렉터리를 안쪽부터 읽기 전용으로 바꾼다.
  private makeDirectoriesReadOnly(root: string): void {
    const directories: string[] = [];
    const visit = (current: string) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const directory = path.join(current, entry.name);
        visit(directory);
        directories.push(directory);
      }
    };
    visit(root);
    directories.forEach((directory) => fs.chmodSync(directory, 0o555));
  }

  // 앱이 만든 읽기 전용 트리를 안전하게 정리할 수 있도록 디렉터리 쓰기 권한만 복원한다.
  private makeDirectoriesWritable(root: string): void {
    if (!fs.existsSync(root)) return;
    fs.chmodSync(root, 0o700);
    const visit = (current: string) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const directory = path.join(current, entry.name);
        fs.chmodSync(directory, 0o700);
        visit(directory);
      }
    };
    visit(root);
  }

  // bundle의 일반 파일 metadata를 상대 경로 순서로 다시 계산한다.
  private snapshotFiles(bundleRoot: string): BundleFile[] {
    const files: BundleFile[] = [];
    const visit = (current: string) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
        const absolute = path.join(current, entry.name);
        const stat = fs.lstatSync(absolute);
        if (stat.isSymbolicLink()) throw new Error("스킬 bundle에 symlink가 생겼습니다.");
        if (stat.isDirectory()) visit(absolute);
        else if (stat.isFile()) files.push({
          path: path.relative(bundleRoot, absolute), sha256: fileHash(absolute), size: stat.size, mode: stat.mode & 0o777,
        });
        else throw new Error("스킬 bundle에 일반 파일이 아닌 항목이 생겼습니다.");
      }
    };
    visit(bundleRoot);
    return files;
  }
}
