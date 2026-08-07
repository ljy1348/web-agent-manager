import { describe, expect, it } from "vitest";
import { hiddenLineCount, parseDiffFiles, statusLabel, toSplitRows } from "../src/client/lib/diff-parse";

describe("diff 구조 파싱", () => {
  it("새 파일 diff에서 헤더 노이즈를 없애고 상태·경로만 남긴다", () => {
    const diff = [
      "diff --git a/AGENTS.md b/AGENTS.md",
      "new file mode 100644",
      "index 00000000..0a18707a",
      "--- /dev/null",
      "+++ b/AGENTS.md",
      "@@ -0,0 +1,2 @@",
      "+# 지침",
      "+두 번째 줄",
    ].join("\n");

    const [file] = parseDiffFiles(diff);

    expect(file).toMatchObject({ path: "AGENTS.md", status: "added", additions: 2, deletions: 0, binary: false });
    expect(file.hunks).toHaveLength(1);
    expect(file.hunks[0].lines.map((line) => line.text)).toEqual(["# 지침", "두 번째 줄"]);
    // 원문 헤더가 줄로 새어 나오면 안 된다.
    expect(JSON.stringify(file.hunks)).not.toContain("diff --git");
    expect(JSON.stringify(file.hunks)).not.toContain("/dev/null");
    expect(JSON.stringify(file.hunks)).not.toContain("index 00000000");
  });

  it("삭제·이름 변경·바이너리 상태를 구분한다", () => {
    const diff = [
      "diff --git a/old.txt b/old.txt",
      "deleted file mode 100644",
      "--- a/old.txt",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-사라진 줄",
      "diff --git a/before.ts b/after.ts",
      "similarity index 95%",
      "rename from before.ts",
      "rename to after.ts",
      "diff --git a/logo.png b/logo.png",
      "index 1111111..2222222 100644",
      "Binary files a/logo.png and b/logo.png differ",
    ].join("\n");

    const files = parseDiffFiles(diff);

    expect(files.map((file) => [file.path, file.status])).toEqual([
      ["old.txt", "deleted"],
      ["after.ts", "renamed"],
      ["logo.png", "modified"],
    ]);
    expect(files[1].oldPath).toBe("before.ts");
    expect(files[2].binary).toBe(true);
  });

  it("줄 번호를 이전·이후 파일 기준으로 각각 매긴다", () => {
    const diff = [
      "diff --git a/app.ts b/app.ts",
      "--- a/app.ts",
      "+++ b/app.ts",
      "@@ -10,4 +10,5 @@ function run()",
      " 유지1",
      "-지운 줄",
      "+새 줄1",
      "+새 줄2",
      " 유지2",
    ].join("\n");

    const [file] = parseDiffFiles(diff);
    const lines = file.hunks[0].lines;

    expect(file.hunks[0].section).toBe("function run()");
    expect(lines.map((line) => [line.kind, line.oldNumber, line.newNumber])).toEqual([
      ["context", 10, 10],
      ["remove", 11, null],
      ["add", null, 11],
      ["add", null, 12],
      ["context", 12, 13],
    ]);
  });

  it("공백이 든 경로와 따옴표로 감싼 경로를 복원한다", () => {
    const diff = [
      'diff --git "a/docs/내 문서.md" "b/docs/내 문서.md"',
      "--- a/docs/내 문서.md",
      "+++ b/docs/내 문서.md",
      "@@ -1 +1 @@",
      "-옛 제목",
      "+새 제목",
    ].join("\n");

    const [file] = parseDiffFiles(diff);

    expect(file.path).toBe("docs/내 문서.md");
  });

  it("여러 hunk를 각각 분리하고 파일 통계를 합산한다", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,2 @@",
      "-첫",
      "+첫 수정",
      " 둘",
      "@@ -20,2 +20,3 @@",
      " 스물",
      "+추가",
    ].join("\n");

    const [file] = parseDiffFiles(diff);

    expect(file.hunks).toHaveLength(2);
    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(1);
  });

  it("분할 보기에서 삭제·추가 줄을 좌우로 마주 보게 묶는다", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,3 +1,3 @@",
      " 유지",
      "-지운1",
      "-지운2",
      "+새1",
      " 끝",
    ].join("\n");

    const [file] = parseDiffFiles(diff);
    const rows = toSplitRows(file.hunks[0].lines);

    expect(rows.map((row) => [row.left?.text ?? null, row.right?.text ?? null])).toEqual([
      ["유지", "유지"],
      ["지운1", "새1"],
      ["지운2", null],
      ["끝", "끝"],
    ]);
  });

  it("hunk 사이에 감춰진 줄 수를 계산한다", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,2 @@",
      " 하나",
      " 둘",
      "@@ -10,1 +10,1 @@",
      " 열",
    ].join("\n");

    const [file] = parseDiffFiles(diff);

    // 첫 hunk 앞에는 감춰진 줄이 없고(1행부터 시작), 두 hunk 사이에는 3~9행 7줄이 숨어 있다.
    expect(hiddenLineCount(null, file.hunks[0])).toBe(0);
    expect(hiddenLineCount(file.hunks[0], file.hunks[1])).toBe(7);
    // 마지막 hunk 뒤는 파일 전체 줄 수를 알아야 계산할 수 있다.
    expect(hiddenLineCount(file.hunks[1], null, 30)).toBe(20);
  });

  it("diff가 아니거나 비어 있으면 빈 목록을 돌려준다", () => {
    expect(parseDiffFiles("")).toEqual([]);
    expect(parseDiffFiles("그냥 명령 출력\n두 번째 줄")).toEqual([]);
  });

  it("상태 배지 문구를 한국어로 돌려준다", () => {
    expect(statusLabel("added")).toBe("추가됨");
    expect(statusLabel("deleted")).toBe("삭제됨");
    expect(statusLabel("renamed")).toBe("이름 변경");
    expect(statusLabel("modified")).toBe("수정됨");
  });
});
