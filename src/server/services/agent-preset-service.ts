import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppDatabase } from "../core/database";
import { ExperimentRepository } from "./experiment-repository";
import type { Provider } from "../../shared/types";
import { registeredProjectProfileRecommendation } from "./project-profile-recommendations";
import { projectProfileLaunch } from "./project-profile-launch";

export type ProjectTaskKind = "analysis" | "implementation" | "high_risk" | "operations";
const PROJECT_TASK_KINDS: ProjectTaskKind[] = ["analysis", "implementation", "high_risk", "operations"];

export interface AgentPresetRecord {
  id: string;
  projectId: number;
  name: string;
  taskKind: ProjectTaskKind;
  status: "draft" | "active" | "archived";
  activeVersion: number | null;
  versions: Array<{
    id: string; version: number; configSnapshot: Record<string, unknown>;
    sourceExperimentId: string | null; sourceVariantId: string | null; sourceRunId: string | null;
    promotionMetrics: Record<string, unknown>; compatibility: Record<string, unknown>;
    validatedAt: string | null; note: string | null; createdAt: string;
  }>;
}

interface AgentPresetVersionRow {
  id: string;
  version: number;
  config_snapshot_json: string;
  source_experiment_id: string | null;
  source_variant_id: string | null;
  source_run_id: string | null;
  promotion_metrics_json: string;
  compatibility_json: string;
  validated_at: string | null;
  note: string | null;
  created_at: string;
}

// 숫자 표본의 중앙값을 계산하고 빈 표본은 null로 둔다.
function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

// 프리셋 이름·메모를 공백과 길이 제한으로 검증한다.
function textValue(value: unknown, maximum: number, label: string, required: boolean): string | null {
  if (typeof value !== "string") {
    if (!required && (value === null || value === undefined)) return null;
    throw new Error(`${label}은 문자열이어야 합니다.`);
  }
  const normalized = value.trim();
  if ((!normalized && required) || normalized.length > maximum) throw new Error(`${label} 길이가 올바르지 않습니다.`);
  return normalized || null;
}

// 실험 우승 run을 불변 버전 Agent preset으로 승격하고 조회한다.
export class AgentPresetService {
  private readonly experiments: ExperimentRepository;

  constructor(private readonly database: AppDatabase) {
    this.experiments = new ExperimentRepository(database);
  }

  // 프로젝트의 프리셋과 최신순 버전을 반환한다.
  list(projectId: number): AgentPresetRecord[] {
    const presets = this.database.prepare("SELECT * FROM agent_presets WHERE project_id = ? ORDER BY updated_at DESC, name").all(projectId) as Array<{
      id: string; project_id: number; name: string; task_kind: ProjectTaskKind; status: AgentPresetRecord["status"]; active_version: number | null;
    }>;
    return presets.map((preset) => ({
      id: preset.id, projectId: preset.project_id, name: preset.name, taskKind: preset.task_kind, status: preset.status, activeVersion: preset.active_version,
      versions: (this.database.prepare("SELECT * FROM agent_preset_versions WHERE preset_id = ? ORDER BY version DESC").all(preset.id) as AgentPresetVersionRow[]).map((version) => ({
        id: version.id, version: version.version, configSnapshot: JSON.parse(version.config_snapshot_json),
        sourceExperimentId: version.source_experiment_id, sourceVariantId: version.source_variant_id, sourceRunId: version.source_run_id,
        promotionMetrics: JSON.parse(version.promotion_metrics_json), compatibility: JSON.parse(version.compatibility_json),
        validatedAt: version.validated_at, note: version.note, createdAt: version.created_at,
      })),
    }));
  }

  readiness(): Record<string, unknown> {
    const projects = this.database.prepare("SELECT id, name FROM projects WHERE active=1 ORDER BY name, id").all() as Array<{ id: number; name: string }>;
    const rows = projects.map((project) => {
      const profiles = this.list(project.id);
      const requiredTaskKinds: ProjectTaskKind[] = ["analysis", "implementation"];
      const taskKinds = requiredTaskKinds.map((taskKind) => {
        const profile = profiles.find((item) => item.taskKind === taskKind && item.status === "active" && item.activeVersion !== null);
        const version = profile?.versions.find((item) => item.version === profile.activeVersion);
        const config = version?.configSnapshot as Record<string, any> | undefined;
        const issues = [
          ...(!profile || !version ? ["active_profile_missing"] : []),
          ...(version && (!Array.isArray(config?.verification?.steps) || !config!.verification.steps.length) ? ["verification_steps_missing"] : []),
          ...(version && (!Array.isArray(config?.protectedActions) || !config!.protectedActions.length) ? ["protected_actions_missing"] : []),
        ];
        return { taskKind, ready: issues.length === 0, profileId: profile?.id ?? null, profileName: profile?.name ?? null, activeVersion: profile?.activeVersion ?? null, issues };
      });
      let detectedWarnings: string[] = [];
      let detectedScripts: string[] = [];
      try {
        const draft = this.draft(project.id, "claude", "implementation") as { warnings?: string[]; detected?: { scripts?: string[] } };
        detectedWarnings = [...new Set(draft.warnings ?? [])]; detectedScripts = draft.detected?.scripts ?? [];
      } catch { detectedWarnings = ["project_analysis_failed"]; }
      const ready = taskKinds.every((item) => item.ready) && detectedWarnings.length === 0;
      return { projectId: project.id, projectName: project.name, ready, taskKinds, detectedWarnings, detectedScripts };
    });
    return { totalProjects: rows.length, readyProjects: rows.filter((row) => row.ready).length, requiredTaskKinds: ["analysis", "implementation"], projects: rows };
  }

  // 실험 없이 사용자가 검토한 일반 project profile의 첫 불변 version을 만든다.
  createManual(input: { projectId: number; userId: number; name: unknown; taskKind: unknown; configSnapshot: unknown; note?: unknown }): AgentPresetRecord {
    const name = textValue(input.name, 200, "프로필 이름", true)!;
    const taskKind = this.taskKind(input.taskKind);
    const project = this.database.prepare("SELECT id, path FROM projects WHERE id = ? AND active = 1").get(input.projectId) as { id: number; path: string } | undefined;
    if (!project) throw new Error("프로젝트를 찾을 수 없습니다.");
    const config = this.profileConfig(input.configSnapshot, taskKind);
    projectProfileLaunch(JSON.stringify(config), project.path);
    const note = textValue(input.note, 20_000, "프로필 메모", false);
    const id = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO agent_presets(id, project_id, name, task_kind, created_by) VALUES (?, ?, ?, ?, ?)
      `).run(id, input.projectId, name, taskKind, input.userId);
      this.database.prepare(`
        INSERT INTO agent_preset_versions(id, preset_id, version, config_snapshot_json, compatibility_json, note, created_by)
        VALUES (?, ?, 1, ?, ?, ?, ?)
      `).run(versionId, id, JSON.stringify(config), JSON.stringify({ status: "unvalidated", warnings: ["사용자 검토 후 활성화가 필요합니다."] }), note, input.userId);
    })();
    return this.list(input.projectId).find((preset) => preset.id === id)!;
  }

  // 기존 version을 덮어쓰지 않고 같은 profile에 다음 version을 추가한다.
  addManualVersion(input: { projectId: number; presetId: string; userId: number; configSnapshot: unknown; note?: unknown }): AgentPresetRecord {
    const preset = this.database.prepare(`SELECT ap.id, ap.task_kind, p.path AS project_path
      FROM agent_presets ap JOIN projects p ON p.id=ap.project_id
      WHERE ap.id = ? AND ap.project_id = ? AND ap.status <> 'archived' AND p.active=1`)
      .get(input.presetId, input.projectId) as { id: string; task_kind: ProjectTaskKind; project_path: string } | undefined;
    if (!preset) throw new Error("프로필을 찾을 수 없습니다.");
    const config = this.profileConfig(input.configSnapshot, preset.task_kind);
    projectProfileLaunch(JSON.stringify(config), preset.project_path);
    const note = textValue(input.note, 20_000, "프로필 메모", false);
    this.database.transaction(() => {
      const latest = this.database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM agent_preset_versions WHERE preset_id = ?").get(preset.id) as { version: number };
      this.database.prepare(`
        INSERT INTO agent_preset_versions(id, preset_id, version, config_snapshot_json, compatibility_json, note, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(crypto.randomUUID(), preset.id, latest.version + 1, JSON.stringify(config), JSON.stringify({ status: "unvalidated", warnings: ["사용자 검토 후 활성화가 필요합니다."] }), note, input.userId);
      this.database.prepare("UPDATE agent_presets SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(preset.id);
    })();
    return this.list(input.projectId).find((entry) => entry.id === preset.id)!;
  }

  // 명시한 불변 version만 활성화한다. 최신 version을 암묵 선택하지 않아 검토 대상이 바뀌지 않는다.
  activate(input: { projectId: number; presetId: string; versionId: string }): AgentPresetRecord {
    const version = this.database.prepare(`
      SELECT v.version, v.config_snapshot_json, project.path AS project_path
      FROM agent_preset_versions v JOIN agent_presets p ON p.id = v.preset_id
      JOIN projects project ON project.id=p.project_id
      WHERE p.id = ? AND p.project_id = ? AND v.id = ? AND p.status <> 'archived' AND project.active=1
    `).get(input.presetId, input.projectId, input.versionId) as { version: number; config_snapshot_json: string; project_path: string } | undefined;
    if (!version) throw new Error("활성화할 프로젝트 프로필 version을 찾을 수 없습니다.");
    projectProfileLaunch(version.config_snapshot_json, version.project_path);
    this.database.transaction(() => {
      this.database.prepare(`
        UPDATE agent_presets SET status = 'draft', updated_at = CURRENT_TIMESTAMP
        WHERE project_id = ? AND task_kind = (SELECT task_kind FROM agent_presets WHERE id = ?) AND id <> ? AND status = 'active'
      `).run(input.projectId, input.presetId, input.presetId);
      this.database.prepare("UPDATE agent_presets SET status = 'active', active_version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(version.version, input.presetId);
    })();
    return this.list(input.projectId).find((entry) => entry.id === input.presetId)!;
  }

  // 프로젝트 파일을 읽어 검토용 초안만 반환한다. DB에는 저장하거나 활성화하지 않는다.
  draft(projectId: number, provider: Provider, taskKindValue: unknown): Record<string, unknown> {
    const taskKind = this.taskKind(taskKindValue);
    const project = this.database.prepare("SELECT name, path FROM projects WHERE id = ? AND active = 1").get(projectId) as { name: string; path: string } | undefined;
    if (!project) throw new Error("프로젝트를 찾을 수 없습니다.");
    const instructions = ["AGENTS.md", "CLAUDE.md"].map((name) => ({ name, present: fs.existsSync(path.join(project.path, name)) }));
    const claudeFile = path.join(project.path, "CLAUDE.md");
    const claudeImportsAgents = instructions.every((entry) => !entry.present) || !instructions.find((entry) => entry.name === "AGENTS.md")?.present
      || (instructions.find((entry) => entry.name === "CLAUDE.md")?.present
        && fs.readFileSync(claudeFile, "utf8").slice(0, 256 * 1024).split(/\r?\n/).some((line) => /^\s*@(?:\.\/)?AGENTS\.md\s*$/.test(line)));
    const scripts: Record<string, string> = {};
    const packageFile = path.join(project.path, "package.json");
    if (fs.existsSync(packageFile)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(packageFile, "utf8")) as { scripts?: Record<string, unknown> };
        for (const [name, command] of Object.entries(manifest.scripts ?? {})) if (typeof command === "string") scripts[name] = command;
      } catch {
        // 잘못된 manifest는 초안 생성을 막지 않고 경고로 드러낸다.
      }
    }
    const genericRecipe = ["typecheck", "lint", "test", "build"].filter((name) => scripts[name]).map((name) => ({ kind: name === "test" ? "full_test" : name === "build" ? "build" : "static", command: `npm run ${name}`, argv: ["npm", "run", name], required: true }));
    const recommendation = registeredProjectProfileRecommendation(project.name, project.path, Object.keys(scripts));
    const recipe = recommendation?.verificationSteps ?? genericRecipe;
    const sandbox = taskKind === "analysis" ? "read-only" : "workspace-write";
    return {
      name: `${project.name} ${taskKind}`,
      taskKind,
      detected: {
        packageManager: fs.existsSync(path.join(project.path, "package-lock.json")) ? "npm" : null,
        scripts: Object.keys(scripts), instructions, recommendationId: recommendation?.id ?? null,
      },
      configSnapshot: {
        schemaVersion: 1,
        taskKind,
        ...(recommendation ? { profileTemplate: { id: recommendation.id, source: "registered_project_catalog" } } : {}),
        runtime: { provider, ...(recommendation?.reasoningEffort ? { reasoningEffort: recommendation.reasoningEffort } : {}) },
        permissions: { sandbox, approvalMode: taskKind === "operations" || taskKind === "high_risk" ? "on-request" : "untrusted", additionalWritePaths: [] },
        instructions: { files: instructions.filter((entry) => entry.present).map((entry) => entry.name) },
        verification: { steps: recipe },
        protectedActions: recommendation?.protectedActions ?? ["deploy", "database_migration", "process_restart", "credential_change"],
        budget: {},
      },
      warnings: [
        ...instructions.filter((entry) => !entry.present).map((entry) => `${entry.name} 없음`),
        ...(provider === "claude" && !claudeImportsAgents ? ["CLAUDE.md import 불일치"] : []),
        ...(recipe.length ? [] : ["검증 명령 없음"]),
        ...(recommendation?.warnings ?? []),
      ],
    };
  }

  private taskKind(value: unknown): ProjectTaskKind {
    if (typeof value !== "string" || !PROJECT_TASK_KINDS.includes(value as ProjectTaskKind)) throw new Error("유효한 작업 종류가 필요합니다.");
    return value as ProjectTaskKind;
  }

  private profileConfig(value: unknown, taskKind: ProjectTaskKind): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("프로필 설정 snapshot이 필요합니다.");
    const config = structuredClone(value as Record<string, unknown>);
    const runtime = config.runtime;
    if (!runtime || typeof runtime !== "object" || !["codex", "claude", "grok"].includes(String((runtime as Record<string, unknown>).provider))) {
      throw new Error("프로필 runtime provider가 올바르지 않습니다.");
    }
    if (config.taskKind !== undefined && config.taskKind !== taskKind) throw new Error("프로필 설정의 작업 종류가 일치하지 않습니다.");
    config.taskKind = taskKind;
    return config;
  }

  // 완료 run과 사용자 accepted 판정을 새 preset version으로 transaction 승격한다.
  promote(input: { runId: string; userId: number; name: unknown; note?: unknown; activate?: boolean }): AgentPresetRecord {
    const run = this.experiments.getRun(input.runId);
    if (!run || run.status !== "completed") throw new Error("완료 run만 프리셋으로 승격할 수 있습니다.");
    const experiment = this.experiments.getExperiment(run.experimentId);
    if (!experiment) throw new Error("실험을 찾을 수 없습니다.");
    const project = this.database.prepare("SELECT path FROM projects WHERE id = ? AND active = 1").get(experiment.projectId) as { path: string } | undefined;
    if (!project) throw new Error("프로젝트를 찾을 수 없습니다.");
    // 실험 결과도 일반 profile과 같은 실행 경계를 통과한 뒤에만 version/accepted 판정을 남긴다.
    projectProfileLaunch(JSON.stringify(run.configSnapshot), project.path);
    const name = textValue(input.name, 200, "프리셋 이름", true)!;
    const note = textValue(input.note, 20_000, "승격 메모", false);
    const runs = this.experiments.listRuns({ variantId: run.variantId, limit: 500 });
    const terminal = runs.filter((entry) => ["completed", "failed", "cancelled", "budget_exceeded"].includes(entry.status));
    const completed = terminal.filter((entry) => entry.status === "completed");
    const judgments = completed.flatMap((entry) => this.experiments.listJudgments(entry.id)).filter((entry) => entry.score !== null);
    const evaluations = this.experiments.listEvaluations({ runId: run.id });
    const warnings = [
      terminal.length < 2 ? "표본이 2회 미만입니다." : null,
      judgments.length === 0 ? "점수 있는 evaluator 판단이 없습니다." : null,
      evaluations.some((entry) => entry.status === "partial") ? "부분 성공 평가가 포함됩니다." : null,
      completed.some((entry) => entry.costUsd === null) ? "일부 실행 비용이 미보고입니다." : null,
    ].filter(Boolean);
    const metrics = {
      sampleSize: terminal.length, successRate: terminal.length ? completed.length / terminal.length : null,
      medianTokens: median(completed.map((entry) => entry.totalTokens)),
      medianCostUsd: median(completed.flatMap((entry) => entry.costUsd === null ? [] : [entry.costUsd])),
      meanJudgmentScore: judgments.length ? judgments.reduce((sum, entry) => sum + (entry.score ?? 0), 0) / judgments.length : null,
    };
    const presetId = this.database.transaction(() => {
      let preset = this.database.prepare("SELECT id FROM agent_presets WHERE project_id = ? AND name = ?").get(experiment.projectId, name) as { id: string } | undefined;
      if (!preset) {
        preset = { id: crypto.randomUUID() };
        this.database.prepare("INSERT INTO agent_presets(id, project_id, name, created_by) VALUES (?, ?, ?, ?)").run(preset.id, experiment.projectId, name, input.userId);
      }
      const latest = this.database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM agent_preset_versions WHERE preset_id = ?").get(preset.id) as { version: number };
      const version = latest.version + 1;
      this.database.prepare(`
        INSERT INTO agent_preset_versions(
          id, preset_id, version, config_snapshot_json, source_experiment_id, source_variant_id, source_run_id,
          promotion_metrics_json, compatibility_json, validated_at, note, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)
      `).run(crypto.randomUUID(), preset.id, version, JSON.stringify(run.configSnapshot), experiment.id, run.variantId, run.id, JSON.stringify(metrics), JSON.stringify({ status: warnings.length ? "warning" : "compatible", warnings }), note, input.userId);
      this.database.prepare(`
        INSERT INTO experiment_human_verdicts(id, experiment_id, user_id, selected_variant_id, verdict, note)
        VALUES (?, ?, ?, ?, 'accepted', ?)
      `).run(crypto.randomUUID(), experiment.id, input.userId, run.variantId, note);
      if (input.activate === false) {
        this.database.prepare("UPDATE agent_presets SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(preset.id);
      } else {
        this.database.prepare("UPDATE agent_presets SET status = 'active', active_version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run(version, preset.id);
      }
      return preset.id;
    })();
    return this.list(experiment.projectId).find((preset) => preset.id === presetId)!;
  }
}
