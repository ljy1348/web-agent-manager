import crypto from "node:crypto";
import type { AppDatabase } from "../core/database";
import { ExperimentRepository } from "./experiment-repository";

export interface AgentPresetRecord {
  id: string;
  projectId: number;
  name: string;
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
      id: string; project_id: number; name: string; status: AgentPresetRecord["status"]; active_version: number | null;
    }>;
    return presets.map((preset) => ({
      id: preset.id, projectId: preset.project_id, name: preset.name, status: preset.status, activeVersion: preset.active_version,
      versions: (this.database.prepare("SELECT * FROM agent_preset_versions WHERE preset_id = ? ORDER BY version DESC").all(preset.id) as AgentPresetVersionRow[]).map((version) => ({
        id: version.id, version: version.version, configSnapshot: JSON.parse(version.config_snapshot_json),
        sourceExperimentId: version.source_experiment_id, sourceVariantId: version.source_variant_id, sourceRunId: version.source_run_id,
        promotionMetrics: JSON.parse(version.promotion_metrics_json), compatibility: JSON.parse(version.compatibility_json),
        validatedAt: version.validated_at, note: version.note, createdAt: version.created_at,
      })),
    }));
  }

  // 완료 run과 사용자 accepted 판정을 새 preset version으로 transaction 승격한다.
  promote(input: { runId: string; userId: number; name: unknown; note?: unknown; activate?: boolean }): AgentPresetRecord {
    const run = this.experiments.getRun(input.runId);
    if (!run || run.status !== "completed") throw new Error("완료 run만 프리셋으로 승격할 수 있습니다.");
    const experiment = this.experiments.getExperiment(run.experimentId);
    if (!experiment) throw new Error("실험을 찾을 수 없습니다.");
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
