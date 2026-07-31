import { describe, expect, it } from "vitest";
import { looksLikeDiff, parseSplitDiffRows } from "../src/client/lib/diff-view";

describe("looksLikeDiff", () => {
  it("git diff 형식을 diff로 인식한다", () => {
    expect(looksLikeDiff("diff --git a/foo.ts b/foo.ts\nindex 111..222 100644\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1,2 +1,2 @@\n-old\n+new")).toBe(true);
  });

  it("unified diff의 --- a/ 헤더만으로도 diff로 인식한다", () => {
    expect(looksLikeDiff("--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-x\n+y")).toBe(true);
  });

  it("Codex의 *** Begin Patch 형식도 diff로 인식한다", () => {
    expect(looksLikeDiff("*** Begin Patch\n*** Update File: foo.ts\n@@ -1 +1 @@\n-x\n+y\n*** End Patch")).toBe(true);
  });

  it("일반 명령 출력은 diff로 보지 않는다", () => {
    expect(looksLikeDiff("on branch main\nnothing to commit, working tree clean")).toBe(false);
  });

  it("본문에 우연히 +/-가 있어도 diff 헤더가 없으면 diff로 보지 않는다", () => {
    expect(looksLikeDiff("점수: +5, -3 변동이 있었습니다.")).toBe(false);
  });
});

describe("분할 diff 변환", () => {
  it("삭제·추가 블록과 문맥 줄의 이전·이후 줄 번호를 좌우로 정렬한다", () => {
    const rows = parseSplitDiffRows([
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -10,4 +10,4 @@",
      " context",
      "-old one",
      "-old two",
      "+new one",
      " next",
      "+added",
    ].join("\n"));
    const lines = rows.filter((row) => row.kind === "line");

    expect(lines).toEqual([
      { kind: "line", left: { kind: "context", lineNumber: 10, text: "context" }, right: { kind: "context", lineNumber: 10, text: "context" } },
      { kind: "line", left: { kind: "remove", lineNumber: 11, text: "old one" }, right: { kind: "add", lineNumber: 11, text: "new one" } },
      { kind: "line", left: { kind: "remove", lineNumber: 12, text: "old two" }, right: null },
      { kind: "line", left: { kind: "context", lineNumber: 13, text: "next" }, right: { kind: "context", lineNumber: 12, text: "next" } },
      { kind: "line", left: null, right: { kind: "add", lineNumber: 13, text: "added" } },
    ]);
  });
});
