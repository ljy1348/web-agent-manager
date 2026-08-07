export type DiffFileStatus = "added" | "deleted" | "renamed" | "modified";
export type DiffLineKind = "context" | "add" | "remove";

export interface DiffLine {
  kind: DiffLineKind;
  /** 변경 전 파일에서의 줄 번호. 추가된 줄은 없다. */
  oldNumber: number | null;
  /** 변경 후 파일에서의 줄 번호. 삭제된 줄은 없다. */
  newNumber: number | null;
  text: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** `@@ ... @@` 뒤에 git이 붙여주는 함수·섹션 힌트. */
  section: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: DiffFileStatus;
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

// ```diff 펜스로 감싸 온 경우 펜스만 벗긴다.
function stripFence(text: string): string {
  return text.replace(/^```[a-z]*\n/i, "").replace(/\n?```\s*$/, "");
}

// git이 경로에 따옴표·이스케이프를 붙여 내보낸 경우를 원래 경로로 되돌린다.
function unquotePath(value: string): string {
  if (!value.startsWith("\"") || !value.endsWith("\"")) return value;
  try {
    return JSON.parse(value) as string;
  } catch {
    return value.slice(1, -1);
  }
}

// `diff --git a/경로 b/경로` 한 줄에서 이전·이후 경로를 뽑는다. 공백이 든 경로도 처리한다.
function parseHeaderPaths(line: string): { oldPath: string; path: string } | null {
  const quoted = line.match(/^diff --git ("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/);
  if (!quoted) return null;
  const strip = (value: string): string => unquotePath(value).replace(/^[ab]\//, "");
  return { oldPath: strip(quoted[1]), path: strip(quoted[2]) };
}

// 한 파일 블록의 헤더 줄들을 읽어 상태·경로를 정하고, 본문(hunk) 시작 위치를 돌려준다.
function parseFileHeader(lines: string[]): { file: DiffFile; bodyIndex: number } | null {
  const paths = parseHeaderPaths(lines[0]);
  if (!paths) return null;
  const file: DiffFile = {
    path: paths.path,
    oldPath: null,
    status: "modified",
    binary: false,
    additions: 0,
    deletions: 0,
    hunks: [],
  };
  let index = 1;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("@@")) break;
    if (line.startsWith("new file mode")) file.status = "added";
    else if (line.startsWith("deleted file mode")) file.status = "deleted";
    else if (line.startsWith("rename from ")) { file.status = "renamed"; file.oldPath = unquotePath(line.slice("rename from ".length)); }
    else if (line.startsWith("rename to ")) { file.status = "renamed"; file.path = unquotePath(line.slice("rename to ".length)); }
    else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) file.binary = true;
    // index·mode·similarity 같은 나머지 헤더는 화면에 쓰지 않으므로 버린다.
  }
  if (file.status !== "renamed" && paths.oldPath !== paths.path) file.oldPath = paths.oldPath;
  return { file, bodyIndex: index };
}

// `@@ -a,b +c,d @@ section` 헤더를 구조로 바꾼다.
function parseHunkHeader(line: string): Omit<DiffHunk, "lines"> | null {
  const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/);
  if (!match) return null;
  return {
    oldStart: Number(match[1]),
    oldLines: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newLines: match[4] === undefined ? 1 : Number(match[4]),
    section: match[5] ?? "",
  };
}

// 통합 diff 전체를 파일 → hunk → 줄 구조로 바꾼다.
// 화면은 이 구조만 그리므로 `diff --git`·`index`·`--- /dev/null` 같은 원문 헤더가 그대로 노출되지 않는다.
export function parseDiffFiles(diff: string): DiffFile[] {
  const text = stripFence(diff ?? "");
  if (!text.trim()) return [];
  const blocks = text.split(/(?=^diff --git )/m).filter((block) => block.startsWith("diff --git "));
  const files: DiffFile[] = [];
  for (const block of blocks) {
    const lines = block.replace(/\n+$/, "").split("\n");
    const header = parseFileHeader(lines);
    if (!header) continue;
    const { file, bodyIndex } = header;
    let hunk: DiffHunk | null = null;
    let oldNumber = 0;
    let newNumber = 0;
    for (let index = bodyIndex; index < lines.length; index += 1) {
      const line = lines[index];
      const parsed = parseHunkHeader(line);
      if (parsed) {
        hunk = { ...parsed, lines: [] };
        file.hunks.push(hunk);
        oldNumber = parsed.oldStart;
        newNumber = parsed.newStart;
        continue;
      }
      if (!hunk) continue;
      // "\ No newline at end of file"은 앞 줄에 대한 주석이라 화면 줄로 만들지 않는다.
      if (line.startsWith("\\")) continue;
      if (line.startsWith("+")) {
        hunk.lines.push({ kind: "add", oldNumber: null, newNumber, text: line.slice(1) });
        newNumber += 1;
        file.additions += 1;
      } else if (line.startsWith("-")) {
        hunk.lines.push({ kind: "remove", oldNumber, newNumber: null, text: line.slice(1) });
        oldNumber += 1;
        file.deletions += 1;
      } else if (line.startsWith(" ") || line === "") {
        hunk.lines.push({ kind: "context", oldNumber, newNumber, text: line.slice(1) });
        oldNumber += 1;
        newNumber += 1;
      }
    }
    files.push(file);
  }
  return files;
}

export interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

// 한 hunk의 줄들을 좌우 정렬된 행으로 묶는다. 연속된 삭제·추가는 같은 행에서 마주 보게 한다.
export function toSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (line.kind === "context") {
      rows.push({ left: line, right: line });
      index += 1;
      continue;
    }
    const removed: DiffLine[] = [];
    const added: DiffLine[] = [];
    while (index < lines.length && lines[index].kind === "remove") { removed.push(lines[index]); index += 1; }
    while (index < lines.length && lines[index].kind === "add") { added.push(lines[index]); index += 1; }
    for (let pair = 0; pair < Math.max(removed.length, added.length); pair += 1) {
      rows.push({ left: removed[pair] ?? null, right: added[pair] ?? null });
    }
  }
  return rows;
}

// 두 hunk 사이에 감춰진 줄 수. 0이면 이어져 있어 펼칠 것이 없다.
export function hiddenLineCount(previous: DiffHunk | null, next: DiffHunk | null, totalLines?: number): number {
  if (!next) {
    if (!previous || totalLines === undefined) return 0;
    return Math.max(0, totalLines - (previous.newStart + previous.newLines - 1));
  }
  const from = previous ? previous.newStart + previous.newLines : 1;
  return Math.max(0, next.newStart - from);
}

// 파일 상태를 화면 배지 문구로 바꾼다.
export function statusLabel(status: DiffFileStatus): string {
  return status === "added" ? "추가됨" : status === "deleted" ? "삭제됨" : status === "renamed" ? "이름 변경" : "수정됨";
}
