import { describe, expect, it } from "vitest";
import { looksLikeDiff } from "../src/client/lib/diff-view";
import { parseDiffFiles, toSplitRows } from "../src/client/lib/diff-parse";
import { diffLanguage, diffPath, highlightDiffLines } from "../src/client/lib/diff-highlight";

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
    const [file] = parseDiffFiles([
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
    const rows = toSplitRows(file.hunks[0].lines);

    expect(rows.map((row) => [
      row.left && [row.left.kind, row.left.oldNumber, row.left.text],
      row.right && [row.right.kind, row.right.newNumber, row.right.text],
    ])).toEqual([
      [["context", 10, "context"], ["context", 10, "context"]],
      [["remove", 11, "old one"], ["add", 11, "new one"]],
      [["remove", 12, "old two"], null],
      [["context", 13, "next"], ["context", 12, "next"]],
      [null, ["add", 13, "added"]],
    ]);
  });
});

describe("diff 문법 색상", () => {
  it("파일 경로와 패치 헤더에서 언어를 판정한다", () => {
    expect(diffLanguage("src/App.tsx")).toBe("tsx");
    expect(diffLanguage("Dockerfile.dev")).toBe("dockerfile");
    expect(diffLanguage("assets/photo.png")).toBeNull();
    expect(diffPath("*** Begin Patch\n*** Update File: src/App.tsx\n*** End Patch")).toBe("src/App.tsx");
    expect(diffPath("diff --git a/src/main.py b/src/main.py\n--- a/src/main.py\n+++ b/src/main.py")).toBe("src/main.py");
  });

  it("밝은 테마와 어두운 테마의 언어 토큰 색상을 함께 만든다", async () => {
    const [tokens] = await highlightDiffLines(["const answer: number = 42;"], "typescript");
    expect(new Set(tokens.map((token) => token.lightColor)).size).toBeGreaterThan(1);
    expect(tokens.every((token) => token.lightColor && token.darkColor)).toBe(true);
  });
});
