import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle, FlaskConical, Gavel, LoaderCircle, Play, Plus, RefreshCw, Square } from "lucide-react";
import { api } from "../../api";
import type { Json } from "../../types";

const ACTIVE_STATUSES = new Set(["queued", "preparing", "running", "paused", "evaluating"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "budget_exceeded"]);
const ACTIVE_EVALUATION_STATUSES = new Set(["queued", "running"]);
const STATUS_LABELS: Record<string, string> = {
  queued: "대기", preparing: "준비", running: "실행 중", paused: "일시 정지", evaluating: "평가 중",
  completed: "완료", failed: "실패", cancelled: "취소", budget_exceeded: "예산 초과",
  partial: "부분 성공",
};

// 쉼표로 입력한 실험 변수 목록을 공백과 중복 없이 정규화한다.
function splitList(value: string): string[] {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

// nullable 숫자 입력을 API가 기대하는 숫자 또는 null로 바꾼다.
function optionalNumber(value: string): number | null {
  return value.trim() ? Number(value) : null;
}

// 토큰 수를 비교표에서 빠르게 읽을 수 있는 짧은 형식으로 표시한다.
function formatTokens(value: number): string {
  return new Intl.NumberFormat("ko-KR", { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value || 0);
}

// 비용이 아직 보고되지 않은 실행과 0달러 보고를 구분해 표시한다.
function formatCost(value: number | null): string {
  return value === null || value === undefined ? "미집계" : `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

// 초 단위를 짧은 초·분 형식으로 표시한다.
function formatSeconds(seconds: number): string {
  return seconds < 60 ? `${seconds.toFixed(seconds < 10 ? 1 : 0)}초` : `${Math.floor(seconds / 60)}분 ${Math.round(seconds % 60)}초`;
}

// 완료 run의 실작업 시간을 표시한다. 공급자 한도 대기는 구성의 성질이 아니라 그날 계정 사용량의
// 문제라 빼야 한다 — 포함하면 밤에 돌린 arm이 느린 arm으로 뒤집힌다.
function formatRunDuration(run: Json | null | undefined): string {
  if (!run?.startedAt || !run?.finishedAt) return "-";
  const parse = (value: string) => Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  const milliseconds = Math.max(0, parse(run.finishedAt) - parse(run.startedAt));
  if (!Number.isFinite(milliseconds)) return "-";
  return formatSeconds(Math.max(0, milliseconds / 1_000 - (Number(run.waitedSeconds) || 0)));
}

const TASK_KIND_LABELS: Record<string, string> = {
  maintenance: "유지보수", greenfield: "새로 만들기", feature: "기능 추가", security: "보안",
};
const SIZE_LABELS: Record<string, string> = { small: "소형", medium: "중형", large: "대형" };

const GRADE_LABELS: Record<string, string> = {
  confirmed: "확증", tentative: "잠정", indistinguishable: "무차별",
};
const CRITERION_LABELS: Record<string, string> = {
  deterministic_check: "결정적 검사", rubric: "블라인드 rubric", cost: "토큰 효율", none: "-",
};

const CHECK_LABELS: Record<string, string> = {
  passed: "통과", failed: "실패", skipped: "미실행", error: "실행 불가",
};

// 완성도의 1차 지표인 결정적 검사 결과를 표시한다. rubric 점수보다 먼저 본다.
function formatCheck(run: Json | null | undefined): { label: string; note: string; status: string } {
  const status = typeof run?.checkStatus === "string" ? run.checkStatus : "";
  if (!status) return { label: "-", note: "검증 없음", status: "none" };
  const duration = Number(run?.checkDurationMs);
  const note = status === "failed" && run?.checkExitCode != null
    ? `종료 코드 ${run.checkExitCode}`
    : Number.isFinite(duration) && duration > 0 ? formatSeconds(duration / 1_000) : "fixture 명령";
  return { label: CHECK_LABELS[status] || status, note, status };
}

// 한도 대기가 있었던 run은 시간 지표의 근거와 토큰 오염 가능성을 함께 드러낸다.
function formatWaitNote(run: Json | null | undefined): string {
  const count = Number(run?.waitCount) || 0;
  if (!count) return "실작업";
  return `실작업 · 한도 대기 ${count}회 ${formatSeconds(Number(run?.waitedSeconds) || 0)} 제외`;
}

// 점수를 보고한 evaluator만 사용해 평균 품질 점수를 계산한다.
function meanJudgmentScore(judgments: Json[] | null | undefined): number | null {
  const scores = (judgments || []).map((entry) => entry.score).filter((score): score is number => typeof score === "number" && Number.isFinite(score));
  return scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null;
}

// Variant의 종료 run을 기준으로 단순 성공률과 표본 수를 계산한다.
function variantSummary(variant: Json): { successRate: number | null; completed: number; terminal: number } {
  const terminal = (variant.runs || []).filter((run: Json) => TERMINAL_STATUSES.has(run.status));
  const completed = terminal.filter((run: Json) => run.status === "completed").length;
  return { successRate: terminal.length ? completed / terminal.length : null, completed, terminal: terminal.length };
}

// evaluator가 남긴 구조화 결과에서 사람이 읽을 짧은 근거를 찾는다.
function judgmentReason(judgment: Json): string {
  const result = judgment.result || {};
  return String(result.reason || result.rationale || result.summary || "구조화 근거 없음");
}

// 프로젝트별 실험 생성·조건 비교·실행 상세를 한 화면에서 관리한다.
export function ExperimentsView({ project }: { project: Json | null }): React.ReactElement {
  const [experiments, setExperiments] = useState<Json[]>([]);
  const [selectedExperimentId, setSelectedExperimentId] = useState("");
  const [selectedRunId, setSelectedRunId] = useState("");
  const [detail, setDetail] = useState<Json | null>(null);
  const [summary, setSummary] = useState<Json | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showExperimentForm, setShowExperimentForm] = useState(false);
  const [showVariantForm, setShowVariantForm] = useState(false);
  const [experimentName, setExperimentName] = useState("");
  const [command, setCommand] = useState("");
  const [hypothesis, setHypothesis] = useState("");
  const [controlled, setControlled] = useState("runtime.model, budget");
  const [treatment, setTreatment] = useState("skills.mode");
  const [repetitions, setRepetitions] = useState("1");
  const [taskKind, setTaskKind] = useState("");
  const [fixtureId, setFixtureId] = useState("");
  const [fixtures, setFixtures] = useState<Json[]>([]);
  const [variantName, setVariantName] = useState("");
  const [provider, setProvider] = useState<"codex" | "claude">("codex");
  const [model, setModel] = useState("");
  const [reasoning, setReasoning] = useState("high");
  const [sandbox, setSandbox] = useState("workspace-write");
  const [skillBaseline, setSkillBaseline] = useState<"installed" | "clean">("installed");
  const [skillActivation, setSkillActivation] = useState<"native" | "session_start">("native");
  const [skillCandidates, setSkillCandidates] = useState<Json[]>([]);
  const [additionalSkills, setAdditionalSkills] = useState<string[]>([]);
  const [skillCandidateError, setSkillCandidateError] = useState("");
  const [maxTurns, setMaxTurns] = useState("");
  const [maxSeconds, setMaxSeconds] = useState("1800");
  const [maxTokens, setMaxTokens] = useState("");
  const [maxCost, setMaxCost] = useState("");
  const [harnessType, setHarnessType] = useState<"single" | "orchestrator_worker" | "evaluator_optimizer">("single");
  const [secondaryProvider, setSecondaryProvider] = useState<"codex" | "claude">("claude");
  const [secondaryModel, setSecondaryModel] = useState("");
  const [workerCount, setWorkerCount] = useState("2");
  const [maxIterations, setMaxIterations] = useState("3");
  const [minimumScore, setMinimumScore] = useState("0.8");
  const [maxNoImprovement, setMaxNoImprovement] = useState("1");
  const [diffStatsHook, setDiffStatsHook] = useState(false);
  const [diffCheckHook, setDiffCheckHook] = useState(false);
  const [showPromotionForm, setShowPromotionForm] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [promotionNote, setPromotionNote] = useState("");
  const [promotedPreset, setPromotedPreset] = useState<Json | null>(null);
  const [showEvaluatorForm, setShowEvaluatorForm] = useState(false);
  const [codexEvaluator, setCodexEvaluator] = useState(true);
  const [claudeEvaluator, setClaudeEvaluator] = useState(true);
  const [codexEvaluatorModel, setCodexEvaluatorModel] = useState("");
  const [claudeEvaluatorModel, setClaudeEvaluatorModel] = useState("");

  const selectedExperiment = useMemo(
    () => experiments.find((experiment) => experiment.id === selectedExperimentId) || experiments[0] || null,
    [experiments, selectedExperimentId],
  );
  const hasActiveRuns = experiments.some((experiment) => (experiment.variants || [])
    .some((variant: Json) => (variant.runs || []).some((run: Json) => ACTIVE_STATUSES.has(run.status))));
  const hasActiveEvaluations = Boolean(detail?.evaluations?.some((evaluation: Json) => ACTIVE_EVALUATION_STATUSES.has(evaluation.status)));

  // 프로젝트의 실험·Variant·최근 run 매트릭스를 다시 읽는다.
  async function load(silent = false): Promise<void> {
    if (!project?.id) return;
    if (!silent) setLoading(true);
    setError("");
    try {
      const data = await api(`/projects/${project.id}/experiments`);
      const next = data.experiments || [];
      setExperiments(next);
      setSelectedExperimentId((current) => next.some((item: Json) => item.id === current) ? current : next[0]?.id || "");
      if (selectedRunId && !next.some((item: Json) => (item.variants || []).some((variant: Json) => (variant.runs || []).some((run: Json) => run.id === selectedRunId)))) {
        setSelectedRunId("");
        setDetail(null);
      }
    } catch (caught: any) {
      setError(caught?.message || "실험 목록을 불러오지 못했습니다.");
    } finally {
      if (!silent) setLoading(false);
    }
  }

  // 선택한 run의 node·event·checkpoint·judgment provenance를 읽는다.
  async function loadDetail(runId: string, silent = false): Promise<void> {
    if (!runId) return;
    if (!silent) setLoading(true);
    try {
      const data = await api(`/experiment-runs/${runId}`);
      setDetail(data);
    } catch (caught: any) {
      setError(caught?.message || "실행 상세를 불러오지 못했습니다.");
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => {
    setExperiments([]);
    setSelectedExperimentId("");
    setSelectedRunId("");
    setDetail(null);
    if (project?.id) void load();
  }, [project?.id]);

  useEffect(() => {
    if (!project?.id) return;
    void api(`/projects/${project.id}/experiment-fixtures`).then((data) => setFixtures(data.fixtures || [])).catch(() => setFixtures([]));
  }, [project?.id]);

  useEffect(() => {
    setSummary(null);
    if (!selectedExperiment?.id) return;
    void api(`/experiments/${selectedExperiment.id}/summary`).then(setSummary).catch(() => setSummary(null));
  }, [selectedExperiment?.id, experiments]);

  useEffect(() => {
    if (!showVariantForm || !project?.id) return;
    setSkillCandidateError("");
    setAdditionalSkills([]);
    void api(`/projects/${project.id}/experiment-skills?provider=${provider}`).then((data) => {
      setSkillCandidates(data.candidates || []);
    }).catch((caught: any) => {
      setSkillCandidates([]);
      setSkillCandidateError(caught?.message || "스킬 후보를 불러오지 못했습니다.");
    });
  }, [showVariantForm, project?.id, provider]);

  useEffect(() => {
    if (!project?.id || (!hasActiveRuns && !hasActiveEvaluations)) return;
    const timer = window.setInterval(() => {
      void load(true);
      if (selectedRunId) void loadDetail(selectedRunId, true);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [project?.id, hasActiveRuns, hasActiveEvaluations, selectedRunId]);

  // 실험 가설과 통제/평가 변수를 명시한 새 실험을 만든다.
  // 설계에 적어둔 반복 횟수만큼 arm 교차 순서로 큐를 만들어 백그라운드에서 순차 실행한다.
  async function startRunPlan(): Promise<void> {
    if (!selectedExperiment?.id) return;
    setLoading(true);
    setError("");
    try {
      await api(`/experiments/${selectedExperiment.id}/run-plans`, {
        method: "POST",
        body: JSON.stringify({ stage: "screening", repetitions: Number(selectedExperiment.design?.repetitions) || 1 }),
      });
      setNotice("실행 계획을 시작했습니다. 한 번에 하나씩 순서대로 실행합니다.");
      await load(true);
    } catch (caught: any) {
      setError(caught?.message || "실행 계획을 시작하지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }

  async function createExperiment(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!project?.id) return;
    setLoading(true);
    setError("");
    try {
      const data = await api(`/projects/${project.id}/experiments`, {
        method: "POST",
        body: JSON.stringify({
          name: experimentName, command,
          taskKind: taskKind || null, fixtureId: fixtureId || null,
          design: {
            schemaVersion: 1, hypothesis: hypothesis || null,
            controlledVariables: splitList(controlled), treatmentVariables: splitList(treatment),
            repetitions: Number(repetitions), randomizeOrder: true,
          },
          rubric: {},
        }),
      });
      setExperimentName("");
      setCommand("");
      setHypothesis("");
      setShowExperimentForm(false);
      await load(true);
      setSelectedExperimentId(data.experiment.id);
      setNotice("실험을 만들었습니다. 비교할 Variant를 추가하세요.");
    } catch (caught: any) {
      setError(caught?.message || "실험 생성에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  }

  // 실행 가능한 single-agent 조건을 현재 실험의 새 Variant로 저장한다.
  async function createVariant(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!selectedExperiment) return;
    setLoading(true);
    setError("");
    try {
      await api(`/experiments/${selectedExperiment.id}/variants`, {
        method: "POST",
        body: JSON.stringify({
          name: variantName,
          ordinal: selectedExperiment.variants?.length || 0,
          config: {
            schemaVersion: 1,
            runtime: {
              provider, accountId: null, model: model || null, reasoningEffort: reasoning || null,
              sandbox, maxTurns: optionalNumber(maxTurns),
            },
            skills: {
              mode: skillBaseline === "installed" ? "all" : "none",
              enabled: [], disabled: [], profile: harnessType === "single" ? "isolated_overlay" : "native", baseline: skillBaseline,
              additions: harnessType === "single" ? additionalSkills : [], comparisonId: harnessType === "single" ? `${provider}-default` : null,
              activation: harnessType === "single" && provider === "claude" ? skillActivation : "native",
            },
            harness: {
              type: harnessType,
              maxIterations: harnessType === "evaluator_optimizer" ? Number(maxIterations) : 1,
              minimumScore: harnessType === "evaluator_optimizer" ? optionalNumber(minimumScore) : null,
              maxNoImprovement: harnessType === "evaluator_optimizer" ? Number(maxNoImprovement) : 1,
              workerCount: harnessType === "orchestrator_worker" ? Number(workerCount) : 2,
              secondaryRuntime: harnessType === "single" ? null : {
                provider: secondaryProvider, accountId: null, model: secondaryModel || null, reasoningEffort: reasoning || null,
              },
            },
            hooks: [diffStatsHook ? "diff_stats" : null, diffCheckHook ? "git_diff_check" : null].filter(Boolean),
            budget: { maxSeconds: Number(maxSeconds), maxTokens: optionalNumber(maxTokens), maxCostUsd: optionalNumber(maxCost) },
          },
        }),
      });
      setVariantName("");
      setShowVariantForm(false);
      await load(true);
      setNotice("Variant를 추가했습니다.");
    } catch (caught: any) {
      setError(caught?.message || "Variant 생성에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  }

  // 선택한 Variant를 격리 worktree에서 실제 실행하고 상세 화면을 연다.
  async function startRun(variant: Json): Promise<void> {
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const data = await api(`/experiment-variants/${variant.id}/runs`, { method: "POST" });
      setSelectedRunId(data.run.id);
      await Promise.all([load(true), loadDetail(data.run.id, true)]);
      setNotice(`${variant.name} 실행을 시작했습니다.`);
    } catch (caught: any) {
      setError(caught?.message || "실행 시작에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  }

  // 실행 중인 Runtime에 취소를 전달하고 최종 원장 상태를 다시 읽는다.
  async function cancelRun(runId: string): Promise<void> {
    setLoading(true);
    setError("");
    try {
      await api(`/experiment-runs/${runId}/cancel`, { method: "POST" });
      await Promise.all([load(true), loadDetail(runId, true)]);
      setNotice("실행을 취소했습니다.");
    } catch (caught: any) {
      setError(caught?.message || "실행 취소에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  }

  // 완료 run을 선택한 Codex·Claude evaluator에게 블라인드 rubric 평가로 전달한다.
  async function startEvaluation(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!selectedRunId) return;
    const evaluators = [
      codexEvaluator ? { label: "Codex judge", provider: "codex", model: codexEvaluatorModel || null, reasoningEffort: "high", family: "codex" } : null,
      claudeEvaluator ? { label: "Claude judge", provider: "claude", model: claudeEvaluatorModel || null, reasoningEffort: "high", family: "claude" } : null,
    ].filter(Boolean);
    if (!evaluators.length) {
      setError("최소 한 명의 evaluator를 선택하세요.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await api(`/experiment-runs/${selectedRunId}/evaluations`, {
        method: "POST", body: JSON.stringify({ evaluators }),
      });
      setShowEvaluatorForm(false);
      await loadDetail(selectedRunId, true);
      setNotice(`${evaluators.length}명의 블라인드 평가를 시작했습니다.`);
    } catch (caught: any) {
      setError(caught?.message || "평가 시작에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  }

  // 실행 중인 평가 호출을 취소하고 완료된 판단은 partial로 보존한다.
  async function cancelEvaluation(evaluationId: string): Promise<void> {
    if (!selectedRunId) return;
    setLoading(true);
    setError("");
    try {
      await api(`/experiment-evaluations/${evaluationId}/cancel`, { method: "POST" });
      await loadDetail(selectedRunId, true);
      setNotice("평가를 취소했습니다. 이미 완료된 판단은 보존됩니다.");
    } catch (caught: any) {
      setError(caught?.message || "평가 취소에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  }

  // 완료 run의 불변 설정과 사용자 accepted 판정을 실제 Agent preset 새 버전으로 승격한다.
  async function promoteRun(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!selectedRunId) return;
    setLoading(true);
    setError("");
    try {
      const data = await api(`/experiment-runs/${selectedRunId}/promote`, {
        method: "POST", body: JSON.stringify({ name: presetName, note: promotionNote || null, activate: true }),
      });
      setPromotedPreset(data.preset);
      setShowPromotionForm(false);
      setNotice(`${data.preset.name} v${data.preset.activeVersion}을 활성 프리셋으로 승격했습니다.`);
    } catch (caught: any) {
      setError(caught?.message || "프리셋 승격에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  }

  // baseline 전환 시 이미 native 포함되는 중복 추가 선택을 제거한다.
  function changeSkillBaseline(next: "installed" | "clean"): void {
    setSkillBaseline(next);
    if (next === "installed") {
      const installed = new Set(skillCandidates.filter((candidate) => candidate.includedByDefault).map((candidate) => candidate.id));
      setAdditionalSkills((current) => current.filter((id) => !installed.has(id)));
    }
  }

  // 실행별 pinned overlay에 넣을 스킬 후보를 토글한다.
  function toggleAdditionalSkill(id: string): void {
    setAdditionalSkills((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]);
  }

  // 표의 run을 선택하고 provenance 상세를 함께 갱신한다.
  function selectRun(runId: string): void {
    setSelectedRunId(runId);
    setShowPromotionForm(false);
    setPromotedPreset(null);
    void loadDetail(runId);
  }

  if (!project) return <section className="agent-lab-empty"><FlaskConical size={34} /><h2>Agent Lab</h2><p>먼저 작업 프로젝트를 선택하세요.</p></section>;

  return <section className="agent-lab">
    <div className="section-head"><div><span className="eyebrow">Agent Lab · v0.4 foundation</span><h2>조건을 바꿔 실행하고, 측정하고, 판단합니다</h2></div><div className="action-row"><button type="button" onClick={() => void load()} disabled={loading}><RefreshCw size={14} className={loading ? "spin" : ""} />새로고침</button><button type="button" className="primary" onClick={() => setShowExperimentForm((value) => !value)}><Plus size={14} />새 실험</button></div></div>
    <div className="lab-scope-note"><strong>현재 실행 가능</strong><span>Single의 strict 스킬 baseline+overlay · Orchestrator→Workers · Evaluator→Optimizer · 복수 블라인드 evaluator · Winner promotion · 공통 예산 · 저장소 fixture와 과제 유형 · fixture 검증 명령 · arm 교차 실행 계획 · 한도 대기 후 재개</span><strong>비교 주의</strong><span>strict 스킬 비교는 single에서만 비스킬 config·Git commit을 고정합니다. 시간은 한도 대기를 뺀 실작업 기준이며, 대기 후 재개한 run은 캐시·턴 구조가 달라져 토큰 지표가 오염될 수 있습니다.</span><strong>다음 단계</strong><span>pairwise · 신뢰구간 통계 · graph 공급자별 overlay · graph 한도 대기 · 일반 채팅 preset 실행</span></div>
    {error && <p className="global-error">{error}</p>}
    {notice && <p className="lab-notice">{notice}</p>}
    {showExperimentForm && <form className="lab-form card" onSubmit={createExperiment}>
      <div className="card-top">실험 정의</div>
      <label>이름<input required maxLength={200} value={experimentName} onChange={(event) => setExperimentName(event.target.value)} placeholder="스킬 유무 비교" /></label>
      <label className="span-2">모든 Variant에 줄 명령<textarea required rows={4} value={command} onChange={(event) => setCommand(event.target.value)} placeholder="이 프로젝트에 기능을 구현하고 테스트해" /></label>
      <label className="span-2">가설<input value={hypothesis} onChange={(event) => setHypothesis(event.target.value)} placeholder="review 스킬이 성공률을 높인다" /></label>
      <label>통제 변수<input value={controlled} onChange={(event) => setControlled(event.target.value)} /></label>
      <label>평가 변수<input value={treatment} onChange={(event) => setTreatment(event.target.value)} /></label>
      <label>반복 횟수<input type="number" min="1" max="100" value={repetitions} onChange={(event) => setRepetitions(event.target.value)} /></label>
      <label>과제 유형<select value={taskKind} onChange={(event) => setTaskKind(event.target.value)}><option value="">미지정</option>{Object.entries(TASK_KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>대상 저장소<select value={fixtureId} onChange={(event) => setFixtureId(event.target.value)}><option value="">등록 프로젝트</option>{fixtures.filter((entry) => entry.status === "ready").map((entry) => <option key={entry.id} value={entry.id}>{SIZE_LABELS[entry.sizeClass] || entry.sizeClass} · {entry.name}</option>)}</select></label>
      <span className="lab-form-hint">무작위화·반복은 현재 설계 provenance이며 자동 실행은 아직 지원하지 않습니다. MVP에서는 각 실행 버튼을 명시적으로 눌러 반복합니다.</span>
      <div className="lab-form-actions span-2"><button type="button" onClick={() => setShowExperimentForm(false)}>취소</button><button className="primary" type="submit" disabled={loading}>실험 만들기</button></div>
    </form>}
    <div className="lab-layout">
      <aside className="lab-experiment-list panel">
        <div className="lab-panel-head"><strong>Experiments</strong><span>{experiments.length}</span></div>
        {!experiments.length && !loading && <p className="muted">아직 실험이 없습니다.</p>}
        {experiments.map((experiment) => <button type="button" key={experiment.id} className={selectedExperiment?.id === experiment.id ? "active" : ""} onClick={() => { setSelectedExperimentId(experiment.id); setSelectedRunId(""); setDetail(null); }}><strong>{experiment.name}</strong><small>{experiment.variants?.length || 0} variants · {experiment.design?.repetitions || 1}회 설계</small>{(experiment.taskKind || experiment.fixtureId) && <small className="lab-experiment-tags">{experiment.taskKind && <span className="lab-tag">{TASK_KIND_LABELS[experiment.taskKind] || experiment.taskKind}</span>}{experiment.fixtureId && (() => { const linked = fixtures.find((entry) => entry.id === experiment.fixtureId); return linked ? <span className="lab-tag">{SIZE_LABELS[linked.sizeClass] || linked.sizeClass} · {linked.name}</span> : null; })()}</small>}</button>)}
      </aside>
      <div className="lab-main">
        {selectedExperiment ? <>
          <article className="lab-design card"><div><span className="eyebrow">Hypothesis</span><h3>{selectedExperiment.name}</h3><p>{selectedExperiment.design?.hypothesis || "가설이 아직 없습니다."}</p></div><dl><dt>통제</dt><dd>{selectedExperiment.design?.controlledVariables?.join(", ") || "미지정"}</dd><dt>평가</dt><dd>{selectedExperiment.design?.treatmentVariables?.join(", ") || "미지정"}</dd><dt>순서</dt><dd>{selectedExperiment.design?.randomizeOrder ? "무작위화" : "고정"}</dd></dl><div className="lab-design-actions"><button type="button" onClick={() => setShowVariantForm((value) => !value)}><Plus size={14} />Variant 추가</button><button type="button" disabled={loading || !selectedExperiment.variants?.length} onClick={() => void startRunPlan()}><Play size={14} />계획 실행 · {selectedExperiment.design?.repetitions || 1}회 교차</button></div></article>
          {showVariantForm && <form className="lab-form card" onSubmit={createVariant}>
            <div className="card-top">Agent Variant</div>
            <label>이름<input required value={variantName} onChange={(event) => setVariantName(event.target.value)} placeholder="Codex High + Skills" /></label>
            <label>Provider<select value={provider} onChange={(event) => { const next = event.target.value as "codex" | "claude"; setProvider(next); if (next === "claude") setMaxTurns(""); else setSkillActivation("native"); }}><option value="codex">Codex</option><option value="claude">Claude</option></select></label>
            <label>Model<input required value={model} onChange={(event) => setModel(event.target.value)} placeholder="비교에 사용할 명시 모델" /></label>
            <label>Reasoning<input required value={reasoning} onChange={(event) => setReasoning(event.target.value)} placeholder="high" /></label>
            <label>Sandbox<select value={sandbox} onChange={(event) => setSandbox(event.target.value)}><option value="read-only">read-only</option><option value="workspace-write">workspace-write</option></select></label>
            <label>스킬 기준선<select value={skillBaseline} onChange={(event) => changeSkillBaseline(event.target.value as "installed" | "clean")}><option value="installed">현재 설치 스킬셋</option><option value="clean">깨끗한 기본 스킬셋</option></select></label>
            {harnessType === "single" && provider === "claude" && <label>추가 스킬 활성화<select value={skillActivation} onChange={(event) => setSkillActivation(event.target.value as "native" | "session_start")}><option value="native">Claude 자동 발견</option><option value="session_start">SessionStart 강제 주입</option></select></label>}
            {harnessType === "single" ? <fieldset className="lab-skill-picker span-2"><legend>선택 추가 스킬</legend>{skillCandidateError && <small className="error">{skillCandidateError}</small>}{!skillCandidates.length && !skillCandidateError && <small>`.agent-lab/skills` 또는 현재 provider에서 발견된 후보가 없습니다.</small>}{skillCandidates.map((candidate) => {
              const nativeDuplicate = skillBaseline === "installed" && candidate.includedByDefault;
              return <label key={candidate.id} title={nativeDuplicate ? "현재 설치 baseline에 이미 포함되어 있습니다." : candidate.source}><input type="checkbox" checked={additionalSkills.includes(candidate.id)} disabled={nativeDuplicate} onChange={() => toggleAdditionalSkill(candidate.id)} /><span>{candidate.name}<small>{candidate.scope} · {nativeDuplicate ? "현재 포함" : candidate.source}</small></span></label>;
            })}</fieldset> : <span className="lab-form-hint span-2">graph/loop는 현재 공급자별 native skills all/none만 비교합니다. 선택 추가 overlay는 Single에서 사용하세요.</span>}
            <label>Harness<select value={harnessType} onChange={(event) => { const next = event.target.value as typeof harnessType; setHarnessType(next); if (next !== "single") setAdditionalSkills([]); }}><option value="single">Single</option><option value="orchestrator_worker">Orchestrator → Workers</option><option value="evaluator_optimizer">Evaluator → Optimizer loop</option></select></label>
            {harnessType !== "single" && <><label>Secondary provider<select value={secondaryProvider} onChange={(event) => setSecondaryProvider(event.target.value as "codex" | "claude")}><option value="codex">Codex</option><option value="claude">Claude</option></select></label><label>Secondary model<input required value={secondaryModel} onChange={(event) => setSecondaryModel(event.target.value)} placeholder="비교에 사용할 명시 모델" /></label></>}
            {harnessType === "orchestrator_worker" && <label>Worker 수<input type="number" min="1" max="8" value={workerCount} onChange={(event) => setWorkerCount(event.target.value)} /></label>}
            {harnessType === "evaluator_optimizer" && <><label>최대 반복<input type="number" min="1" max="100" value={maxIterations} onChange={(event) => setMaxIterations(event.target.value)} /></label><label>최소 점수<input type="number" min="0" max="1" step="0.05" value={minimumScore} onChange={(event) => setMinimumScore(event.target.value)} /></label><label>무개선 허용<input type="number" min="0" max="100" value={maxNoImprovement} onChange={(event) => setMaxNoImprovement(event.target.value)} /></label></>}
            <label>Provider max turns<input type="number" min="1" value={maxTurns} onChange={(event) => setMaxTurns(event.target.value)} placeholder={provider === "claude" ? "현재 Claude CLI 미지원" : "제한 없음"} disabled={provider === "claude"} /></label>
            <label>최대 시간(초)<input required type="number" min="1" max="86400" value={maxSeconds} onChange={(event) => setMaxSeconds(event.target.value)} /></label>
            <label>최대 토큰<input type="number" min="1" value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} placeholder="제한 없음" /></label>
            <label>최대 비용(USD)<input type="number" min="0" step="0.01" value={maxCost} onChange={(event) => setMaxCost(event.target.value)} placeholder="제한 없음" /></label>
            <label className="lab-check"><input type="checkbox" checked={diffStatsHook} onChange={(event) => setDiffStatsHook(event.target.checked)} />diff_stats hook</label>
            <label className="lab-check"><input type="checkbox" checked={diffCheckHook} onChange={(event) => setDiffCheckHook(event.target.checked)} />git_diff_check hook</label>
            <p className="lab-form-hint span-2">같은 provider 비교 그룹에서는 모델·권한·하네스·훅·예산·활성화 방식이 다르면 저장을 거부합니다. 추가 스킬은 전체 디렉터리를 실행별 bundle로 복사·해시하며, Claude SessionStart는 전역 설정 쓰기 없이 선택 본문만 강제 주입합니다.</p>
            <div className="lab-form-actions span-2"><button type="button" onClick={() => setShowVariantForm(false)}>취소</button><button className="primary" type="submit" disabled={loading}>Variant 저장</button></div>
          </form>}
          {summary?.recommendation && <div className="lab-recommendation card"><div className="card-top">권고</div><div className="lab-recommendation-body"><span className={`lab-grade ${summary.recommendation.grade}`}>{GRADE_LABELS[summary.recommendation.grade] || summary.recommendation.grade}</span><strong>{summary.recommendation.winnerVariantId ? (summary.variants || []).find((entry: Json) => entry.variantId === summary.recommendation.winnerVariantId)?.name || "-" : "승자 없음"}</strong><small>기준 {CRITERION_LABELS[summary.recommendation.criterion] || summary.recommendation.criterion}{summary.recommendation.costMultiple ? ` · 기준선 대비 토큰 ${summary.recommendation.costMultiple.toFixed(2)}배` : ""}</small></div><p className="muted">{summary.recommendation.reason}</p></div>}
          <div className="lab-matrix card"><div className="card-top">Variant comparison</div>{!selectedExperiment.variants?.length ? <p className="muted">비교할 Variant를 추가하세요.</p> : <div className="table-wrap"><table><thead><tr><th>조건</th><th>성공률</th><th>검증</th><th>평가 품질</th><th>속도</th><th>최근 상태</th><th>토큰</th><th>비용</th><th>실행</th></tr></thead><tbody>{selectedExperiment.variants.map((variant: Json) => {
            const summary = variantSummary(variant);
            const latest = variant.runs?.[0];
            const baseline = variant.config.skills?.baseline || (variant.config.skills?.mode === "none" ? "clean" : "installed");
            const additionCount = variant.config.skills?.additions?.length || 0;
            return <tr key={variant.id}><td><strong>{variant.name}</strong><small><span className={`provider ${variant.config.runtime.provider}`}>{variant.config.runtime.provider}</span>{variant.config.runtime.model || "default"} · {baseline} + {additionCount} skill</small></td><td>{summary.successRate === null ? "-" : `${Math.round(summary.successRate * 100)}%`}<small>{summary.terminal < 2 ? "⚠ 표본 부족" : `${summary.completed}/${summary.terminal} 성공`}</small></td><td><span className={`lab-check ${formatCheck(latest).status}`}>{formatCheck(latest).label}</span><small>{formatCheck(latest).note}</small></td><td>{latest?.judgmentSummary?.meanScore == null ? "-" : `${Math.round(latest.judgmentSummary.meanScore * 100)}점`}<small>{latest?.judgmentSummary?.count ? `${latest.judgmentSummary.count} judgments` : "평가 없음"}</small></td><td>{formatRunDuration(latest)}<small>{formatWaitNote(latest)}</small></td><td>{latest ? <button className="lab-run-link" type="button" onClick={() => selectRun(latest.id)}><span className={`lab-status ${latest.status}`}>{STATUS_LABELS[latest.status] || latest.status}</span><small>#{latest.attempt}</small></button> : "-"}</td><td>{latest ? formatTokens(latest.totalTokens) : "-"}<small>{latest?.totalTokensSource || "출처 미보고"}</small></td><td>{latest ? formatCost(latest.costUsd) : "-"}<small>{latest?.costUsd == null ? "공급자 미보고" : "reported"}</small></td><td><button type="button" className="lab-icon-action" title="새 실행" disabled={loading} onClick={() => void startRun(variant)}><Play size={14} />실행</button>{latest && ACTIVE_STATUSES.has(latest.status) && <button type="button" className="lab-icon-action danger" disabled={loading} onClick={() => void cancelRun(latest.id)}><Square size={12} />취소</button>}</td></tr>;
          })}</tbody></table></div>}</div>
          {selectedRunId && detail && <article className="lab-run-detail card">
            <div className="lab-detail-head"><div><span className="eyebrow">Run #{detail.run.attempt}</span><h3><span className={`lab-status ${detail.run.status}`}>{STATUS_LABELS[detail.run.status] || detail.run.status}</span>{detail.run.configSnapshot.runtime.provider} · {detail.run.configSnapshot.runtime.model || "default"}</h3></div><div className="action-row">{detail.run.status === "completed" && <><button type="button" onClick={() => setShowEvaluatorForm((value) => !value)}><Gavel size={13} />복수 평가</button><button className="primary" type="button" onClick={() => { setPresetName((value) => value || `${selectedExperiment?.name || "Agent"} 우승`); setShowPromotionForm((value) => !value); }}><FlaskConical size={13} />프리셋 승격</button></>}{ACTIVE_STATUSES.has(detail.run.status) && <button className="danger" type="button" onClick={() => void cancelRun(detail.run.id)}><Square size={12} />실행 취소</button>}</div></div>
            <div className="lab-run-metrics"><span><small>Quality</small><strong>{meanJudgmentScore(detail.judgments) === null ? "미평가" : `${Math.round(meanJudgmentScore(detail.judgments)! * 100)}점`}</strong></span><span><small>Duration</small><strong>{formatRunDuration(detail.run)}</strong><small>{formatWaitNote(detail.run)}</small></span><span><small>Tokens</small><strong>{formatTokens(detail.run.totalTokens)}</strong></span><span><small>Cost</small><strong>{formatCost(detail.run.costUsd)}</strong></span><span><small>Check</small><strong className={`lab-check ${formatCheck(detail.run).status}`}>{formatCheck(detail.run).label}</strong><small>{formatCheck(detail.run).note}</small></span><span><small>Termination</small><strong>{detail.run.terminationReason || "진행 중"}</strong></span><span><small>Nodes</small><strong>{detail.nodes?.length || 0}</strong></span></div>
            {detail.run.error && <p className="lab-run-error">{detail.run.error}</p>}
            {detail.run.environmentSnapshot?.skillIsolation?.profile === "isolated_overlay" && <div className="lab-isolation-proof"><strong>스킬 격리 증명</strong><span>{detail.run.environmentSnapshot.skillIsolation.baseline} + {detail.run.environmentSnapshot.skillIsolation.additions?.length || 0} · {detail.run.environmentSnapshot.skillIsolation.activation || "native"} · control {String(detail.run.environmentSnapshot.skillIsolation.controlFingerprint).slice(0, 12)} · bundle {String(detail.run.environmentSnapshot.skillIsolation.digest).slice(0, 12)}</span></div>}
            {showPromotionForm && <form className="lab-promotion-form" onSubmit={promoteRun}><div><strong>Winner promotion</strong><small>이 run의 불변 설정을 새 preset version으로 저장하고 accepted 판정을 남깁니다.</small></div><label>프리셋 이름<input required value={presetName} onChange={(event) => setPresetName(event.target.value)} /></label><label>선택 근거<input value={promotionNote} onChange={(event) => setPromotionNote(event.target.value)} placeholder="품질 대비 비용 증가를 수용" /></label><button className="primary" type="submit" disabled={loading}>활성 프리셋으로 승격</button></form>}
            {promotedPreset && <div className="lab-promotion-result"><strong>{promotedPreset.name} · v{promotedPreset.activeVersion}</strong><span>{Math.round((promotedPreset.versions?.[0]?.promotionMetrics?.successRate || 0) * 100)}% 성공률 · {promotedPreset.versions?.[0]?.promotionMetrics?.sampleSize || 0} samples</span>{promotedPreset.versions?.[0]?.compatibility?.warnings?.map((warning: string) => <small key={warning}>⚠ {warning}</small>)}</div>}
            {showEvaluatorForm && <form className="lab-evaluator-form" onSubmit={startEvaluation}>
              <div><strong>블라인드 rubric 평가</strong><small>최종 답변과 tracked diff만 정제해 별도 빈 작업공간에서 순차 심사합니다.</small></div>
              <label><input type="checkbox" checked={codexEvaluator} onChange={(event) => setCodexEvaluator(event.target.checked)} />Codex judge</label>
              <input aria-label="Codex evaluator model" value={codexEvaluatorModel} onChange={(event) => setCodexEvaluatorModel(event.target.value)} placeholder="Codex 기본 모델" disabled={!codexEvaluator} />
              <label><input type="checkbox" checked={claudeEvaluator} onChange={(event) => setClaudeEvaluator(event.target.checked)} />Claude judge</label>
              <input aria-label="Claude evaluator model" value={claudeEvaluatorModel} onChange={(event) => setClaudeEvaluatorModel(event.target.value)} placeholder="Claude 기본 모델" disabled={!claudeEvaluator} />
              <button className="primary" type="submit" disabled={loading || (!codexEvaluator && !claudeEvaluator)}><Play size={13} />평가 시작</button>
            </form>}
            {!!detail.evaluations?.length && <div className="lab-evaluations">{detail.evaluations.map((evaluation: Json) => <article key={evaluation.id}>
              <div><strong>Rubric evaluation</strong><span className={`lab-status ${evaluation.status}`}>{STATUS_LABELS[evaluation.status] || evaluation.status}</span>{ACTIVE_EVALUATION_STATUSES.has(evaluation.status) && <button className="danger" type="button" onClick={() => void cancelEvaluation(evaluation.id)}><Square size={11} />취소</button>}</div>
              <small>{evaluation.calls?.map((call: Json) => `${call.evaluatorLabel}: ${call.status} · ${formatTokens(call.totalTokens)} tokens · ${formatCost(call.costUsd)}`).join(" / ") || "호출 준비 중"}</small>
              {evaluation.error && <p>{evaluation.error}</p>}
            </article>)}</div>}
            <div className="lab-detail-grid"><section><h4>최근 이벤트</h4><ol className="lab-event-list">{(detail.events || []).slice(-12).reverse().map((event: Json) => <li key={event.id}><code>{event.sequence}</code><span>{event.type}</span><small>{event.createdAt}</small></li>)}</ol>{!detail.events?.length && <p className="muted">이벤트가 없습니다.</p>}</section><section><h4>에이전트 판단</h4>{!detail.judgments?.length ? <p className="muted">아직 evaluator 판단이 없습니다. 완료 run에서 ‘복수 평가’를 시작하세요.</p> : <div className="lab-judgments">{detail.judgments.map((judgment: Json) => <article key={judgment.id}><div><strong>{judgment.evaluatorLabel}</strong><span className={`provider ${judgment.evaluatorProvider || ""}`}>{judgment.evaluatorProvider || judgment.evaluatorKind}</span>{judgment.sameFamily && <span className="lab-bias-warning"><AlertTriangle size={12} />피험 모델과 동일 계열</span>}</div><dl><dt>Evaluator</dt><dd>{judgment.evaluatorModel || judgment.evaluatorKind} · {judgment.evaluatorFamily || "family 미상"}</dd><dt>Subject</dt><dd>{judgment.subjectModel || "model 미상"} · {judgment.subjectFamily || "family 미상"}</dd><dt>Blind/order</dt><dd>{judgment.blindLabel || "미지정"} / {judgment.presentationOrder ?? "-"}</dd><dt>Score</dt><dd>{judgment.score ?? "-"} · 신뢰도 {judgment.confidence ?? "-"}</dd></dl><p>{judgmentReason(judgment)}</p></article>)}</div>}</section></div>
          </article>}
        </> : <div className="resource-empty">실험을 만들거나 선택하세요.</div>}
      </div>
    </div>
    {loading && <div className="lab-loading"><LoaderCircle className="spin" size={18} />처리 중</div>}
  </section>;
}
