import React from "react";
import { Columns2, Rows3 } from "lucide-react";

export type DiffMode = "unified" | "split";
type SplitDiffKind = "context" | "add" | "remove";
export type SplitDiffCell = { kind: SplitDiffKind; lineNumber: number; text: string };
export type SplitDiffRow =
  | { kind: "meta"; text: string }
  | { kind: "line"; left: SplitDiffCell | null; right: SplitDiffCell | null };

// 통합 diff(unified diff) 형식인지 대략 판정한다 — 이 패턴에 맞을 때만 줄별 색상 뷰를 적용하고,
// 그 외 도구 결과(예: 일반 명령 출력)는 그대로 평범한 텍스트로 보여준다.
export function looksLikeDiff(text: string): boolean {
  return /(^|\n)diff --git |(^|\n)--- a\/|(^|\n)\*\*\* Begin Patch|(^|\n)@@ -\d/.test(text);
}

// message-display.ts가 ```diff 펜스째로 뽑아둔 경우, 뒤에 붙는 배경/줄 스타일과 겹치지 않게 펜스만 벗긴다.
function stripFence(text: string): string {
  return text.replace(/^```[a-z]*\n/i, "").replace(/\n?```\s*$/, "");
}

// 각 줄의 선행 문자로 diff에서의 의미를 분류한다.
function diffLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "diff-line diff-line-file";
  if (line.startsWith("@@")) return "diff-line diff-line-hunk";
  if (line.startsWith("+")) return "diff-line diff-line-add";
  if (line.startsWith("-")) return "diff-line diff-line-remove";
  if (/^(diff --git |index |similarity index|new file mode|deleted file mode|rename (from|to)|\*\*\* )/.test(line)) return "diff-line diff-line-meta";
  return "diff-line diff-line-context";
}

// unified hunk를 이전·이후 줄 번호가 정렬된 좌우 분할 행으로 변환한다.
export function parseSplitDiffRows(diff: string): SplitDiffRow[] {
  const lines = stripFence(diff).split("\n");
  const rows: SplitDiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      rows.push({ kind: "meta", text: line });
      index += 1;
      continue;
    }
    if (!inHunk || line.startsWith("\\ No newline") || (!line.startsWith(" ") && !line.startsWith("+") && !line.startsWith("-"))) {
      rows.push({ kind: "meta", text: line });
      index += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      const text = line.slice(1);
      rows.push({
        kind: "line",
        left: { kind: "context", lineNumber: oldLine, text },
        right: { kind: "context", lineNumber: newLine, text },
      });
      oldLine += 1;
      newLine += 1;
      index += 1;
      continue;
    }

    const removed: string[] = [];
    const added: string[] = [];
    while (index < lines.length && lines[index].startsWith("-")) {
      removed.push(lines[index].slice(1));
      index += 1;
    }
    while (index < lines.length && lines[index].startsWith("+")) {
      added.push(lines[index].slice(1));
      index += 1;
    }
    if (!removed.length && !added.length) {
      rows.push({ kind: "meta", text: line });
      index += 1;
      continue;
    }
    for (let pair = 0; pair < Math.max(removed.length, added.length); pair += 1) {
      const left = pair < removed.length ? { kind: "remove" as const, lineNumber: oldLine++, text: removed[pair] } : null;
      const right = pair < added.length ? { kind: "add" as const, lineNumber: newLine++, text: added[pair] } : null;
      rows.push({ kind: "line", left, right });
    }
  }
  return rows;
}

// diff 보기 모드를 통합 또는 좌우 분할로 전환하는 공용 segmented control이다.
export function DiffModeToggle({ mode, onChange }: { mode: DiffMode; onChange: (mode: DiffMode) => void }): React.ReactElement {
  return <div className="diff-mode-toggle" role="group" aria-label="diff 보기 방식">
    <button type="button" aria-pressed={mode === "unified"} onClick={() => onChange("unified")}><Rows3 size={14} aria-hidden="true" />통합</button>
    <button type="button" aria-pressed={mode === "split"} onClick={() => onChange("split")}><Columns2 size={14} aria-hidden="true" />분할</button>
  </div>;
}

// 분할 diff 한쪽 셀에 줄 번호, 변경 기호와 코드를 표시한다.
function SplitCell({ cell }: { cell: SplitDiffCell | null }): React.ReactElement {
  if (!cell) return <><span className="diff-split-number empty" /><span className="diff-split-code empty" /></>;
  const prefix = cell.kind === "add" ? "+" : cell.kind === "remove" ? "-" : " ";
  return <>
    <span className={`diff-split-number ${cell.kind}`}>{cell.lineNumber}</span>
    <span className={`diff-split-code ${cell.kind}`}><i>{prefix}</i><span className="diff-split-text">{cell.text || "\u00a0"}</span></span>
  </>;
}

// GitHub·git처럼 +/- 줄을 색으로 구분해 보여준다. 별도 라이브러리 없이 줄 단위로 직접 분류한다.
export function DiffView({ diff, mode = "unified" }: { diff: string; mode?: DiffMode }): React.ReactElement {
  if (mode === "split") {
    const rows = parseSplitDiffRows(diff);
    return <div className="diff-split"><div className="diff-split-table">{rows.map((row, index) => row.kind === "meta"
      ? <div className="diff-split-meta" key={index}>{row.text || "\u00a0"}</div>
      : <div className="diff-split-row" key={index}><SplitCell cell={row.left} /><SplitCell cell={row.right} /></div>)}</div></div>;
  }
  const lines = stripFence(diff).split("\n");
  return <pre className="diff-view">{lines.map((line, index) => <div key={index} className={diffLineClass(line)}>{line || " "}</div>)}</pre>;
}
