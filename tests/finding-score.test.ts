import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase } from "../src/server/core/database";
import {
  composeFindingReportPrompt,
  extractFindingReport,
  FINDING_REPORT_CONTRACT_INSTRUCTION,
  FINDING_REPORT_OUTPUT_SCHEMA,
} from "../src/server/experiments/finding-output";
import {
  compareFindingScores,
  FINDING_REPORT_BUDGET_K,
  scoreFindingReport,
} from "../src/server/experiments/finding-score";
import { ExperimentRepository } from "../src/server/services/experiment-repository";
import { parseFindingReport, type FindingReportItem, type GroundTruthFinding } from "../src/shared/experiments";

const SHA = "a".repeat(40);
const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

// 한 줄로 정답 항목을 만든다.
function truth(overrides: Partial<GroundTruthFinding> & Pick<GroundTruthFinding, "id">): GroundTruthFinding {
  return {
    file: "src/app.ts", lineStart: 10, lineEnd: 12, category: "correctness",
    severity: "major", mustFind: true, rationale: "정답",
    ...overrides,
  };
}

// 한 줄로 보고 항목을 만든다.
function report(overrides: Partial<FindingReportItem> = {}): FindingReportItem {
  return {
    file: "src/app.ts", lineStart: 10, lineEnd: 12, category: "correctness",
    severity: "major", title: "결함", evidence: null, suggestion: null,
    ...overrides,
  };
}

// 정답·보고만으로 채점 결과를 만든다.
function score(
  groundTruth: GroundTruthFinding[],
  findings: FindingReportItem[],
  extra: { taxonomy?: string | null; costUsd?: number | null; fileLineCounts?: Record<string, number> } = {},
) {
  return scoreFindingReport({ groundTruth, report: { findings }, ...extra });
}

describe("탐지 채점 매칭", () => {
  it("작업 계획 분류를 채점에서 빼지 않아 빈 보고와 구분한다", () => {
    const planned = score(
      [truth({ id: "gt-1" })],
      [report({ category: "process", title: "이제 파일을 읽겠습니다", lineStart: 1, lineEnd: 1, file: "README.md" })],
    );
    expect(planned.mustFindFound).toBe(0);
    expect(planned.mustFindRecall).toBe(0);
    expect(planned.falsePositives).toBe(1);
    expect(score([truth({ id: "gt-1" })], []).falsePositives).toBe(0);
  });

  it("빈 보고는 재현율 0·오탐 0이고 21번째 보고는 채점에서 빠진다", () => {
    const empty = score([truth({ id: "gt-1" })], []);
    expect(empty).toMatchObject({ mustFindRecall: 0, falsePositives: 0, ignoredReportCount: 0, matches: [] });

    const findings = [
      ...Array.from({ length: FINDING_REPORT_BUDGET_K }, (_item, index) => report({
        file: "other.ts", lineStart: index + 1, lineEnd: index + 1, title: `살포 ${index}`,
      })),
      report({ title: "정답인데 잘림" }),
    ];
    const sprayed = score([truth({ id: "gt-1" })], findings);
    expect(sprayed.scoredReportCount).toBe(20);
    expect(sprayed.ignoredReportCount).toBe(1);
    expect(sprayed.mustFindFound).toBe(0);
    expect(sprayed.falsePositives).toBe(20);
  });

  it("한 줄 핀포인트는 자동 매칭하고 40행 살포·파일 전체는 거부한다", () => {
    const pinpoint = score([truth({ id: "gt-1" })], [report({ lineStart: 11, lineEnd: 11, category: "off-by-one" })]);
    expect(pinpoint.matches).toEqual([expect.objectContaining({ truthId: "gt-1", reportIndex: 0 })]);

    const spray = score([truth({ id: "gt-1" })], [report({ lineStart: 10, lineEnd: 50, title: "살포" })]);
    expect(spray.matches).toEqual([]);
    expect(spray.reviewQueue[0]).toMatchObject({ reason: "wide_span", candidateTruthIds: ["gt-1"] });
    expect(spray.falsePositives).toBe(1);

    const wholeFile = score(
      [truth({ id: "gt-1" })],
      [report({ lineStart: 1, lineEnd: 30, title: "파일 전체" })],
      { fileLineCounts: { "src/app.ts": 30 } },
    );
    expect(wholeFile.matches).toEqual([]);
    expect(wholeFile.reviewQueue[0].reason).toBe("wide_span");
  });

  it("동의어는 자동 매칭하고 한 정답은 보고 하나만 인정한다", () => {
    const result = score(
      [truth({ id: "gt-1", category: "correctness" })],
      [report({ category: "off-by-one" }), report({ category: "bug", title: "중복" })],
      { taxonomy: "code-review-v1" },
    );
    expect(result.matches).toHaveLength(1);
    expect(result.mustFindFound).toBe(1);
    expect(result.falsePositives).toBe(1);
    expect(result.reviewQueue).toEqual([]);
  });

  it("코드리뷰 taxonomy에서도 보안 분류를 자동 매칭한다", () => {
    const result = score(
      [truth({ id: "sqli", file: "auth.js", lineStart: 4, lineEnd: 4, category: "sql-injection", severity: "blocker" })],
      [report({ file: "auth.js", lineStart: 4, lineEnd: 4, category: "sqli", severity: "blocker", title: "SQL 인젝션" })],
      { taxonomy: "code-review-v1" },
    );
    expect(result.mustFindFound).toBe(1);
    expect(result.falsePositives).toBe(0);
    expect(result.matches[0]).toMatchObject({ truthId: "sqli", source: "auto" });
  });

  it("실제 모델처럼 상위 범주와 함수 span으로 지적해도 매칭한다", () => {
    const result = score(
      [
        truth({ id: "sqli", file: "auth.js", lineStart: 4, lineEnd: 5, category: "sql-injection", severity: "blocker" }),
        truth({ id: "boundary", file: "auth.js", lineStart: 9, lineEnd: 9, category: "off-by-one", severity: "major" }),
      ],
      [
        report({ file: "auth.js", lineStart: 2, lineEnd: 5, category: "security", severity: "blocker", title: "SQL 인젝션" }),
        report({ file: "auth.js", lineStart: 7, lineEnd: 11, category: "correctness", severity: "major", title: "경계값 오류" }),
      ],
      { taxonomy: "code-review-v1" },
    );
    expect(result.mustFindFound).toBe(2);
    expect(result.falsePositives).toBe(0);
    expect(result.matches.map((entry) => entry.truthId).sort()).toEqual(["boundary", "sqli"]);
  });

  it("상위 범주는 가족하고만 맞고 형제 CWE는 자동 매칭하지 않는다", () => {
    const parent = score(
      [truth({ id: "xss", file: "auth.js", lineStart: 4, lineEnd: 5, category: "xss" })],
      [report({ file: "auth.js", lineStart: 4, lineEnd: 5, category: "security", title: "보안" })],
    );
    expect(parent.mustFindFound).toBe(1);

    const sibling = score(
      [truth({ id: "xss", file: "auth.js", lineStart: 4, lineEnd: 5, category: "xss" })],
      [report({ file: "auth.js", lineStart: 4, lineEnd: 5, category: "sql-injection", title: "다른 CWE" })],
    );
    expect(sibling.matches).toEqual([]);
    expect(sibling.reviewQueue[0].reason).toBe("category_mismatch");
  });

  it("같은 파일이지만 위치가 멀거나 분류가 표 밖이면 재심 큐에만 남긴다", () => {
    const distant = score(
      [truth({ id: "gt-1", lineStart: 10, lineEnd: 12 })],
      [report({ lineStart: 80, lineEnd: 81, title: "먼 위치" })],
    );
    expect(distant.matches).toEqual([]);
    expect(distant.reviewQueue[0]).toMatchObject({
      reason: "distant_location", candidateTruthIds: ["gt-1"],
      file: "src/app.ts", lineStart: 80, lineEnd: 81, title: "먼 위치", category: "correctness",
    });
    expect(distant.findings[0]).toMatchObject({ title: "먼 위치", lineStart: 80 });

    const unknown = score(
      [truth({ id: "gt-1" })],
      [report({ category: "made-up-class", lineStart: 10, lineEnd: 12 })],
      { taxonomy: "code-review-v1" },
    );
    expect(unknown.matches).toEqual([]);
    expect(unknown.reviewQueue[0].reason).toBe("unknown_category");
  });

  it("사람 재심은 자동 매칭을 뒤집거나 재심 항목을 정답으로 승격한다", () => {
    const promoted = scoreFindingReport({
      groundTruth: [truth({ id: "gt-1", lineStart: 10, lineEnd: 12 })],
      report: { findings: [report({ lineStart: 80, lineEnd: 81, title: "먼 위치" })] },
      manualDecisions: [{ reportIndex: 0, groundTruthId: "gt-1" }],
    });
    expect(promoted.matches).toEqual([expect.objectContaining({ truthId: "gt-1", source: "manual" })]);
    expect(promoted.mustFindFound).toBe(1);
    expect(promoted.falsePositives).toBe(0);
    expect(promoted.reviewQueue).toEqual([]);

    const demoted = scoreFindingReport({
      groundTruth: [truth({ id: "gt-1" })],
      report: { findings: [report()] },
      manualDecisions: [{ reportIndex: 0, groundTruthId: "false_positive" }],
    });
    expect(demoted.matches).toEqual([]);
    expect(demoted.mustFindFound).toBe(0);
    expect(demoted.falsePositives).toBe(1);

    expect(() => scoreFindingReport({
      groundTruth: [truth({ id: "gt-1" })],
      report: { findings: [report()] },
      manualDecisions: [{ reportIndex: 20, groundTruthId: "gt-1" }],
    })).toThrow("채점 예산");
  });
});

describe("탐지 채점 승자 규칙", () => {
  it("mustFind 재현율이 오탐·심각도 가중보다 앞선다", () => {
    const found = score(
      [truth({ id: "blocker", severity: "blocker" }), truth({ id: "minor", severity: "minor" })],
      [report({ title: "하나만" })],
    );
    const missedClean = score(
      [truth({ id: "blocker", severity: "blocker" }), truth({ id: "minor", severity: "minor" })],
      [],
    );
    expect(found.mustFindRecall).toBe(0.5);
    expect(missedClean.mustFindRecall).toBe(0);
    expect(compareFindingScores(found, missedClean)).toEqual({ winner: "left", axis: "must_find_recall" });

    const minors = score(
      [truth({ id: "a", severity: "minor" }), truth({ id: "b", severity: "minor", lineStart: 20, lineEnd: 21 })],
      [report(), report({ lineStart: 20, lineEnd: 21, title: "둘" })],
    );
    const blocker = score(
      [truth({ id: "a", severity: "minor" }), truth({ id: "b", severity: "minor", lineStart: 20, lineEnd: 21 })],
      [report({ title: "하나" })],
    );
    expect(minors.mustFindRecall).toBe(1);
    expect(blocker.mustFindRecall).toBe(0.5);
    expect(compareFindingScores(minors, blocker).axis).toBe("must_find_recall");
    expect(minors.displayScore).not.toBe(blocker.displayScore);
  });

  it("재현율이 같으면 오탐이 적은 쪽이 이기고 F1은 승자에 쓰지 않는다", () => {
    const clean = score([truth({ id: "gt-1" })], [report()]);
    const noisy = score([truth({ id: "gt-1" })], [report(), report({ file: "other.ts", title: "오탐" })]);
    expect(clean.mustFindRecall).toBe(noisy.mustFindRecall);
    expect(clean.falsePositives).toBe(0);
    expect(noisy.falsePositives).toBe(1);
    expect(compareFindingScores(clean, noisy)).toEqual({ winner: "left", axis: "false_positives" });
    expect(clean.f1).not.toBeNull();
    expect(noisy.f1).not.toBeNull();
  });

  it("오탐까지 같으면 위치 정확도·선택 항목·비용 순이다", () => {
    const precise = score([truth({ id: "gt-1" })], [report({ lineStart: 10, lineEnd: 12 })]);
    const loose = score([truth({ id: "gt-1" })], [report({ lineStart: 10, lineEnd: 14 })]);
    expect(precise.mustFindRecall).toBe(1);
    expect(loose.mustFindRecall).toBe(1);
    expect(precise.falsePositives).toBe(0);
    expect(compareFindingScores(precise, loose)).toEqual({ winner: "left", axis: "location_accuracy" });

    const withOptional = score(
      [truth({ id: "must" }), truth({ id: "nit", mustFind: false, lineStart: 40, lineEnd: 41, severity: "minor" })],
      [report(), report({ lineStart: 40, lineEnd: 41, title: "nit" })],
    );
    const mustOnly = score(
      [truth({ id: "must" }), truth({ id: "nit", mustFind: false, lineStart: 40, lineEnd: 41, severity: "minor" })],
      [report()],
    );
    expect(compareFindingScores(withOptional, mustOnly)).toEqual({ winner: "left", axis: "optional_findings" });

    const cheap = score([truth({ id: "gt-1" })], [report()], { costUsd: 0.2 });
    const expensive = score([truth({ id: "gt-1" })], [report()], { costUsd: 0.9 });
    expect(compareFindingScores(cheap, expensive)).toEqual({ winner: "left", axis: "cost" });
  });

  it("도구 호출 횟수는 승자 비교에 쓰이지 않아 빈 보고 둘은 동률이다", () => {
    const unread = score([truth({ id: "gt-1" })], []);
    const readMiss = score([truth({ id: "gt-1" })], []);
    expect(unread).not.toHaveProperty("toolCallCount");
    expect(compareFindingScores(unread, readMiss)).toEqual({ winner: "tie", axis: "tie" });
  });
});

describe("저장소 정답 왕복 채점", () => {
  it("fixture에 저장한 정답으로 보고를 채점한다", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-finding-score-"));
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const database = openDatabase({
      rootDir: root, dataDir: root, homeDir: root, host: "127.0.0.1", port: 0,
      publicUrl: "http://127.0.0.1", allowedRoots: [root], sessionTtlHours: 1,
      runtimeEnabled: false, slack: {}, ntfy: { serverUrl: "https://ntfy.sh" },
    } as AppConfig);
    cleanup.push(() => database.close());
    const repository = new ExperimentRepository(database);
    const fixture = repository.createFixture({
      name: "score-roundtrip", url: "https://github.com/example/repo", pinnedCommit: SHA,
      sizeClass: "small", setupCommand: [], testCommand: [],
      findingTaxonomy: "cwe-injection",
      groundTruth: [truth({ id: "sqli", file: "src/auth.ts", category: "sql-injection", severity: "blocker" })],
    });

    const result = scoreFindingReport({
      groundTruth: fixture.groundTruth ?? [],
      report: { findings: [report({ file: "src/auth.ts", category: "sqli", title: "주입" })] },
      taxonomy: fixture.findingTaxonomy,
    });
    expect(result.mustFindFound).toBe(1);
    expect(result.matches[0].truthId).toBe("sqli");
    expect(repository.getFixture(fixture.id)?.groundTruth).toEqual(fixture.groundTruth);
  });
});

describe("결함 보고 산출물 추출", () => {
  it("중첩 result와 잘못된 JSON을 구분한다", () => {
    expect(extractFindingReport({ result: { findings: [] } })).toEqual({ status: "ok", report: { findings: [] }, error: null });
    expect(extractFindingReport({ findings: "nope" }).status).toBe("malformed");
    expect(extractFindingReport({ answer: "텍스트만" }).status).toBe("missing");
  });

  it("OpenAI strict 스키마(모든 object additionalProperties false·선택 필드는 nullable required)를 지킨다", () => {
    const item = FINDING_REPORT_OUTPUT_SCHEMA.properties.findings.items;
    expect(FINDING_REPORT_OUTPUT_SCHEMA.additionalProperties).toBe(false);
    expect(item.additionalProperties).toBe(false);
    expect(FINDING_REPORT_OUTPUT_SCHEMA.required).toEqual(Object.keys(FINDING_REPORT_OUTPUT_SCHEMA.properties));
    expect(item.required).toEqual(Object.keys(item.properties));
    expect(item.properties.evidence.type).toEqual(["string", "null"]);
    expect(item.properties.suggestion.type).toEqual(["string", "null"]);
    expect(FINDING_REPORT_OUTPUT_SCHEMA.description).toBe(FINDING_REPORT_CONTRACT_INSTRUCTION);
    expect(FINDING_REPORT_OUTPUT_SCHEMA.properties.findings.description).toMatch(/빈 배열/);
    expect(FINDING_REPORT_OUTPUT_SCHEMA.properties.findings.description).toMatch(/계획/);
    expect(item.properties.title.description).toMatch(/계획/);
    expect(parseFindingReport({
      findings: [{
        file: "a.ts", lineStart: 1, lineEnd: 1, category: "bug", severity: "minor", title: "생략",
      }],
    }).findings[0]).toMatchObject({ evidence: null, suggestion: null });
    expect(parseFindingReport({
      findings: [{
        file: "a.ts", lineStart: 1, lineEnd: 1, category: "bug", severity: "minor", title: "널",
        evidence: null, suggestion: null,
      }],
    }).findings[0]).toMatchObject({ evidence: null, suggestion: null });
  });
});

describe("결함 보고 계약 문구", () => {
  it("읽은 뒤에만 보고·계획은 findings에 금지·없으면 빈 배열을 포함한다", () => {
    expect(FINDING_REPORT_CONTRACT_INSTRUCTION).toMatch(/읽은 뒤에만/);
    expect(FINDING_REPORT_CONTRACT_INSTRUCTION).toMatch(/작업 계획/);
    expect(FINDING_REPORT_CONTRACT_INSTRUCTION).toMatch(/진행 안내/);
    expect(FINDING_REPORT_CONTRACT_INSTRUCTION).toMatch(/빈 배열/);
  });

  it("처리군 접두는 과제 앞, 계약은 과제 뒤에 두고 섞지 않는다", () => {
    const composed = composeFindingReportPrompt("저장소를 리뷰하라", "/caveman");
    expect(composed).toBe(`/caveman\n\n저장소를 리뷰하라\n\n${FINDING_REPORT_CONTRACT_INSTRUCTION}`);
    expect(composed.startsWith("/caveman\n\n")).toBe(true);
    expect(composed.endsWith(FINDING_REPORT_CONTRACT_INSTRUCTION)).toBe(true);
    expect(composed.indexOf("/caveman")).toBeLessThan(composed.indexOf("저장소를 리뷰하라"));
    expect(composed.indexOf("저장소를 리뷰하라")).toBeLessThan(composed.indexOf(FINDING_REPORT_CONTRACT_INSTRUCTION));
    expect(composeFindingReportPrompt("저장소를 리뷰하라")).toBe(`저장소를 리뷰하라\n\n${FINDING_REPORT_CONTRACT_INSTRUCTION}`);
  });
});
