import type { FindingReport, FindingReportItem, GroundTruthFinding } from "../../shared/experiments";
import { categoriesCompatible, resolveFindingCategory } from "./finding-synonyms";

export const FINDING_REPORT_BUDGET_K = 20;
export const FINDING_MAX_AUTO_SPAN = 40;
const DISPLAY_WEIGHT = { blocker: 3, major: 2, minor: 1 } as const;
const DISPLAY_FP_LAMBDA = 1;

export type FindingReviewReason = "wide_span" | "distant_location" | "unknown_category" | "category_mismatch";
export type FindingScoreAxis =
  | "must_find_recall"
  | "false_positives"
  | "location_accuracy"
  | "optional_findings"
  | "cost"
  | "tie";

export interface FindingAutoMatch {
  truthId: string;
  reportIndex: number;
  overlapLines: number;
  iou: number;
  source: "auto" | "manual";
}

export interface FindingReviewItem {
  reportIndex: number;
  file: string;
  lineStart: number;
  lineEnd: number;
  category: string;
  severity: FindingReportItem["severity"];
  title: string;
  evidence: string | null;
  suggestion: string | null;
  candidateTruthIds: string[];
  reason: FindingReviewReason;
}

export interface FindingScore {
  scoredReportCount: number;
  ignoredReportCount: number;
  mustFindTotal: number;
  mustFindFound: number;
  mustFindRecall: number | null;
  optionalTotal: number;
  optionalFound: number;
  falsePositives: number;
  locationAccuracy: number | null;
  displayScore: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  costUsd: number | null;
  findings: FindingReportItem[];
  matches: FindingAutoMatch[];
  reviewQueue: FindingReviewItem[];
}

export interface FindingManualDecision {
  reportIndex: number;
  groundTruthId: string | "false_positive";
}

export interface ScoreFindingReportInput {
  groundTruth: GroundTruthFinding[];
  report: FindingReport;
  taxonomy?: string | null;
  costUsd?: number | null;
  fileLineCounts?: Readonly<Record<string, number>>;
  manualDecisions?: FindingManualDecision[];
}

function spanLines(start: number, end: number): number {
  return end - start + 1;
}

function overlapLines(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): number {
  const start = Math.max(leftStart, rightStart);
  const end = Math.min(leftEnd, rightEnd);
  return end < start ? 0 : end - start + 1;
}

function isFileWide(item: FindingReportItem, fileLineCounts: Readonly<Record<string, number>> | undefined): boolean {
  const fileLines = fileLineCounts?.[item.file];
  return fileLines !== undefined && item.lineStart === 1 && item.lineEnd >= fileLines;
}

function sameFile(left: string, right: string): boolean {
  return left === right;
}

// 보고가 정답에 모여 있거나, 짧은 span이 정답을 거의 품으면 인정한다. 함수 단위 지적을 살리기 위함이다.
function sufficientOverlap(report: FindingReportItem, truth: GroundTruthFinding): { overlap: number; union: number; iou: number } | null {
  const overlap = overlapLines(report.lineStart, report.lineEnd, truth.lineStart, truth.lineEnd);
  if (overlap <= 0) return null;
  const reportSpan = spanLines(report.lineStart, report.lineEnd);
  const truthSpan = spanLines(truth.lineStart, truth.lineEnd);
  const concentrated = overlap / reportSpan >= 0.5;
  const containsTruth = overlap / truthSpan >= 0.8;
  if (!concentrated && !containsTruth) return null;
  const union = reportSpan + truthSpan - overlap;
  return { overlap, union, iou: overlap / union };
}

function canAutoMatch(
  report: FindingReportItem,
  truth: GroundTruthFinding,
  taxonomy: string | null | undefined,
  fileLineCounts: Readonly<Record<string, number>> | undefined,
): { overlap: number; iou: number } | null {
  if (!sameFile(report.file, truth.file)) return null;
  if (spanLines(report.lineStart, report.lineEnd) > FINDING_MAX_AUTO_SPAN) return null;
  if (isFileWide(report, fileLineCounts)) return null;
  const reportCategory = resolveFindingCategory(report.category, taxonomy);
  const truthCategory = resolveFindingCategory(truth.category, taxonomy);
  if (!categoriesCompatible(reportCategory, truthCategory)) return null;
  const overlap = sufficientOverlap(report, truth);
  return overlap ? { overlap: overlap.overlap, iou: overlap.iou } : null;
}

function reviewReason(
  report: FindingReportItem,
  candidates: GroundTruthFinding[],
  taxonomy: string | null | undefined,
  fileLineCounts: Readonly<Record<string, number>> | undefined,
): FindingReviewReason {
  if (spanLines(report.lineStart, report.lineEnd) > FINDING_MAX_AUTO_SPAN || isFileWide(report, fileLineCounts)) {
    return "wide_span";
  }
  const reportCategory = resolveFindingCategory(report.category, taxonomy);
  const nearby = candidates.some((truth) => sufficientOverlap(report, truth));
  const tableGap = candidates.some((truth) => {
    const truthCategory = resolveFindingCategory(truth.category, taxonomy);
    return !reportCategory.inTable || !truthCategory.inTable;
  });
  if (nearby && tableGap) return "unknown_category";
  if (nearby) return "category_mismatch";
  return "distant_location";
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return numerator / denominator;
}

function f1Score(precision: number | null, recall: number | null): number | null {
  if (precision === null || recall === null || precision + recall === 0) return null;
  return (2 * precision * recall) / (precision + recall);
}

function overlapMetrics(report: FindingReportItem, truth: GroundTruthFinding): { overlap: number; iou: number } {
  const overlap = overlapLines(report.lineStart, report.lineEnd, truth.lineStart, truth.lineEnd);
  if (overlap <= 0) return { overlap: 0, iou: 0 };
  const union = spanLines(report.lineStart, report.lineEnd) + spanLines(truth.lineStart, truth.lineEnd) - overlap;
  return { overlap, iou: overlap / union };
}

function applyManualDecisions(
  scoredReports: FindingReportItem[],
  truths: GroundTruthFinding[],
  matches: FindingAutoMatch[],
  decisions: FindingManualDecision[],
): FindingAutoMatch[] {
  const truthById = new Map(truths.map((truth) => [truth.id, truth]));
  const seenReports = new Set<number>();
  const assigned = new Map(matches.map((entry) => [entry.reportIndex, { ...entry }]));

  for (const decision of decisions) {
    if (!Number.isInteger(decision.reportIndex) || decision.reportIndex < 0 || decision.reportIndex >= scoredReports.length) {
      throw new Error("채점 예산 안의 보고 인덱스만 재심 판정할 수 있습니다.");
    }
    if (seenReports.has(decision.reportIndex)) throw new Error("같은 보고를 두 번 판정할 수 없습니다.");
    seenReports.add(decision.reportIndex);
    assigned.delete(decision.reportIndex);
    if (decision.groundTruthId === "false_positive") continue;
    const truth = truthById.get(decision.groundTruthId);
    if (!truth) throw new Error(`재심 대상 정답을 찾을 수 없습니다: ${decision.groundTruthId}`);
    for (const [reportIndex, match] of [...assigned]) {
      if (match.truthId === truth.id) assigned.delete(reportIndex);
    }
    const metrics = overlapMetrics(scoredReports[decision.reportIndex], truth);
    assigned.set(decision.reportIndex, {
      truthId: truth.id, reportIndex: decision.reportIndex,
      overlapLines: metrics.overlap, iou: metrics.iou, source: "manual",
    });
  }
  return [...assigned.values()].sort((left, right) => left.reportIndex - right.reportIndex);
}

function summarizeScore(
  truths: GroundTruthFinding[],
  scoredReports: FindingReportItem[],
  totalReports: number,
  matches: FindingAutoMatch[],
  taxonomy: string | null,
  fileLineCounts: Readonly<Record<string, number>> | undefined,
  costUsd: number | null,
): FindingScore {
  const unmatchedIds = new Set(truths.map((truth) => truth.id));
  for (const match of matches) unmatchedIds.delete(match.truthId);
  const matchedIndexes = new Set(matches.map((entry) => entry.reportIndex));
  const reviewQueue: FindingReviewItem[] = [];
  for (const [reportIndex, report] of scoredReports.entries()) {
    if (matchedIndexes.has(reportIndex)) continue;
    const candidates = truths.filter((truth) => unmatchedIds.has(truth.id) && sameFile(truth.file, report.file));
    if (!candidates.length) continue;
    reviewQueue.push({
      reportIndex,
      file: report.file,
      lineStart: report.lineStart,
      lineEnd: report.lineEnd,
      category: report.category,
      severity: report.severity,
      title: report.title,
      evidence: report.evidence,
      suggestion: report.suggestion,
      candidateTruthIds: candidates.map((truth) => truth.id),
      reason: reviewReason(report, candidates, taxonomy, fileLineCounts),
    });
  }
  const matchedTruth = new Map(matches.map((entry) => [entry.truthId, entry]));
  const mustFind = truths.filter((truth) => truth.mustFind);
  const optional = truths.filter((truth) => !truth.mustFind);
  const mustFindFound = mustFind.filter((truth) => matchedTruth.has(truth.id)).length;
  const optionalFound = optional.filter((truth) => matchedTruth.has(truth.id)).length;
  const falsePositives = scoredReports.length - matches.length;
  const locationAccuracy = matches.length
    ? matches.reduce((sum, entry) => sum + entry.iou, 0) / matches.length
    : null;
  const weightedFound = truths.reduce((sum, truth) => (
    matchedTruth.has(truth.id) ? sum + DISPLAY_WEIGHT[truth.severity] : sum
  ), 0);
  const precision = ratio(matches.length, scoredReports.length);
  const recall = ratio(matches.length, truths.length);
  return {
    scoredReportCount: scoredReports.length,
    ignoredReportCount: Math.max(0, totalReports - FINDING_REPORT_BUDGET_K),
    mustFindTotal: mustFind.length,
    mustFindFound,
    mustFindRecall: ratio(mustFindFound, mustFind.length),
    optionalTotal: optional.length,
    optionalFound,
    falsePositives,
    locationAccuracy,
    displayScore: weightedFound - DISPLAY_FP_LAMBDA * falsePositives,
    precision, recall, f1: f1Score(precision, recall),
    costUsd,
    findings: scoredReports,
    matches, reviewQueue,
  };
}

// 구조화 결함 보고를 정답과 대조한다. 승자 축은 반환 필드의 앞부분이고 F1은 관찰용이다.
export function scoreFindingReport(input: ScoreFindingReportInput): FindingScore {
  const taxonomy = input.taxonomy ?? null;
  const truths = input.groundTruth;
  const scoredReports = input.report.findings.slice(0, FINDING_REPORT_BUDGET_K);
  const unmatchedIds = new Set(truths.map((truth) => truth.id));
  const matches: FindingAutoMatch[] = [];

  for (const [reportIndex, report] of scoredReports.entries()) {
    let best: { truth: GroundTruthFinding; overlap: number; iou: number } | null = null;
    for (const truth of truths) {
      if (!unmatchedIds.has(truth.id)) continue;
      const matched = canAutoMatch(report, truth, taxonomy, input.fileLineCounts);
      if (!matched) continue;
      if (!best || matched.iou > best.iou || (matched.iou === best.iou && truth.id < best.truth.id)) {
        best = { truth, overlap: matched.overlap, iou: matched.iou };
      }
    }
    if (!best) continue;
    unmatchedIds.delete(best.truth.id);
    matches.push({
      truthId: best.truth.id, reportIndex, overlapLines: best.overlap, iou: best.iou, source: "auto",
    });
  }

  const resolved = input.manualDecisions?.length
    ? applyManualDecisions(scoredReports, truths, matches, input.manualDecisions)
    : matches;
  return summarizeScore(
    truths, scoredReports, input.report.findings.length, resolved,
    taxonomy, input.fileLineCounts, input.costUsd ?? null,
  );
}

function decide(
  left: number | null,
  right: number | null,
  prefer: "higher" | "lower",
): "left" | "right" | "tie" | "skip" {
  if (left === null || right === null) return left === null && right === null ? "tie" : "skip";
  if (left === right) return "tie";
  const leftWins = prefer === "higher" ? left > right : left < right;
  return leftWins ? "left" : "right";
}

// 사전 고정 사전식 순서만으로 승자를 고른다. F1·가중 표시 점수·toolCallCount(관찰)는 쓰지 않는다.
export function compareFindingScores(left: FindingScore, right: FindingScore): {
  winner: "left" | "right" | "tie";
  axis: FindingScoreAxis;
} {
  const axes: Array<[FindingScoreAxis, number | null, number | null, "higher" | "lower"]> = [
    ["must_find_recall", left.mustFindRecall, right.mustFindRecall, "higher"],
    ["false_positives", left.falsePositives, right.falsePositives, "lower"],
    ["location_accuracy", left.locationAccuracy, right.locationAccuracy, "higher"],
    ["optional_findings", left.optionalFound, right.optionalFound, "higher"],
    ["cost", left.costUsd, right.costUsd, "lower"],
  ];
  for (const [axis, leftValue, rightValue, prefer] of axes) {
    const result = decide(leftValue, rightValue, prefer);
    if (result === "skip" || result === "tie") continue;
    return { winner: result, axis };
  }
  return { winner: "tie", axis: "tie" };
}
