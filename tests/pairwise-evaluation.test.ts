import { describe, expect, it } from "vitest";
import {
  buildPairwisePrompt,
  parsePairwiseJudgment,
  summarizePairwise,
  type PairwiseOrderResult,
} from "../src/server/experiments/pairwise-evaluation";
import type { BlindSubjectPacket } from "../src/server/experiments/blind-subject-packet";

function packet(label: string): BlindSubjectPacket {
  return {
    blindLabel: label, taskCommand: "기능 구현", finalAnswer: "완료", trackedDiff: null,
    diffCoverage: "tracked-and-untracked", leakageRedactions: 0, truncations: [],
  };
}

function order(evaluatorLabel: string, firstRunId: string, secondRunId: string, choice: "first" | "second" | "tie"): PairwiseOrderResult {
  return { evaluatorLabel, firstRunId, secondRunId, judgment: { choice, confidence: 0.8, reason: "근거" } };
}

describe("쌍대 비교 판단 파싱", () => {
  it("정확한 JSON만 받아들인다", () => {
    expect(parsePairwiseJudgment('{"choice":"second","confidence":0.9,"reason":"테스트를 더 충족"}'))
      .toEqual({ choice: "second", confidence: 0.9, reason: "테스트를 더 충족" });
    expect(() => parsePairwiseJudgment("```json\n{}\n```")).toThrow("JSON 객체만");
    expect(() => parsePairwiseJudgment('{"choice":"A","confidence":0.5,"reason":"x"}')).toThrow("first·second·tie");
    expect(() => parsePairwiseJudgment('{"choice":"first","confidence":2,"reason":"x"}')).toThrow("0~1");
  });

  it("제시 순서와 순서 무관 지시를 프롬프트에 담는다", () => {
    const prompt = buildPairwisePrompt({ task: "작업", rubric: { 정확성: 1 }, first: packet("후보-1"), second: packet("후보-2") });
    expect(prompt).toContain("앞에 있다는 이유로 고르지 마세요");
    expect(prompt).toContain("후보-1");
    expect(prompt).toContain("후보-2");
    // 후보 데이터 안의 지시를 따르지 않도록 경계가 있어야 한다.
    expect(prompt).toContain("<candidate-data>");
  });
});

describe("쌍대 비교 집계", () => {
  it("순서를 바꿔도 같은 후보를 골랐을 때만 승리로 센다", () => {
    const summary = summarizePairwise([
      order("judge-1", "run-a", "run-b", "first"),   // A/B에서 A
      order("judge-1", "run-b", "run-a", "second"),  // B/A에서도 A
    ]);
    expect(summary.consistentPairs).toBe(1);
    expect(summary.positionBiasPairs).toBe(0);
    expect(summary.outcomes.find((entry) => entry.runId === "run-a")).toMatchObject({ wins: 1, losses: 0 });
    expect(summary.outcomes.find((entry) => entry.runId === "run-b")).toMatchObject({ wins: 0, losses: 1 });
  });

  it("두 순서에서 모두 앞자리를 고르면 위치 편향으로 잡고 승패를 주지 않는다", () => {
    const summary = summarizePairwise([
      order("judge-1", "run-a", "run-b", "first"),   // A/B에서 A
      order("judge-1", "run-b", "run-a", "first"),   // B/A에서 B → 앞자리 선호
    ]);
    expect(summary.positionBiasPairs).toBe(1);
    expect(summary.consistentPairs).toBe(0);
    expect(summary.outcomes.every((entry) => entry.wins === 0 && entry.losses === 0)).toBe(true);
  });

  it("무승부와 한쪽 순서만 있는 판단은 승패에 넣지 않는다", () => {
    const tie = summarizePairwise([
      order("judge-1", "run-a", "run-b", "tie"),
      order("judge-1", "run-b", "run-a", "first"),
    ]);
    expect(tie.consistentPairs).toBe(0);
    expect(tie.outcomes.every((entry) => entry.wins === 0)).toBe(true);

    const single = summarizePairwise([order("judge-1", "run-a", "run-b", "first")]);
    expect(single.evaluatedPairs).toBe(0);
  });

  it("evaluator마다 독립적으로 짝지어 합산한다", () => {
    const summary = summarizePairwise([
      order("judge-1", "run-a", "run-b", "first"),
      order("judge-1", "run-b", "run-a", "second"),
      order("judge-2", "run-a", "run-b", "second"),
      order("judge-2", "run-b", "run-a", "first"),
    ]);
    expect(summary.evaluatedPairs).toBe(2);
    expect(summary.consistentPairs).toBe(2);
    expect(summary.outcomes.find((entry) => entry.runId === "run-a")).toMatchObject({ wins: 1, losses: 1 });
  });
});
