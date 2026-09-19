import { parseFindingReport, type FindingReport } from "../../shared/experiments";

// 세 공급자에 동일하게 붙는 통제 문구. arm별 promptPrefix와 달리 평가 변수가 아니다.
export const FINDING_REPORT_CONTRACT_INSTRUCTION = [
  "결함 보고 계약:",
  "- 작업 공간의 해당 파일을 실제로 읽은 뒤에만 findings에 보고한다. 코드를 읽기 전에 추측으로 채우지 않는다.",
  "- findings에는 확인한 결함만 넣는다. 작업 계획, 진행 안내, 다음 단계, 상태 보고는 넣지 않는다.",
  "- 확인한 결함이 없으면 findings는 빈 배열이다.",
].join("\n");

// 처리군 접두는 과제 앞, 공통 계약은 과제 뒤에 두어 경계를 나눈다.
export function composeFindingReportPrompt(task: string, skillPrefix = ""): string {
  const prefix = skillPrefix.trim();
  return (prefix ? [prefix, task, FINDING_REPORT_CONTRACT_INSTRUCTION] : [task, FINDING_REPORT_CONTRACT_INSTRUCTION])
    .join("\n\n");
}

// OpenAI structured output(Codex)은 모든 object에 additionalProperties:false와
// properties 전부의 required를 요구한다. evidence·suggestion은 계약상 선택이라 null을 허용한다.
export const FINDING_REPORT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  description: FINDING_REPORT_CONTRACT_INSTRUCTION,
  properties: {
    findings: {
      type: "array",
      description: "확인한 결함만 담는다. 없으면 빈 배열. 작업 계획·진행 안내는 넣지 않는다.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "lineStart", "lineEnd", "category", "severity", "title", "evidence", "suggestion"],
        properties: {
          file: { type: "string" },
          lineStart: { type: "integer", minimum: 1 },
          lineEnd: { type: "integer", minimum: 1 },
          category: { type: "string" },
          severity: { type: "string", enum: ["blocker", "major", "minor"] },
          title: { type: "string", description: "확인한 결함의 제목. 작업 계획이나 진행 안내가 아니다." },
          evidence: { type: ["string", "null"] },
          suggestion: { type: ["string", "null"] },
        },
      },
    },
  },
} as const;

export type FindingOutputStatus = "ok" | "malformed" | "missing" | "not_applicable";

export interface ExtractedFindingReport {
  status: Exclude<FindingOutputStatus, "not_applicable">;
  report: FindingReport | null;
  error: string | null;
}

function parseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function looksLikeFindingReport(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && "findings" in value;
}

// CLI 완료 payload·assistant 본문에서 결함 보고 JSON을 고른다. 없으면 missing이다.
function pickStructuredOutput(source: unknown): unknown {
  if (source === undefined || source === null) return undefined;
  if (typeof source === "string") {
    const parsed = parseJsonObject(source.trim());
    return parsed === undefined ? undefined : pickStructuredOutput(parsed);
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) return undefined;
  const root = source as Record<string, unknown>;
  if (looksLikeFindingReport(root)) return root;
  for (const key of ["structured_output", "structuredOutput", "output"]) {
    if (root[key] !== undefined) {
      const nested = pickStructuredOutput(root[key]);
      if (nested !== undefined) return nested;
    }
  }
  if (root.result !== undefined) return pickStructuredOutput(root.result);
  return undefined;
}

export function extractFindingReport(...sources: unknown[]): ExtractedFindingReport {
  for (const source of sources) {
    const candidate = pickStructuredOutput(source);
    if (candidate === undefined) continue;
    try {
      return { status: "ok", report: parseFindingReport(candidate), error: null };
    } catch (error) {
      return {
        status: "malformed",
        report: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { status: "missing", report: null, error: "구조화 산출물이 없습니다." };
}
