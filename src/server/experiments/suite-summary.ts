import type { ExperimentRunRecord } from "../services/experiment-repository";

// 9-8의 셀 승자 결정 순서와 권고 등급을 계산한다. 지표가 여러 개이므로 순서를 코드로 고정해
// 사후 해석을 막는다: 결정적 검사 → rubric → 비용 효율 → 무차별.
export type RecommendationGrade = "confirmed" | "tentative" | "indistinguishable";

export interface VariantSummary {
  variantId: string;
  name: string;
  terminalRuns: number;
  completedRuns: number;
  successRate: number | null;
  checkPassRate: number | null;
  checkPassInterval: [number, number] | null;
  checkedRuns: number;
  rubricMedian: number | null;
  totalTokenMedian: number | null;
  outputTokenMedian: number | null;
  reasoningTokenMedian: number | null;
  activeSecondsMedian: number | null;
  waitedRuns: number;
}

export interface SuiteRecommendation {
  grade: RecommendationGrade;
  winnerVariantId: string | null;
  runnerUpVariantId: string | null;
  criterion: "deterministic_check" | "rubric" | "cost" | "none";
  costMultiple: number | null;
  reason: string;
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "budget_exceeded"]);
// 확증 등급의 최소 표본. 3회로는 3승0패 대 0승3패여도 95% Wilson 구간이 겹쳐(0.438 vs 0.562)
// 구간 비겹침 조건을 만족할 수 없다. 완전 분리가 가능한 최소가 4회라 그 값을 쓴다.
const CONFIRMATION_MIN_SAMPLES = 4;

// 홀수·짝수 표본 모두에서 안정된 중앙값을 낸다. 값이 없으면 null로 남겨 0으로 추정하지 않는다.
function median(values: number[]): number | null {
  const usable = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (!usable.length) return null;
  const middle = Math.floor(usable.length / 2);
  return usable.length % 2 === 1 ? usable[middle] : (usable[middle - 1] + usable[middle]) / 2;
}

// 통과율의 95% Wilson 점수 구간. 표본이 적을 때 정규 근사가 0%·100%에서 무너지는 문제를 피하고,
// 구간이 겹치는지로 "차이가 표본 변동 안인지"를 볼 수 있게 한다.
export function wilsonInterval(successes: number, total: number, z = 1.96): [number, number] | null {
  if (!Number.isInteger(successes) || !Number.isInteger(total) || total <= 0 || successes < 0 || successes > total) return null;
  const proportion = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = proportion + (z * z) / (2 * total);
  const spread = z * Math.sqrt((proportion * (1 - proportion) + (z * z) / (4 * total)) / total);
  const low = Math.max(0, (center - spread) / denominator);
  const high = Math.min(1, (center + spread) / denominator);
  return [low, high];
}

// 벽시계에서 한도 대기를 뺀 실작업 시간. 대기는 구성의 성질이 아니라 그날 계정 사용량의 문제다.
function activeSeconds(run: ExperimentRunRecord): number | null {
  if (!run.startedAt || !run.finishedAt) return null;
  const parse = (value: string) => Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  const elapsed = (parse(run.finishedAt) - parse(run.startedAt)) / 1_000;
  if (!Number.isFinite(elapsed)) return null;
  return Math.max(0, elapsed - (run.waitedSeconds || 0));
}

// 한 Variant의 종료 run들을 비교 가능한 지표로 접는다.
export function summarizeVariant(
  variantId: string,
  name: string,
  runs: ExperimentRunRecord[],
  rubricScores: Map<string, number[]>,
): VariantSummary {
  const terminal = runs.filter((run) => TERMINAL_STATUSES.has(run.status));
  const completed = terminal.filter((run) => run.status === "completed");
  // 검사가 실행되지 않았거나(skipped) fixture 환경 문제로 실패한(error) run은 통과율에서 뺀다.
  const checked = completed.filter((run) => run.checkStatus === "passed" || run.checkStatus === "failed");
  const scores = completed.flatMap((run) => rubricScores.get(run.id) ?? []);
  return {
    variantId, name,
    terminalRuns: terminal.length,
    completedRuns: completed.length,
    successRate: terminal.length ? completed.length / terminal.length : null,
    checkPassRate: checked.length ? checked.filter((run) => run.checkStatus === "passed").length / checked.length : null,
    checkPassInterval: wilsonInterval(checked.filter((run) => run.checkStatus === "passed").length, checked.length),
    checkedRuns: checked.length,
    rubricMedian: median(scores),
    totalTokenMedian: median(completed.map((run) => run.totalTokens)),
    outputTokenMedian: median(completed.map((run) => run.outputTokens)),
    reasoningTokenMedian: median(completed.map((run) => run.reasoningOutputTokens)),
    activeSecondsMedian: median(completed.map(activeSeconds).filter((value): value is number => value !== null)),
    waitedRuns: terminal.filter((run) => run.waitCount > 0).length,
  };
}

// 두 값의 차이가 의미 있는지 본다. 표본이 적을 때 소수점 차이를 승부로 읽지 않도록 여유를 둔다.
function separated(left: number | null, right: number | null, margin: number): boolean {
  return left !== null && right !== null && left - right > margin;
}

// 승자 결정 순서를 그대로 적용하고, 표본과 일관성에 따라 권고 등급을 매긴다.
export function recommend(summaries: VariantSummary[]): SuiteRecommendation {
  const usable = summaries.filter((entry) => entry.completedRuns > 0);
  if (usable.length < 2) {
    return {
      grade: "indistinguishable", winnerVariantId: null, runnerUpVariantId: null,
      criterion: "none", costMultiple: null,
      reason: "비교할 완료 표본이 둘 이상 필요합니다.",
    };
  }

  const byCheck = [...usable].sort((left, right) => (right.checkPassRate ?? -1) - (left.checkPassRate ?? -1));
  const byRubric = [...usable].sort((left, right) => (right.rubricMedian ?? -1) - (left.rubricMedian ?? -1));

  let winner: VariantSummary | null = null;
  let runnerUp: VariantSummary | null = null;
  let criterion: SuiteRecommendation["criterion"] = "none";

  if (separated(byCheck[0].checkPassRate, byCheck[1].checkPassRate, 0)) {
    [winner, runnerUp] = byCheck;
    criterion = "deterministic_check";
  } else if (separated(byRubric[0].rubricMedian, byRubric[1].rubricMedian, 0.05)) {
    [winner, runnerUp] = byRubric;
    criterion = "rubric";
  } else {
    // 품질이 같으면 더 싼 쪽을 고른다. 토큰을 보고하지 않은 표본은 비교하지 않는다.
    const byCost = usable.filter((entry) => entry.totalTokenMedian !== null)
      .sort((left, right) => (left.totalTokenMedian ?? 0) - (right.totalTokenMedian ?? 0));
    if (byCost.length >= 2 && byCost[0].totalTokenMedian! * 1.1 < byCost[1].totalTokenMedian!) {
      [winner, runnerUp] = byCost;
      criterion = "cost";
    }
  }

  if (!winner || !runnerUp) {
    return {
      grade: "indistinguishable", winnerVariantId: null, runnerUpVariantId: null,
      criterion: "none", costMultiple: null,
      reason: "차이가 표본 변동 안입니다. 더 싼 구성을 쓰세요.",
    };
  }

  const costMultiple = winner.totalTokenMedian !== null && runnerUp.totalTokenMedian
    ? winner.totalTokenMedian / runnerUp.totalTokenMedian
    : null;
  // 확증은 양쪽 모두 3회 이상 표본이 있을 때만 준다. 그 아래는 관찰값이다.
  const enoughSamples = winner.completedRuns >= CONFIRMATION_MIN_SAMPLES && runnerUp.completedRuns >= CONFIRMATION_MIN_SAMPLES;
  // 검사 통과율로 갈렸다면 두 구간이 겹치지 않을 때만 확증으로 올린다. 겹치면 표본 변동으로 설명되는
  // 차이라서 3회를 채웠더라도 관찰값에 머물러야 한다.
  const separatedInterval = criterion !== "deterministic_check"
    || (winner.checkPassInterval !== null && runnerUp.checkPassInterval !== null
      && winner.checkPassInterval[0] > runnerUp.checkPassInterval[1]);
  const grade: RecommendationGrade = enoughSamples && separatedInterval ? "confirmed" : "tentative";
  const criterionLabel = criterion === "deterministic_check" ? "결정적 검사 통과율"
    : criterion === "rubric" ? "블라인드 rubric 중앙값" : "토큰 중앙값";
  return {
    grade, winnerVariantId: winner.variantId, runnerUpVariantId: runnerUp.variantId, criterion, costMultiple,
    reason: grade === "confirmed"
      ? `${criterionLabel}에서 ${winner.name}이 우세합니다(표본 ${winner.completedRuns}회, 95% 구간 비겹침).`
      : enoughSamples
        ? `${criterionLabel}에서 ${winner.name}이 앞서지만 95% 구간이 겹쳐 표본 변동으로 설명될 수 있는 관찰값입니다.`
        : `${criterionLabel}에서 ${winner.name}이 나아 보이지만 표본이 ${CONFIRMATION_MIN_SAMPLES}회 미만이라 관찰값입니다.`,
  };
}

export interface SuiteCell {
  experimentId: string;
  label: string;
  variants: VariantSummary[];
  recommendation: SuiteRecommendation;
}

export interface SuiteRollup {
  // arm 이름 기준 집계. 셀마다 Variant id가 달라 이름으로 묶는다.
  general: { armName: string; reason: string } | null;
  reversals: Array<{ armName: string; winsIn: string[]; losesIn: string[] }>;
  cells: Array<{ label: string; grade: RecommendationGrade; winner: string | null; criterion: SuiteRecommendation["criterion"] }>;
}

// 여러 상황(셀)의 결과를 하나의 조건부 권고로 접는다. 셀마다 순위가 뒤집히면 일반 권고를 내지 않고
// 역전 지점을 그대로 적는다 — 평균을 내면 어디서도 맞지 않는 기본값을 권하게 되기 때문이다(9-8).
export function rollupSuite(cells: SuiteCell[]): SuiteRollup {
  const nameOf = (cell: SuiteCell, variantId: string | null): string | null =>
    cell.variants.find((entry) => entry.variantId === variantId)?.name ?? null;

  const winsIn = new Map<string, string[]>();
  const losesIn = new Map<string, string[]>();
  const push = (map: Map<string, string[]>, key: string, label: string) => {
    map.set(key, [...(map.get(key) ?? []), label]);
  };

  const summary = cells.map((cell) => {
    const winner = nameOf(cell, cell.recommendation.winnerVariantId);
    const runnerUp = nameOf(cell, cell.recommendation.runnerUpVariantId);
    // 확증만 우열로 센다. 잠정·무차별은 순위 근거로 쓰지 않는다.
    if (cell.recommendation.grade === "confirmed" && winner && runnerUp) {
      push(winsIn, winner, cell.label);
      push(losesIn, runnerUp, cell.label);
    }
    return { label: cell.label, grade: cell.recommendation.grade, winner, criterion: cell.recommendation.criterion };
  });

  const armNames = new Set([...winsIn.keys(), ...losesIn.keys()]);
  const reversals = [...armNames]
    .map((armName) => ({ armName, winsIn: winsIn.get(armName) ?? [], losesIn: losesIn.get(armName) ?? [] }))
    .filter((entry) => entry.winsIn.length > 0 && entry.losesIn.length > 0);

  if (reversals.length) {
    return { general: null, reversals, cells: summary };
  }
  // 어떤 셀에서도 확증 열세가 아니고 최소 한 셀에서 확증 우세인 arm만 일반 권고 대상이다.
  const candidate = [...armNames].find((armName) => (winsIn.get(armName)?.length ?? 0) > 0 && (losesIn.get(armName)?.length ?? 0) === 0);
  return {
    general: candidate
      ? { armName: candidate, reason: `${(winsIn.get(candidate) ?? []).join(", ")}에서 확증 우세이고 어느 상황에서도 확증 열세가 아닙니다.` }
      : null,
    reversals: [],
    cells: summary,
  };
}
