import React, { useEffect, useMemo, useState } from "react";
import { Columns2, Rows3 } from "lucide-react";
import { diffLanguage, highlightDiffLines, type DiffToken } from "./diff-highlight";
import {
  hiddenLineCount, parseDiffFiles, statusLabel, toSplitRows,
  type DiffFile, type DiffHunk, type DiffLine,
} from "./diff-parse";

export type DiffMode = "unified" | "split";
/** hunk 사이 감춰진 구간을 펼칠 때 원본 줄을 가져오는 함수. 없으면 펼치기 버튼을 내보내지 않는다. */
export type ExpandLines = (path: string) => Promise<string[]>;

const EXPAND_STEP = 20;

// 통합 diff(unified diff) 형식인지 대략 판정한다 — 이 패턴에 맞을 때만 줄별 색상 뷰를 적용하고,
// 그 외 도구 결과(예: 일반 명령 출력)는 그대로 평범한 텍스트로 보여준다.
export function looksLikeDiff(text: string): boolean {
  return /(^|\n)diff --git |(^|\n)--- a\/|(^|\n)\*\*\* Begin Patch|(^|\n)@@ -\d/.test(text);
}

// diff 보기 모드를 통합 또는 좌우 분할로 전환하는 공용 segmented control이다.
export function DiffModeToggle({ mode, onChange }: { mode: DiffMode; onChange: (mode: DiffMode) => void }): React.ReactElement {
  return <div className="diff-mode-toggle" role="group" aria-label="diff 보기 방식">
    <button type="button" aria-pressed={mode === "unified"} onClick={() => onChange("unified")}><Rows3 size={14} aria-hidden="true" />통합</button>
    <button type="button" aria-pressed={mode === "split"} onClick={() => onChange("split")}><Columns2 size={14} aria-hidden="true" />분할</button>
  </div>;
}

// 언어와 코드가 바뀔 때 비동기로 문법 토큰을 만들고 완료 전에는 원문을 유지한다.
function useDiffTokens(lines: string[], language: string | null): DiffToken[][] | null {
  const source = useMemo(() => lines.join("\n"), [lines]);
  const [result, setResult] = useState<{ source: string; language: string; tokens: DiffToken[][] } | null>(null);
  useEffect(() => {
    let active = true;
    if (language) void highlightDiffLines(lines, language).then((tokens) => {
      if (active) setResult({ source, language, tokens });
    }).catch(() => {
      if (active) setResult(null);
    });
    return () => { active = false; };
  }, [language, source]);
  return result?.source === source && result.language === language ? result.tokens : null;
}

// Shiki 토큰 색상과 글꼴 스타일을 밝은/어두운 diff 표면에 맞춰 렌더링한다.
function TokenLine({ text, tokens }: { text: string; tokens?: DiffToken[] }): React.ReactElement {
  if (!tokens?.length) return <>{text || " "}</>;
  return <>{tokens.map((token, index) => {
    const classNames = ["diff-token"];
    if ((token.fontStyle || 0) & 1) classNames.push("italic");
    if ((token.fontStyle || 0) & 2) classNames.push("bold");
    if ((token.fontStyle || 0) & 4) classNames.push("underline");
    const style = { "--diff-token-light": token.lightColor, "--diff-token-dark": token.darkColor } as React.CSSProperties;
    return <span className={classNames.join(" ")} style={style} key={index}>{token.content}</span>;
  })}</>;
}

// 펼쳐진 컨텍스트 줄. 원본에서 그대로 가져온 것이라 추가·삭제 표시가 없다.
function expandedLine(text: string, oldNumber: number, newNumber: number): DiffLine {
  return { kind: "context", oldNumber, newNumber, text };
}

// hunk 사이 감춰진 구간을 펼치는 버튼 행. GitHub처럼 몇 줄이 숨어 있는지 알려준다.
function ExpanderRow({ hidden, columns, onExpand, busy }: {
  hidden: number; columns: number; onExpand: (amount: number | "all") => void; busy: boolean;
}): React.ReactElement {
  return <div className={`diff-expander diff-expander-${columns}`}>
    <button type="button" disabled={busy} onClick={() => onExpand(hidden > EXPAND_STEP ? EXPAND_STEP : "all")}>
      {busy ? "불러오는 중…" : `⌄ ${hidden}줄 펼치기`}
    </button>
    {hidden > EXPAND_STEP && <button type="button" disabled={busy} onClick={() => onExpand("all")}>전체</button>}
  </div>;
}

interface ExpansionState {
  /** hunk 경계별로 이미 펼쳐 둔 줄들. 키는 hunk 인덱스(0이면 첫 hunk 앞). */
  before: Record<number, DiffLine[]>;
}

// 한 파일의 diff 본문. hunk 사이 컨텍스트를 펼칠 수 있고 통합·분할 보기를 모두 지원한다.
function FileDiffBody({ file, mode, expandLines }: { file: DiffFile; mode: DiffMode; expandLines?: ExpandLines }): React.ReactElement {
  const [expansion, setExpansion] = useState<ExpansionState>({ before: {} });
  const [busyBoundary, setBusyBoundary] = useState<number | null>(null);
  const [source, setSource] = useState<string[] | null>(null);
  const language = file.binary ? null : diffLanguage(file.path);

  // 경계(hunk 앞)마다 감춰진 줄 중 아직 안 펼친 개수를 센다.
  function remainingHidden(boundary: number): number {
    const previous = boundary === 0 ? null : file.hunks[boundary - 1];
    const next = file.hunks[boundary] ?? null;
    const already = expansion.before[boundary]?.length ?? 0;
    if (!next) return Math.max(0, hiddenLineCount(previous, null, source?.length) - already);
    return Math.max(0, hiddenLineCount(previous, next) - already);
  }

  async function expand(boundary: number, amount: number | "all"): Promise<void> {
    if (!expandLines) return;
    setBusyBoundary(boundary);
    try {
      const lines = source ?? await expandLines(file.path);
      if (!source) setSource(lines);
      const next = file.hunks[boundary] ?? null;
      const previous = boundary === 0 ? null : file.hunks[boundary - 1];
      const already = expansion.before[boundary] ?? [];
      // 감춰진 구간의 시작(이전 hunk 끝 다음 줄)과 끝(다음 hunk 시작 전)을 새 파일 기준으로 잡는다.
      const from = previous ? previous.newStart + previous.newLines : 1;
      const to = next ? next.newStart - 1 : lines.length;
      const offset = previous ? previous.newStart + previous.newLines - (previous.oldStart + previous.oldLines) : 0;
      const hidden = Math.max(0, to - from + 1);
      const take = amount === "all" ? hidden - already.length : Math.min(amount, hidden - already.length);
      if (take <= 0) return;
      // 아래쪽 경계(다음 hunk가 있는 경우)는 바로 위쪽부터, 마지막 경계는 이어서 아래로 펼친다.
      const added: DiffLine[] = [];
      for (let step = 0; step < take; step += 1) {
        const newNumber = next ? to - already.length - (take - 1 - step) : from + already.length + step;
        const text = lines[newNumber - 1] ?? "";
        added.push(expandedLine(text, newNumber - offset, newNumber));
      }
      setExpansion((current) => ({
        before: { ...current.before, [boundary]: next ? [...added, ...already] : [...already, ...added] },
      }));
    } catch {
      // 원본을 못 읽으면 조용히 접힌 상태를 유지한다(diff 자체는 계속 보여야 한다).
    } finally {
      setBusyBoundary(null);
    }
  }

  if (file.binary) return <p className="diff-empty">바이너리 파일이라 내용을 표시하지 않습니다.</p>;
  if (!file.hunks.length) return <p className="diff-empty">표시할 변경 내용이 없습니다.</p>;

  const columns = mode === "split" ? 4 : 3;
  const blocks: React.ReactNode[] = [];
  for (let index = 0; index <= file.hunks.length; index += 1) {
    const hidden = remainingHidden(index);
    const expanded = expansion.before[index] ?? [];
    if (expandLines && hidden > 0) {
      blocks.push(<ExpanderRow key={`exp:${index}`} hidden={hidden} columns={columns} busy={busyBoundary === index} onExpand={(amount) => void expand(index, amount)} />);
    }
    if (expanded.length) {
      blocks.push(<HunkLines key={`ctx:${index}`} lines={expanded} mode={mode} language={language} />);
    }
    const hunk = file.hunks[index];
    if (hunk) {
      blocks.push(<HunkBlock key={`hunk:${index}`} hunk={hunk} mode={mode} language={language} showHeader={!expanded.length} />);
    }
  }
  return <div className={`diff-body diff-body-${mode}`}>{blocks}</div>;
}

// hunk 헤더(@@ 대신 섹션 힌트)와 줄들을 그린다.
function HunkBlock({ hunk, mode, language, showHeader }: { hunk: DiffHunk; mode: DiffMode; language: string | null; showHeader: boolean }): React.ReactElement {
  return <>
    {showHeader && <div className="diff-hunk-head">{hunk.section || `@@ ${hunk.newStart}행부터`}</div>}
    <HunkLines lines={hunk.lines} mode={mode} language={language} />
  </>;
}

// 줄 목록을 선택한 보기 방식으로 렌더링한다.
function HunkLines({ lines, mode, language }: { lines: DiffLine[]; mode: DiffMode; language: string | null }): React.ReactElement {
  return mode === "split"
    ? <SplitLines lines={lines} language={language} />
    : <UnifiedLines lines={lines} language={language} />;
}

function UnifiedLines({ lines, language }: { lines: DiffLine[]; language: string | null }): React.ReactElement {
  const code = useMemo(() => lines.map((line) => line.text), [lines]);
  const tokens = useDiffTokens(code, language);
  return <>{lines.map((line, index) => <div key={index} className={`diff-row diff-row-${line.kind}`}>
    <span className="diff-num">{line.oldNumber ?? ""}</span>
    <span className="diff-num">{line.newNumber ?? ""}</span>
    <span className="diff-code"><i>{line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}</i><span className="diff-text"><TokenLine text={line.text} tokens={tokens?.[index]} /></span></span>
  </div>)}</>;
}

function SplitLines({ lines, language }: { lines: DiffLine[]; language: string | null }): React.ReactElement {
  const rows = useMemo(() => toSplitRows(lines), [lines]);
  const leftCode = useMemo(() => rows.map((row) => row.left?.text ?? ""), [rows]);
  const rightCode = useMemo(() => rows.map((row) => row.right?.text ?? ""), [rows]);
  const leftTokens = useDiffTokens(leftCode, language);
  const rightTokens = useDiffTokens(rightCode, language);
  return <>{rows.map((row, index) => <div key={index} className="diff-row diff-row-split">
    <SplitSide line={row.left} side="old" tokens={leftTokens?.[index]} />
    <SplitSide line={row.right} side="new" tokens={rightTokens?.[index]} />
  </div>)}</>;
}

function SplitSide({ line, side, tokens }: { line: DiffLine | null; side: "old" | "new"; tokens?: DiffToken[] }): React.ReactElement {
  if (!line) return <><span className="diff-num empty" /><span className="diff-code empty" /></>;
  return <>
    <span className={`diff-num ${line.kind}`}>{(side === "old" ? line.oldNumber : line.newNumber) ?? ""}</span>
    <span className={`diff-code ${line.kind}`}><i>{line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}</i><span className="diff-text"><TokenLine text={line.text} tokens={tokens} /></span></span>
  </>;
}

// 경로가 길면 디렉터리 쪽만 줄이고 파일명은 끝까지 보여준다. 좁은 화면에서 앞부분만 남고
// 정작 파일명이 잘리던 문제를 막기 위한 것이다.
function FilePathLabel({ path, oldPath }: { path: string; oldPath: string | null }): React.ReactElement {
  const index = path.lastIndexOf("/");
  const directory = index >= 0 ? path.slice(0, index + 1) : "";
  const name = index >= 0 ? path.slice(index + 1) : path;
  return <span className="diff-file-path" title={oldPath && oldPath !== path ? `${oldPath} → ${path}` : path}>
    {oldPath && oldPath !== path && <span className="diff-file-old">{oldPath} → </span>}
    {directory && <span className="diff-file-dir">{directory}</span>}
    <span className="diff-file-name">{name}</span>
  </span>;
}

// 파일 하나를 GitHub식 카드(상태 배지·경로·증감 통계 + 접기)로 보여준다.
export function DiffFileCard({ file, mode, expandLines, defaultOpen = true }: {
  file: DiffFile; mode: DiffMode; expandLines?: ExpandLines; defaultOpen?: boolean;
}): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  return <section className={`diff-file${open ? " open" : ""}`}>
    <header className="diff-file-head">
      <button type="button" className="diff-file-toggle" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <span className="diff-file-caret">{open ? "▾" : "▸"}</span>
        <span className={`diff-status diff-status-${file.status}`}>{statusLabel(file.status)}</span>
        <FilePathLabel path={file.path} oldPath={file.oldPath} />
      </button>
      <span className="diff-stat">
        {file.additions > 0 && <b className="diff-stat-add">+{file.additions}</b>}
        {file.deletions > 0 && <b className="diff-stat-del">−{file.deletions}</b>}
      </span>
    </header>
    {open && <FileDiffBody file={file} mode={mode} expandLines={expandLines} />}
  </section>;
}

// 통합 diff 문자열을 GitHub식 파일 카드 목록으로 렌더링한다.
export function DiffView({ diff, mode = "unified", path, expandLines, defaultOpen = true }: {
  diff: string; mode?: DiffMode; path?: string; expandLines?: ExpandLines; defaultOpen?: boolean;
}): React.ReactElement {
  const files = useMemo(() => parseDiffFiles(diff), [diff]);
  if (!files.length) return <pre className="diff-plain">{diff}</pre>;
  // 단일 파일 diff(채팅 상세 등)는 카드 헤더 없이 본문만 보여 기존 표시와 가깝게 유지한다.
  if (files.length === 1 && path) return <FileDiffBody file={files[0]} mode={mode} expandLines={expandLines} />;
  return <div className="diff-file-list">{files.map((file) => (
    <DiffFileCard key={`${file.oldPath ?? ""}:${file.path}`} file={file} mode={mode} expandLines={expandLines} defaultOpen={defaultOpen} />
  ))}</div>;
}
