import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase } from "../src/server/core/database";
import { ExperimentSkillManifestService } from "../src/server/experiments/skill-manifest";
import { ExperimentSkillBundleService } from "../src/server/experiments/skill-bundle";
import { ExperimentWorkspaceService } from "../src/server/experiments/experiment-workspace";
import { AgentAccountService } from "../src/server/services/agent-accounts";
import { ExperimentService } from "../src/server/services/experiment-service";
import { parseExperimentVariantConfig } from "../src/shared/experiments";

const roots: string[] = [];

// prepare()가 만든 읽기 전용(0o555) 번들 디렉터리는 root가 아니면 그대로 삭제할 수 없어 정리 전에 권한을 복원한다.
function unlockForCleanup(root: string): void {
  if (!fs.existsSync(root)) return;
  fs.chmodSync(root, 0o700);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) unlockForCleanup(path.join(root, entry.name));
  }
}

afterEach(() => {
  while (roots.length) {
    const root = roots.pop()!;
    unlockForCleanup(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 임시 경로를 만들고 테스트 종료 시 정리 목록에 등록한다.
function temporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("실험 스킬 manifest", () => {
  it("project·user·system SKILL.md의 실제 경로와 내용 해시를 중복 없이 고정한다", () => {
    const home = temporaryRoot("wam-skill-home-");
    const project = temporaryRoot("wam-skill-project-");
    const system = temporaryRoot("wam-skill-system-");
    fs.mkdirSync(path.join(project, ".agents", "skills", "review"), { recursive: true });
    fs.mkdirSync(path.join(home, ".codex", "skills", "global"), { recursive: true });
    fs.mkdirSync(path.join(system, "policy"), { recursive: true });
    fs.writeFileSync(path.join(project, ".agents", "skills", "review", "SKILL.md"), "project review");
    fs.writeFileSync(path.join(home, ".codex", "skills", "global", "SKILL.md"), "global skill");
    fs.writeFileSync(path.join(system, "policy", "SKILL.md"), "system skill");
    const service = new ExperimentSkillManifestService({ homeDir: home, codexSystemDir: system });

    const manifest = service.discover("codex", project);

    expect(manifest.map((entry) => entry.id)).toEqual(["project:review", "system:policy", "user:global"]);
    expect(manifest.every((entry) => entry.path.endsWith("SKILL.md") && /^[0-9a-f]{64}$/.test(entry.sha256))).toBe(true);

    const accountConfig = path.join(home, "account-codex");
    fs.mkdirSync(path.join(accountConfig, "skills", "account-only"), { recursive: true });
    fs.writeFileSync(path.join(accountConfig, "skills", "account-only", "SKILL.md"), "account skill");
    expect(service.discover("codex", project, accountConfig).map((entry) => entry.id))
      .toEqual(["project:review", "system:policy", "user:account-only"]);
  });

  it("실험 전용 스킬 전체를 read-only bundle로 복사하고 변조를 감지한다", () => {
    const home = temporaryRoot("wam-skill-overlay-home-");
    const project = temporaryRoot("wam-skill-overlay-project-");
    const data = temporaryRoot("wam-skill-overlay-data-");
    const rootDir = temporaryRoot("wam-skill-overlay-root-");
    fs.mkdirSync(path.join(project, ".agents", "skills", "installed"), { recursive: true });
    fs.mkdirSync(path.join(project, ".agent-lab", "skills", "candidate", "scripts"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "skills"), { recursive: true });
    fs.writeFileSync(path.join(project, ".agents", "skills", "installed", "SKILL.md"), "# installed");
    fs.writeFileSync(path.join(project, ".agent-lab", "skills", "candidate", "SKILL.md"), "# candidate");
    fs.writeFileSync(path.join(project, ".agent-lab", "skills", "candidate", "scripts", "check.sh"), "echo ok");
    const manifest = new ExperimentSkillManifestService({ homeDir: home, rootDir });
    const service = new ExperimentSkillBundleService(manifest, data);

    const snapshot = service.prepare({
      key: "11111111-1111-4111-8111-111111111111", provider: "codex", workingDirectory: project,
      config: {
        mode: "none", enabled: [], disabled: [], profile: "isolated_overlay", baseline: "clean",
        additions: ["lab:candidate"], comparisonId: "codex-default", activation: "native",
      },
    });

    expect(snapshot).toMatchObject({ baseline: "clean", additions: [{ id: "lab:candidate", name: "candidate" }] });
    expect(snapshot?.files.map((file) => file.path)).toEqual(expect.arrayContaining([
      "skills/01-candidate/SKILL.md", "skills/01-candidate/scripts/check.sh", ".claude-plugin/plugin.json",
    ]));
    expect(snapshot?.files).toHaveLength(3);
    service.verify(snapshot!);
    const copiedSkill = path.join(snapshot!.bundleRoot, "skills", "01-candidate", "SKILL.md");
    fs.chmodSync(copiedSkill, 0o644);
    fs.writeFileSync(copiedSkill, "changed");
    expect(() => service.verify(snapshot!)).toThrow("변경");
    service.remove(snapshot!.bundleRoot);
  });

  it("Claude SessionStart 대조군과 처리군을 같은 무상태 훅으로 만들고 추가 본문만 달리한다", () => {
    const home = temporaryRoot("wam-session-skill-home-");
    const project = temporaryRoot("wam-session-skill-project-");
    const data = temporaryRoot("wam-session-skill-data-");
    fs.mkdirSync(path.join(project, ".agent-lab", "skills", "ponytail"), { recursive: true });
    fs.writeFileSync(path.join(project, ".agent-lab", "skills", "ponytail", "SKILL.md"), "---\nname: ponytail\n---\n# Ponytail\nDo less.\n");
    const service = new ExperimentSkillBundleService(new ExperimentSkillManifestService({ homeDir: home }), data);
    const config = {
      mode: "none" as const, enabled: [], disabled: [], profile: "isolated_overlay" as const, baseline: "clean" as const,
      additions: [] as string[], comparisonId: "claude-ponytail", activation: "session_start" as const,
    };

    const control = service.prepare({
      key: "33333333-3333-4333-8333-333333333333", provider: "claude", workingDirectory: project, config,
    })!;
    const treatment = service.prepare({
      key: "44444444-4444-4444-8444-444444444444", provider: "claude", workingDirectory: project,
      config: { ...config, additions: ["lab:ponytail"] },
    })!;
    const controlManifest = JSON.parse(fs.readFileSync(control.pluginManifest, "utf8"));
    const treatmentManifest = JSON.parse(fs.readFileSync(treatment.pluginManifest, "utf8"));
    const controlText = fs.readFileSync(path.join(control.bundleRoot, "hooks", "activation.txt"), "utf8");
    const treatmentText = fs.readFileSync(path.join(treatment.bundleRoot, "hooks", "activation.txt"), "utf8");

    expect(controlManifest.hooks).toBe("./hooks/hooks.json");
    expect(treatmentManifest.hooks).toBe(controlManifest.hooks);
    expect(controlText).toBe("AGENT LAB SESSION-START SKILL ACTIVATION\n");
    expect(treatmentText).toContain(`${controlText.trim()}\n\n## Agent Lab additional skill: ponytail\n\n# Ponytail\nDo less.`);
    expect(fs.readFileSync(path.join(treatment.bundleRoot, "hooks", "activate.cjs"), "utf8")).not.toContain("writeFile");
    expect(execFileSync("node", [path.join(treatment.bundleRoot, "hooks", "activate.cjs")], { encoding: "utf8" })).toBe(treatmentText);
    expect(control.activation).toBe("session_start");
    expect(treatment.additions).toHaveLength(1);
  });

  it("installed baseline에 이미 포함된 스킬의 중복 추가를 차단한다", () => {
    const home = temporaryRoot("wam-skill-duplicate-home-");
    const project = temporaryRoot("wam-skill-duplicate-project-");
    const data = temporaryRoot("wam-skill-duplicate-data-");
    fs.mkdirSync(path.join(project, ".agents", "skills", "review"), { recursive: true });
    fs.writeFileSync(path.join(project, ".agents", "skills", "review", "SKILL.md"), "# review");
    const service = new ExperimentSkillBundleService(new ExperimentSkillManifestService({ homeDir: home }), data);

    expect(() => service.prepare({
      key: "22222222-2222-4222-8222-222222222222", provider: "codex", workingDirectory: project,
      config: {
        mode: "all", enabled: [], disabled: [], profile: "isolated_overlay", baseline: "installed",
        additions: ["installed:project:review"], comparisonId: "codex-default", activation: "native",
      },
    })).toThrow("이미 포함");
  });

  it("Git에서 제외된 project 스킬을 worktree에 고정 복제하고 변경을 검출한다", () => {
    const home = temporaryRoot("wam-skill-materialize-home-");
    const source = temporaryRoot("wam-skill-materialize-source-");
    const target = temporaryRoot("wam-skill-materialize-target-");
    const data = temporaryRoot("wam-skill-materialize-data-");
    fs.mkdirSync(path.join(source, ".claude", "skills", "review", "references"), { recursive: true });
    fs.writeFileSync(path.join(source, ".claude", "skills", "review", "SKILL.md"), "# review");
    fs.writeFileSync(path.join(source, ".claude", "skills", "review", "references", "rubric.md"), "rubric");
    const service = new ExperimentSkillBundleService(new ExperimentSkillManifestService({ homeDir: home }), data);

    const snapshot = service.materializeProjectSkills({ provider: "claude", sourceDirectory: source, targetDirectory: target });

    expect(snapshot.files.map((file) => file.path)).toEqual(["review/references/rubric.md", "review/SKILL.md"]);
    expect(fs.readFileSync(path.join(target, ".claude", "skills", "review", "references", "rubric.md"), "utf8")).toBe("rubric");
    service.verifyMaterialized(snapshot);
    fs.chmodSync(path.join(target, ".claude", "skills", "review", "SKILL.md"), 0o644);
    fs.writeFileSync(path.join(target, ".claude", "skills", "review", "SKILL.md"), "changed");
    expect(() => service.verifyMaterialized(snapshot)).toThrow("변경");
  });
});

describe("실험 격리 작업공간", () => {
  it("프로젝트 HEAD의 detached worktree와 기준 커밋을 data 하위에 만든다", async () => {
    const root = temporaryRoot("wam-workspace-");
    const repo = path.join(root, "repo");
    const dataDir = path.join(root, "data");
    fs.mkdirSync(path.join(repo, "packages", "app"), { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "테스트"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "packages", "app", "README.md"), "baseline");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "기준"], { cwd: repo });
    const database = openDatabase({
      rootDir: root, dataDir, homeDir: root, host: "127.0.0.1", port: 0,
      publicUrl: "http://127.0.0.1", allowedRoots: [root], sessionTtlHours: 1,
      runtimeEnabled: false, slack: {}, ntfy: { serverUrl: "https://ntfy.sh" },
    } as AppConfig);
    const projectId = Number(database.prepare("INSERT INTO projects(name, path) VALUES ('앱', ?)").run(path.join(repo, "packages", "app")).lastInsertRowid);
    const service = new ExperimentWorkspaceService(database, { dataDir } as AppConfig);

    const workspace = await service.create(projectId, "11111111-1111-4111-8111-111111111111");

    expect(workspace.root.startsWith(path.join(dataDir, "experiment-worktrees"))).toBe(true);
    expect(workspace.workingDirectory).toBe(path.join(workspace.root, "packages", "app"));
    expect(fs.readFileSync(path.join(workspace.workingDirectory, "README.md"), "utf8")).toBe("baseline");
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace.root, encoding: "utf8" }).trim()).toBe(workspace.baselineCommit);
    expect(await service.remove(projectId, workspace.root)).toBe(true);
    expect(fs.existsSync(workspace.root)).toBe(false);
    expect(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" })).not.toContain(workspace.root);
    database.close();
  });
});

describe("실험 스킬 비교 조건", () => {
  it("같은 그룹의 baseline/additions 차이만 허용하고 모델 차이는 거부한다", async () => {
    const root = temporaryRoot("wam-skill-comparison-");
    const config = {
      rootDir: root, dataDir: path.join(root, "data"), homeDir: root, host: "127.0.0.1", port: 0,
      publicUrl: "http://127.0.0.1", allowedRoots: [root], sessionTtlHours: 1,
      runtimeEnabled: false, slack: {}, ntfy: { serverUrl: "https://ntfy.sh" },
    } as AppConfig;
    fs.mkdirSync(config.dataDir, { recursive: true });
    const database = openDatabase(config);
    const projectId = Number(database.prepare("INSERT INTO projects(name, path) VALUES ('앱', ?)").run(root).lastInsertRowid);
    const service = new ExperimentService(database, config, new AgentAccountService(config, database));
    const experiment = service.repository.createExperiment({ projectId, name: "스킬 비교", command: "구현" });
    const variantConfig = (baseline: "installed" | "clean", model = "gpt-test") => parseExperimentVariantConfig({
      schemaVersion: 1,
      runtime: { provider: "codex", model, reasoningEffort: "high", sandbox: "workspace-write" },
      skills: {
        mode: baseline === "installed" ? "all" : "none", profile: "isolated_overlay", baseline,
        additions: baseline === "clean" ? ["lab:review"] : [], comparisonId: "codex-default",
      },
      harness: { type: "single" }, budget: { maxSeconds: 60 },
    });
    const installed = variantConfig("installed");
    service.assertSkillIsolationVariant(experiment.id, installed);
    service.repository.createVariant({ experimentId: experiment.id, name: "installed", config: installed });

    expect(() => service.assertSkillIsolationVariant(experiment.id, variantConfig("clean"))).not.toThrow();
    expect(() => service.assertSkillIsolationVariant(experiment.id, variantConfig("clean", "gpt-other"))).toThrow("비스킬 조건");
    await service.shutdown();
    database.close();
  });
});

describe("격리 스킬 비교의 하네스 제약", () => {
  const isolated = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    runtime: { provider: "codex", model: "gpt-test", reasoningEffort: "high", sandbox: "workspace-write" },
    skills: {
      mode: "all", profile: "isolated_overlay", baseline: "installed",
      additions: ["lab:review"], comparisonId: "cmp-1", activation: "native",
    },
    harness: { type: "single" },
    budget: { maxSeconds: 600 },
    ...overrides,
  });

  it("graph 하네스에서도 격리 overlay를 허용한다", () => {
    // 실행 시 공급자별 bundle을 따로 만들므로 primary·secondary가 달라도 섞이지 않는다.
    const parsed = parseExperimentVariantConfig(isolated({
      harness: {
        type: "orchestrator_worker", workerCount: 2,
        secondaryRuntime: { provider: "claude", model: "claude-test", reasoningEffort: "high" },
      },
    }));
    expect(parsed.harness.type).toBe("orchestrator_worker");
    expect(parsed.skills.profile).toBe("isolated_overlay");
  });

  it("SessionStart 주입은 Claude 전용 plugin hook이라 single에서만 허용한다", () => {
    expect(() => parseExperimentVariantConfig(isolated({
      runtime: { provider: "claude", model: "claude-test", reasoningEffort: "high", sandbox: "workspace-write" },
      skills: {
        mode: "all", profile: "isolated_overlay", baseline: "installed",
        additions: ["lab:review"], comparisonId: "cmp-1", activation: "session_start",
      },
      harness: { type: "evaluator_optimizer", maxIterations: 2 },
    }))).toThrow("single 하네스에서만");
  });
});
