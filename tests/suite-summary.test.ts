import { describe, expect, it } from "vitest";
import { recommend, rollupSuite, summarizeVariant } from "../src/server/experiments/suite-summary";
import type { ExperimentRunRecord } from "../src/server/services/experiment-repository";

// 집계에 필요한 필드만 채운 run 레코드를 만든다.
function run(overrides: Partial<ExperimentRunRecord>): ExperimentRunRecord {
  return {
    id: "run", experimentId: "exp", variantId: "variant", attempt: 1, status: "completed",
    configSnapshot: {} as ExperimentRunRecord["configSnapshot"], environmentSnapshot: {},
    baselineCommit: null, workingDirectory: null, providerRunId: null,
    inputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
    outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, totalTokensSource: "reported", costUsd: null,
    terminationReason: "success", error: null, waitedSeconds: 0, waitCount: 0,
    checkStatus: null, checkExitCode: null, checkDurationMs: null, checkOutput: null,
    startedAt: "2026-08-15 00:00:00", finishedAt: "2026-08-15 00:01:00",
    createdAt: "2026-08-15 00:00:00", updatedAt: "2026-08-15 00:01:00",
    ...overrides,
  };
}

describe("스위트 집계", () => {
  it("실작업 시간에서 한도 대기를 빼고 중앙값을 낸다", () => {
    const summary = summarizeVariant("v1", "A", [
      run({ id: "r1", waitedSeconds: 20, waitCount: 1, totalTokens: 100 }),
      run({ id: "r2", waitedSeconds: 0, totalTokens: 300 }),
      run({ id: "r3", waitedSeconds: 0, totalTokens: 200 }),
    ], new Map());

    // 벽시계는 셋 다 60초지만 첫 run은 20초를 대기했으므로 40·60·60 → 중앙값 60.
    expect(summary.activeSecondsMedian).toBe(60);
    expect(summary.totalTokenMedian).toBe(200);
    expect(summary.waitedRuns).toBe(1);
    expect(summary.completedRuns).toBe(3);
  });

  it("Wilson 구간으로 표본 변동 범위를 함께 낸다", () => {
    const summary = summarizeVariant("v1", "A", [
      run({ id: "r1", checkStatus: "passed" }),
      run({ id: "r2", checkStatus: "passed" }),
      run({ id: "r3", checkStatus: "passed" }),
    ], new Map());
    expect(summary.checkPassRate).toBe(1);
    // 3전 3승이어도 하한은 0.44 근처라 "항상 통과"로 읽으면 안 된다.
    expect(summary.checkPassInterval![0]).toBeCloseTo(0.438, 2);
    expect(summary.checkPassInterval![1]).toBe(1);
  });

  it("검사 통과율에서 미실행·환경 오류 표본을 제외한다", () => {
    const summary = summarizeVariant("v1", "A", [
      run({ id: "r1", checkStatus: "passed" }),
      run({ id: "r2", checkStatus: "failed" }),
      run({ id: "r3", checkStatus: "skipped" }),
      run({ id: "r4", checkStatus: "error" }),
    ], new Map());

    // 통과 1 / 실패 1만 분모에 들어간다.
    expect(summary.checkedRuns).toBe(2);
    expect(summary.checkPassRate).toBe(0.5);
  });

  it("표본이 부족한 run은 실패로 세지 않고 종료 표본만 성공률에 넣는다", () => {
    const summary = summarizeVariant("v1", "A", [
      run({ id: "r1", status: "completed" }),
      run({ id: "r2", status: "failed", terminationReason: "provider_limit" }),
      run({ id: "r3", status: "running" }),
    ], new Map());
    expect(summary.terminalRuns).toBe(2);
    expect(summary.successRate).toBe(0.5);
  });
});

describe("권고 산출", () => {
  const passing = (id: string, name: string, passed: number, failed: number, tokens: number) => summarizeVariant(
    id, name,
    [
      ...Array.from({ length: passed }, (_item, index) => run({ id: `${id}-p${index}`, checkStatus: "passed", totalTokens: tokens })),
      ...Array.from({ length: failed }, (_item, index) => run({ id: `${id}-f${index}`, checkStatus: "failed", totalTokens: tokens })),
    ],
    new Map(),
  );

  it("결정적 검사를 rubric보다 먼저 보고 구간이 분리되면 확증으로 매긴다", () => {
    const result = recommend([passing("v1", "P2", 4, 0, 1_000), passing("v2", "P0", 0, 4, 900)]);
    expect(result).toMatchObject({ grade: "confirmed", winnerVariantId: "v1", criterion: "deterministic_check" });
    expect(result.reason).toContain("구간 비겹침");
  });

  it("표본이 최소치 미만이면 우세해도 잠정 관찰값으로만 표시한다", () => {
    const result = recommend([passing("v1", "P2", 2, 0, 1_000), passing("v2", "P0", 0, 2, 900)]);
    expect(result.grade).toBe("tentative");
    expect(result.reason).toContain("관찰값");
  });

  it("표본을 채워도 95% 구간이 겹치면 확증으로 올리지 않는다", () => {
    // 4승0패 대 3승1패는 앞서지만 구간이 겹쳐 표본 변동으로 설명될 수 있다.
    const result = recommend([passing("v1", "P2", 4, 0, 1_000), passing("v2", "P0", 3, 1, 900)]);
    expect(result.grade).toBe("tentative");
    expect(result.reason).toContain("구간이 겹쳐");
  });

  it("품질이 같으면 토큰이 적은 쪽을 고르고, 그마저 비슷하면 무차별로 남긴다", () => {
    const cheaper = recommend([passing("v1", "비싼", 4, 0, 3_000), passing("v2", "싼", 4, 0, 1_000)]);
    expect(cheaper).toMatchObject({ grade: "confirmed", winnerVariantId: "v2", criterion: "cost" });

    const tie = recommend([passing("v1", "A", 4, 0, 1_000), passing("v2", "B", 4, 0, 1_050)]);
    expect(tie).toMatchObject({ grade: "indistinguishable", winnerVariantId: null, criterion: "none" });
    expect(tie.reason).toContain("더 싼 구성");
  });

  it("완료 표본이 하나뿐이면 승자를 만들지 않는다", () => {
    expect(recommend([passing("v1", "A", 4, 0, 1_000)])).toMatchObject({
      grade: "indistinguishable", winnerVariantId: null,
    });
  });
});

describe("스위트 롤업", () => {
  const cell = (label: string, winner: string | null, grade: "confirmed" | "tentative" | "indistinguishable") => ({
    experimentId: `exp-${label}`, label,
    variants: [
      { variantId: "v-a", name: "clean" } as never,
      { variantId: "v-b", name: "clean + caveman" } as never,
    ],
    recommendation: {
      grade, winnerVariantId: winner, runnerUpVariantId: winner === "v-a" ? "v-b" : winner === "v-b" ? "v-a" : null,
      criterion: winner ? ("cost" as const) : ("none" as const), costMultiple: null, reason: "",
    },
  });

  it("상황에 따라 순위가 뒤집히면 일반 권고를 내지 않고 역전 지점을 적는다", () => {
    const rollup = rollupSuite([
      cell("대화형 Q&A", "v-b", "confirmed"),
      cell("파일 산출", "v-a", "confirmed"),
    ]);
    expect(rollup.general).toBeNull();
    expect(rollup.reversals).toEqual([
      { armName: "clean + caveman", winsIn: ["대화형 Q&A"], losesIn: ["파일 산출"] },
      { armName: "clean", winsIn: ["파일 산출"], losesIn: ["대화형 Q&A"] },
    ]);
  });

  it("어느 셀에서도 확증 열세가 아니고 한 셀에서 확증 우세면 일반 권고를 낸다", () => {
    const rollup = rollupSuite([
      cell("대화형 Q&A", "v-b", "confirmed"),
      cell("파일 산출", null, "indistinguishable"),
    ]);
    expect(rollup.general).toMatchObject({ armName: "clean + caveman" });
    expect(rollup.reversals).toEqual([]);
  });

  it("잠정 등급은 우열 근거로 쓰지 않는다", () => {
    const rollup = rollupSuite([cell("대화형 Q&A", "v-b", "tentative")]);
    expect(rollup.general).toBeNull();
    expect(rollup.cells[0]).toMatchObject({ label: "대화형 Q&A", grade: "tentative" });
  });
});
