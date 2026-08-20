import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { LoaderCircle } from "lucide-react";
import { api } from "../../api";
import { LoadingState } from "../../components/LoadingState";
import { GithubRepositoryList } from "../../components/GithubRepositoryList";
import { GitBranchControl } from "../../components/GitBranchControl";
import { DiffFileCard, DiffModeToggle, DiffView, type DiffMode, type ExpandLines } from "../../lib/diff-view";
import { parseDiffFiles, statusLabel } from "../../lib/diff-parse";
import type { Json } from "../../types";

type GitTab = "repositories" | "diff" | "github";
type GitHubPanel = "issues" | "pulls" | "actions";

// 목록을 한 번에 불러오는 기본 개수. "더 보기"를 누를 때마다 이만큼씩 늘려서 다시 조회한다.
// 서버도 같은 기본값을 쓰므로(git-routes.ts) 한쪽만 바꾸면 첫 조회와 더 보기 결과가 어긋난다.
const COMMIT_PAGE = 30;
const GITHUB_PAGE = { issues: 50, pulls: 50, runs: 20 };

// `git status --short --branch`의 첫 줄("## branch...origin/branch [ahead 1]" 형태)에서 브랜치
// 이름만 뽑는다. status는 이미 60초 주기로 자동 새로고침되므로, 여기서 뽑은 이름도 그 주기에 맞춰
// 저절로 최신을 유지한다(별도 조회를 새로 만들지 않는다 — 그러면 그 조회만 또 stale해질 수 있다).
function currentBranchFromStatus(status: string): string {
  const line = (status || "").split("\n")[0] || "";
  const match = line.match(/^## (.+)$/);
  if (!match) return "";
  const raw = match[1];
  if (raw.startsWith("HEAD (") || raw === "HEAD") return "";
  return raw.split("...")[0].split(" ")[0];
}

// 화면이 좁아 목록과 상세가 세로로 쌓이는 폭인지 본다. 커밋 사이드바(700px)와
// GitHub 목록/상세(1100px)는 1열로 바뀌는 CSS 기준이 서로 다르다.
function isStackedLayout(maxWidth: number): boolean {
  return window.matchMedia(`(max-width: ${maxWidth}px)`).matches;
}

// 고른 항목의 상세를 화면 맨 위로 올린다.
// 반드시 목록 접힘이 DOM에 반영된 뒤(useLayoutEffect)에 불러야 한다 — 접히는 것과 스크롤이 겹치면
// 목표 위치가 접히기 전 레이아웃 기준으로 잡혀 상세 중간에서 멈춘다.
function scrollToDetail(element: HTMLElement | null | undefined): void {
  element?.scrollIntoView({ behavior: "smooth", block: "start" });
}

// 조회 URL에 쿼리 하나를 덧붙인다. 값이 비어 있으면 그대로 두고, ?와 & 중 무엇을 붙일지 대신 판단한다.
function withQuery(path: string, key: string, value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return path;
  return `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(String(value))}`;
}

// Git·GitHub 조회 URL에 현재 채팅 작업공간 식별자를 보존한다.
// worktree를 직접 고른 경우에는 채팅 대신 그 경로를 기준으로 조회한다.
function chatPath(path: string, chatId?: number | null, worktree?: string): string {
  if (worktree) return withQuery(path, "worktree", worktree);
  return withQuery(path, "chatId", chatId);
}

// Git·GitHub 쓰기 요청 본문에 현재 채팅 작업공간 식별자를 합친다.
function chatBody(body: Json, chatId?: number | null): Json {
  return chatId ? { ...body, chatId } : body;
}

// Git 상태 코드 두 칸을 사람이 읽기 쉬운 짧은 라벨로 바꾼다.
function changeLabel(change: Json): string {
  const code = `${change.indexStatus || " "}${change.worktreeStatus || " "}`;
  if (code.includes("?")) return "새 파일";
  if (code.includes("D")) return "삭제";
  if (code.includes("R")) return "이름 변경";
  if (code.includes("A")) return "추가";
  if (code.includes("M")) return "수정";
  return code.trim() || "변경";
}

// 쿼리 문자열에 선택 파일 목록을 반복 파라미터로 넣는다.
function fileQuery(files: string[]): string {
  const params = new URLSearchParams();
  files.forEach((file) => params.append("file", file));
  return params.toString();
}

// 날짜 문자열을 짧은 한국어 표시용으로 줄인다.
function shortDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });
}

// GitHub 상태 문자열을 목록용 배지 라벨로 바꾼다.
function stateLabel(state: string): string {
  const labels: Record<string, string> = { OPEN: "열림", CLOSED: "닫힘", MERGED: "병합됨" };
  return labels[state] || state || "상태 없음";
}

// GitHub 작성자 이름을 안전하게 꺼낸다.
function authorName(item: Json): string {
  return item?.author?.login || item?.author?.name || "알 수 없음";
}

// 이슈·PR 본문을 GFM 마크다운으로 렌더링한다(표·체크박스 등). 링크는 페이지 이탈 없이 새 탭으로 연다.
function GithubBody({ body }: { body?: string }): React.ReactElement {
  if (!body) return <p className="muted">본문 없음</p>;
  return <div className="github-body markdown-body">
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>{body}</ReactMarkdown>
  </div>;
}

// GitHub 댓글 목록을 공통으로 렌더링한다.
function Comments({ comments }: { comments?: Json[] }): React.ReactElement {
  return <div className="github-comments">{comments?.length ? comments.map((comment: Json, index: number) => <article key={comment.id || index}>
    <b>{authorName(comment)}</b><span>{shortDate(comment.createdAt || comment.updatedAt || "")}</span><p>{comment.body || "내용 없음"}</p>
  </article>) : <p className="muted">댓글 없음</p>}</div>;
}

// 선택한 이슈의 상세와 댓글·닫기·다시 열기 액션을 제공한다.
function IssueDetail({ projectId, chatId, issue, refresh, onStartWork, detailRef }: { projectId: number; chatId?: number | null; issue: Json | null; refresh: () => Promise<void>; onStartWork?: (issue: Json) => void; detailRef?: React.Ref<HTMLElement> }): React.ReactElement {
  const [comment, setComment] = useState("");
  const [closeComment, setCloseComment] = useState("");
  const [reason, setReason] = useState("completed");
  // 예전엔 실패해도(예: 이미 닫힌 이슈) 아무 표시 없이 콘솔에만 조용히 남아 사용자가 알 방법이 없었다 —
  // "작업 중…" → 성공/실패 문구로 바뀌는 상태 표시와, 중복 클릭 방지용 busy를 추가했다.
  const [actionStatus, setActionStatus] = useState("");
  const [busy, setBusy] = useState(false);
  if (!issue) return <section className="github-detail empty"><p className="muted">이슈를 선택하세요.</p></section>;

  async function mutate(path: string, body: Json, pendingLabel: string, successLabel: string): Promise<boolean> {
    setBusy(true);
    setActionStatus(pendingLabel);
    try {
      await api(`/projects/${projectId}${path}`, { method: "POST", body: JSON.stringify(chatBody(body, chatId)) });
      setActionStatus(successLabel);
      await refresh();
      return true;
    } catch (error: any) {
      setActionStatus(error?.message || "작업에 실패했습니다.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  return <section className="github-detail" ref={detailRef}>
    <div className="github-detail-head"><div><span className={`state-badge ${issue.state?.toLowerCase?.() || ""}`}>{stateLabel(issue.state)}</span><h3>#{issue.number} {issue.title}</h3><small>{authorName(issue)} · {shortDate(issue.updatedAt || issue.createdAt || "")}</small></div><div className="github-detail-actions">
      {onStartWork && <button type="button" className="primary" onClick={() => onStartWork(issue)}>새 작업공간에서 시작</button>}
      <a href={issue.url} target="_blank" rel="noreferrer">GitHub에서 열기</a>
    </div></div>
    <GithubBody body={issue.body} />
    {actionStatus && <span className="session-action-status">{actionStatus}</span>}
    <div className="github-action-grid">
      <form onSubmit={(event) => { event.preventDefault(); if (comment.trim()) void mutate(`/github/issue/${issue.number}/comment`, { body: comment }, "댓글 등록 중…", "댓글을 등록했습니다.").then((ok) => { if (ok) setComment(""); }); }}>
        <strong>댓글</strong><textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="댓글 내용" /><button disabled={busy}>댓글 달기</button>
      </form>
      <form onSubmit={(event) => { event.preventDefault(); void mutate(issue.state === "OPEN" ? `/github/issue/${issue.number}/close` : `/github/issue/${issue.number}/reopen`, issue.state === "OPEN" ? { reason, comment: closeComment } : { comment: closeComment }, issue.state === "OPEN" ? "이슈 닫는 중…" : "이슈 여는 중…", issue.state === "OPEN" ? "이슈를 닫았습니다." : "이슈를 다시 열었습니다.").then((ok) => { if (ok) setCloseComment(""); }); }}>
        <strong>{issue.state === "OPEN" ? "닫기" : "다시 열기"}</strong>{issue.state === "OPEN" && <select value={reason} onChange={(event) => setReason(event.target.value)}><option value="completed">완료</option><option value="not planned">계획 없음</option></select>}<textarea value={closeComment} onChange={(event) => setCloseComment(event.target.value)} placeholder="선택 댓글" /><button className={issue.state === "OPEN" ? "danger" : ""} disabled={busy}>{busy ? "처리 중…" : issue.state === "OPEN" ? "이슈 닫기" : "이슈 다시 열기"}</button>
      </form>
    </div>
    <h4>댓글</h4><Comments comments={issue.comments} />
  </section>;
}

// 선택한 PR의 상세와 댓글·리뷰·닫기·다시 열기·병합 액션을 제공한다.
function PullRequestDetail({ projectId, chatId, pullRequest, refresh, diffMode, setDiffMode, detailRef }: { projectId: number; chatId?: number | null; pullRequest: Json | null; refresh: () => Promise<void>; diffMode: DiffMode; setDiffMode: (mode: DiffMode) => void; detailRef?: React.Ref<HTMLElement> }): React.ReactElement {
  const [comment, setComment] = useState("");
  const [reviewBody, setReviewBody] = useState("");
  const [reviewAction, setReviewAction] = useState("comment");
  const [closeComment, setCloseComment] = useState("");
  const [mergeMethod, setMergeMethod] = useState("squash");
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [diff, setDiff] = useState("");
  const [diffLoaded, setDiffLoaded] = useState(false);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const diffFileCount = useMemo(() => parseDiffFiles(diff).length, [diff]);
  // 예전엔 병합 실패(예: base와 충돌) 같은 오류가 콘솔에만 조용히 남고 화면엔 아무 표시가 없었다 —
  // "작업 중…" → 성공/실패 문구로 바뀌는 상태 표시와, 중복 클릭 방지용 busy를 추가했다.
  const [actionStatus, setActionStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function loadDiff(number: number): Promise<void> {
    setLoadingDiff(true);
    try {
      const data = await api(chatPath(`/projects/${projectId}/github/pr/${number}/diff`, chatId));
      setDiff(data.diff || "");
    } catch {
      setDiff("");
    } finally {
      setDiffLoaded(true);
      setLoadingDiff(false);
    }
  }

  // PR diff는 "diff 불러오기" 버튼을 눌러야만 가져오게 했었는데(파일 많은 PR은 무겁다는 우려),
  // 실측해보니 이 저장소 PR 중 가장 큰 것도 요청 자체는 ~1.8초(37,000줄)이고 병렬 처리 시 더 짧아
  // 로딩 표시만 명확히 해주면 자동 조회가 낫다고 판단해(2026-07-23, 실측 근거로 재논의 후 결정)
  // PR을 열면 바로 불러오는 방식으로 되돌렸다. 버튼을 못 찾겠다는 원래 피드백도 이걸로 같이 해소된다.
  useEffect(() => {
    setDiff("");
    setDiffLoaded(false);
    setActionStatus("");
    if (pullRequest?.number) void loadDiff(pullRequest.number);
  }, [pullRequest?.number]);

  if (!pullRequest) return <section className="github-detail empty"><p className="muted">PR을 선택하세요.</p></section>;

  async function mutate(path: string, body: Json, pendingLabel: string, successLabel: string): Promise<boolean> {
    setBusy(true);
    setActionStatus(pendingLabel);
    try {
      await api(`/projects/${projectId}${path}`, { method: "POST", body: JSON.stringify(chatBody(body, chatId)) });
      setComment("");
      setReviewBody("");
      setCloseComment("");
      setActionStatus(successLabel);
      await refresh();
      return true;
    } catch (error: any) {
      setActionStatus(error?.message || "작업에 실패했습니다.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  return <section className="github-detail" ref={detailRef}>
    <div className="github-detail-head"><div><span className={`state-badge ${pullRequest.state?.toLowerCase?.() || ""}`}>{stateLabel(pullRequest.state)}</span><h3>#{pullRequest.number} {pullRequest.title}</h3><small>{pullRequest.headRefName} → {pullRequest.baseRefName} · {authorName(pullRequest)} · {shortDate(pullRequest.updatedAt || pullRequest.createdAt || "")}</small></div><a href={pullRequest.url} target="_blank" rel="noreferrer">GitHub에서 열기</a></div>
    <GithubBody body={pullRequest.body} />
    {actionStatus && <span className="session-action-status">{actionStatus}</span>}
    <div className="github-action-grid">
      <form onSubmit={(event) => { event.preventDefault(); if (comment.trim()) void mutate(`/github/pr/${pullRequest.number}/comment`, { body: comment }, "댓글 등록 중…", "댓글을 등록했습니다."); }}>
        <strong>댓글</strong><textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="댓글 내용" /><button disabled={busy}>댓글 달기</button>
      </form>
      <form onSubmit={(event) => { event.preventDefault(); void mutate(`/github/pr/${pullRequest.number}/review`, { action: reviewAction, body: reviewBody }, "리뷰 제출 중…", "리뷰를 제출했습니다."); }}>
        <strong>리뷰</strong><select value={reviewAction} onChange={(event) => setReviewAction(event.target.value)}><option value="comment">코멘트</option><option value="approve">승인</option><option value="requestChanges">변경 요청</option></select><textarea value={reviewBody} onChange={(event) => setReviewBody(event.target.value)} placeholder="리뷰 내용" /><button disabled={busy}>리뷰 제출</button>
      </form>
      <form onSubmit={(event) => { event.preventDefault(); void mutate(pullRequest.state === "OPEN" ? `/github/pr/${pullRequest.number}/close` : `/github/pr/${pullRequest.number}/reopen`, { comment: closeComment }, pullRequest.state === "OPEN" ? "PR 닫는 중…" : "PR 여는 중…", pullRequest.state === "OPEN" ? "PR을 닫았습니다." : "PR을 다시 열었습니다."); }}>
        <strong>{pullRequest.state === "OPEN" ? "닫기" : "다시 열기"}</strong><textarea value={closeComment} onChange={(event) => setCloseComment(event.target.value)} placeholder="선택 댓글" /><button className={pullRequest.state === "OPEN" ? "danger" : ""} disabled={busy}>{pullRequest.state === "OPEN" ? "PR 닫기" : "PR 다시 열기"}</button>
      </form>
      <form onSubmit={(event) => { event.preventDefault(); if (window.confirm("이 PR을 병합할까요?")) void mutate(`/github/pr/${pullRequest.number}/merge`, { method: mergeMethod, deleteBranch, confirm: true }, "병합 중…", "PR을 병합했습니다."); }}>
        <strong>병합</strong><select value={mergeMethod} onChange={(event) => setMergeMethod(event.target.value)}><option value="squash">Squash</option><option value="merge">Merge commit</option><option value="rebase">Rebase</option></select><label className="inline-check"><input type="checkbox" checked={deleteBranch} onChange={(event) => setDeleteBranch(event.target.checked)} />브랜치 삭제</label><button className="primary" disabled={busy}>{busy ? "처리 중…" : "PR 병합"}</button>
      </form>
    </div>
    <section className="github-pr-diff">
      <div className="git-box-head"><h3>PR diff</h3><div className="git-box-head-actions">{diffLoaded && !!diffFileCount && <span>{diffFileCount}개 파일</span>}{loadingDiff && <span className="inline-busy"><span className="busy-dots"><i /><i /><i /></span>불러오는 중…</span>}<DiffModeToggle mode={diffMode} onChange={setDiffMode} /></div></div>
      {diffLoaded && (diffFileCount
        ? <DiffView diff={diff} mode={diffMode} defaultOpen={false} />
        : <p className="muted">diff 없음</p>)}
    </section>
    <h4>댓글</h4><Comments comments={pullRequest.comments} />
  </section>;
}

// GitHub 이슈·PR·Actions 목록과 상세 액션 탭을 렌더링한다.
function GitHubTab({ projectId, chatId, github, runsData, loadRuns, loading, loaded, load, loadMore, diffMode, setDiffMode, onStartWork }: { projectId: number; chatId?: number | null; github: Json | null; runsData: Json | null; loadRuns: () => Promise<void>; loading: boolean; loaded: boolean; load: () => Promise<void>; loadMore: (panel: keyof typeof GITHUB_PAGE) => void; diffMode: DiffMode; setDiffMode: (mode: DiffMode) => void; onStartWork?: (issue: Json) => void }): React.ReactElement {
  const [panel, setPanel] = useState<GitHubPanel>("issues");
  const [issueTitle, setIssueTitle] = useState("");
  const [issueBody, setIssueBody] = useState("");
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [prBase, setPrBase] = useState("main");
  const [runId, setRunId] = useState("");
  const [selectedIssue, setSelectedIssue] = useState<Json | null>(null);
  const [selectedPullRequest, setSelectedPullRequest] = useState<Json | null>(null);
  // 이슈·PR 생성과 workflow 재실행도 실패하면 콘솔에만 조용히 남았다 — 동일하게
  // "작업 중…" → 성공/실패 문구로 바뀌는 상태 표시와 중복 클릭 방지용 busy를 추가했다.
  const [actionStatus, setActionStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const issueDetailRef = useRef<HTMLElement | null>(null);
  const pullDetailRef = useRef<HTMLElement | null>(null);
  // 좁은 화면 전용 목록 접기 상태(넓은 화면에서는 CSS가 항상 펼친 2열로 되돌린다).
  const [listOpen, setListOpen] = useState(true);

  useEffect(() => { if (github?.repository?.defaultBranchRef?.name) setPrBase(github.repository.defaultBranchRef.name); }, [github?.repository?.defaultBranchRef?.name]);

  // 워크플로 조회는 셋 중 가장 느려서 목록과 함께 부르지 않는다 — Actions 탭을 실제로 열 때만 읽는다.
  useEffect(() => { if (panel === "actions") void loadRuns().catch(() => undefined); }, [panel]);

  // 좁은 화면에서 항목을 고르면 목록을 접고 상세로 이동한다. 접지 않고 스크롤만 하면 상세가
  // 문서의 마지막 요소라 화면 아래에 걸친다. 선택 시점에는 상세가 아직 렌더되지 않았으므로
  // 여기서는 접기와 "이동할 대상"만 예약하고, 실제 이동은 접힘이 반영된 뒤에 한다.
  const [revealTarget, setRevealTarget] = useState<GitHubPanel | null>(null);
  useEffect(() => { if (selectedIssue && isStackedLayout(1100)) { setListOpen(false); setRevealTarget("issues"); } }, [selectedIssue?.number]);
  useEffect(() => { if (selectedPullRequest && isStackedLayout(1100)) { setListOpen(false); setRevealTarget("pulls"); } }, [selectedPullRequest?.number]);

  // 목록이 접혀 레이아웃이 확정된 뒤에 이동한다(페인트 전에 실행되는 useLayoutEffect).
  useLayoutEffect(() => {
    if (!revealTarget || listOpen) return;
    scrollToDetail(revealTarget === "issues" ? issueDetailRef.current : pullDetailRef.current);
    setRevealTarget(null);
  }, [revealTarget, listOpen]);

  async function mutate(path: string, body: Json, pendingLabel: string, successLabel: string): Promise<boolean> {
    setBusy(true);
    setActionStatus(pendingLabel);
    try {
      await api(`/projects/${projectId}${path}`, { method: "POST", body: JSON.stringify(chatBody(body, chatId)) });
      setActionStatus(successLabel);
      await load();
      if (panel === "actions") await loadRuns();
      return true;
    } catch (error: any) {
      setActionStatus(error?.message || "작업에 실패했습니다.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function openIssue(number: number): Promise<void> {
    const data = await api(chatPath(`/projects/${projectId}/github/issue/${number}`, chatId));
    setSelectedIssue(data.issue);
    setPanel("issues");
  }

  // PR diff는 무거울 수 있어 여기서 같이 안 불러오고, PullRequestDetail 안에서 원할 때만 불러온다.
  async function openPullRequest(number: number): Promise<void> {
    const detail = await api(chatPath(`/projects/${projectId}/github/pr/${number}`, chatId));
    setSelectedPullRequest(detail.pullRequest);
    setPanel("pulls");
  }

  async function refreshIssueDetail(): Promise<void> {
    if (selectedIssue?.number) await openIssue(selectedIssue.number);
    await load();
  }

  async function refreshPullRequestDetail(): Promise<void> {
    if (selectedPullRequest?.number) await openPullRequest(selectedPullRequest.number);
    await load();
  }

  if (!loaded) return <section className="git-box"><LoadingState label="GitHub 정보 불러오는 중" /></section>;
  // 저장소 정보가 없는 응답까지 여기서 걸러 낸다. 아래 렌더는 `github.repository`를 바로 읽기 때문에,
  // 서버가 불완전한 응답을 주면 화면 전체가 사라진다(에러 경계가 없음) — 안내를 보여주는 편이 낫다.
  if (!github?.repository) return <section className="git-box"><p className="muted">gh 인증 또는 원격 저장소가 필요합니다.</p></section>;
  const issues: Json[] = github.issues || [];
  const pullRequests: Json[] = github.pullRequests || [];
  const runs: Json[] = runsData?.runs || [];

  return <div className="github-tab">
    <div className="github-repo"><a href={github.repository.url} target="_blank" rel="noreferrer">{github.repository.nameWithOwner}</a><span>{loading && <LoaderCircle className="spin" size={13} aria-label="GitHub 새로고침 중" />}이슈 {issues.length} · PR {pullRequests.length}{runsData ? ` · 워크플로 ${runs.length}` : ""}</span></div>
    {github.errors && Object.values(github.errors).some(Boolean) && <div className="github-errors">{Object.entries(github.errors).filter(([, message]) => message).map(([key, message]) => <p key={key}>{key}: {String(message)}</p>)}</div>}
    {actionStatus && <span className="session-action-status">{actionStatus}</span>}
    <div className="git-subtabs"><button className={panel === "issues" ? "active" : ""} onClick={() => setPanel("issues")}>이슈</button><button className={panel === "pulls" ? "active" : ""} onClick={() => setPanel("pulls")}>PR</button><button className={panel === "actions" ? "active" : ""} onClick={() => setPanel("actions")}>Actions</button></div>
    {panel === "issues" && <div className="github-split">
      <button type="button" className="github-list-toggle" aria-expanded={listOpen} onClick={() => setListOpen((current) => !current)}>
        <span>{listOpen ? "▾" : "▸"} 이슈 목록</span>
        <span className="github-list-summary">{selectedIssue ? `#${selectedIssue.number} 보는 중` : `${issues.length}개`}</span>
      </button>
      <aside className={`github-list${listOpen ? " open" : ""}`}><form className="github-create" onSubmit={(event) => { event.preventDefault(); if (issueTitle.trim()) void mutate("/github/issue", { title: issueTitle, body: issueBody }, "이슈 생성 중…", "이슈를 생성했습니다.").then((ok) => { if (ok) { setIssueTitle(""); setIssueBody(""); } }); }}><strong>이슈 생성</strong><input value={issueTitle} onChange={(event) => setIssueTitle(event.target.value)} placeholder="제목" /><textarea value={issueBody} onChange={(event) => setIssueBody(event.target.value)} placeholder="본문" /><button className="primary" disabled={busy}>생성</button></form>{issues.length ? issues.map((issue: Json) => <button key={issue.number} className={selectedIssue?.number === issue.number ? "active" : ""} onClick={() => void openIssue(issue.number)}><b>#{issue.number} {issue.title}</b><span>{stateLabel(issue.state)} · {authorName(issue)} · {shortDate(issue.updatedAt)}</span></button>) : <p className="resource-empty compact">이슈 기록 없음</p>}{github.hasMore?.issues && <button className="list-more" onClick={() => loadMore("issues")} disabled={loading}>{loading ? "불러오는 중…" : "이슈 더 보기"}</button>}</aside>
      <IssueDetail projectId={projectId} chatId={chatId} issue={selectedIssue} refresh={refreshIssueDetail} onStartWork={onStartWork} detailRef={issueDetailRef} />
    </div>}
    {panel === "pulls" && <div className="github-split">
      <button type="button" className="github-list-toggle" aria-expanded={listOpen} onClick={() => setListOpen((current) => !current)}>
        <span>{listOpen ? "▾" : "▸"} PR 목록</span>
        <span className="github-list-summary">{selectedPullRequest ? `#${selectedPullRequest.number} 보는 중` : `${pullRequests.length}개`}</span>
      </button>
      <aside className={`github-list${listOpen ? " open" : ""}`}><form className="github-create" onSubmit={(event) => { event.preventDefault(); if (prTitle.trim()) void mutate("/github/pr", { title: prTitle, body: prBody, base: prBase }, "PR 생성 중…", "PR을 생성했습니다.").then((ok) => { if (ok) { setPrTitle(""); setPrBody(""); } }); }}><strong>PR 생성</strong><input value={prTitle} onChange={(event) => setPrTitle(event.target.value)} placeholder="제목" /><input value={prBase} onChange={(event) => setPrBase(event.target.value)} placeholder="base 브랜치" /><textarea value={prBody} onChange={(event) => setPrBody(event.target.value)} placeholder="본문" /><button className="primary" disabled={busy}>생성</button></form>{pullRequests.length ? pullRequests.map((pr: Json) => <button key={pr.number} className={selectedPullRequest?.number === pr.number ? "active" : ""} onClick={() => void openPullRequest(pr.number)}><b>#{pr.number} {pr.title}</b><span>{stateLabel(pr.state)} · {pr.headRefName} → {pr.baseRefName} · {shortDate(pr.updatedAt)}</span></button>) : <p className="resource-empty compact">PR 기록 없음</p>}{github.hasMore?.pullRequests && <button className="list-more" onClick={() => loadMore("pulls")} disabled={loading}>{loading ? "불러오는 중…" : "PR 더 보기"}</button>}</aside>
      <PullRequestDetail projectId={projectId} chatId={chatId} pullRequest={selectedPullRequest} refresh={refreshPullRequestDetail} diffMode={diffMode} setDiffMode={setDiffMode} detailRef={pullDetailRef} />
    </div>}
    {panel === "actions" && <div className="github-actions-panel">
      <form className="github-create" onSubmit={(event) => { event.preventDefault(); const id = Number(runId); if (id && window.confirm("이 workflow를 재실행할까요?")) void mutate(`/github/run/${id}/rerun`, { confirm: true }, "재실행 요청 중…", "재실행을 요청했습니다.").then((ok) => { if (ok) setRunId(""); }); }}><strong>Workflow 재실행</strong><input value={runId} onChange={(event) => setRunId(event.target.value)} placeholder="run ID" /><button disabled={busy}>재실행</button></form>
      <div className="github-run-list">{runs.length ? runs.map((run: Json) => <article key={run.databaseId}><b>{run.name}</b><span>#{run.databaseId} · {run.status} · {run.conclusion || "진행 중"} · {shortDate(run.updatedAt)}</span><a href={run.url} target="_blank" rel="noreferrer">열기</a></article>) : <p className="resource-empty compact">워크플로 실행 기록 없음</p>}{runsData?.hasMore && <button className="list-more" onClick={() => loadMore("runs")} disabled={loading}>{loading ? "불러오는 중…" : "워크플로 더 보기"}</button>}</div>
    </div>}
  </div>;
}

// 로컬 Git 상태·파일별 diff와 GitHub 조회·쓰기 동작을 제공한다.
export function GitView({ project, user, chat, providers, refreshChats, onOpenProject, onOpenChat }: { project: Json | null; user: Json; chat: Json | null; providers?: Json[]; refreshChats: () => void | Promise<void>; onOpenProject: (project: Json) => void; onOpenChat?: (chat: Json) => void }): React.ReactElement {
  // 프로젝트가 선택돼 있으면 실제로 자주 보는 Diff를 기본으로 연다(저장소 목록은 프로젝트를 새로
  // 추가할 때만 필요해 매번 거쳐 가는 화면이 아니었다).
  const [tab, setTab] = useState<GitTab>(project ? "diff" : "repositories");
  const [diffMode, setDiffMode] = useState<DiffMode>(() => (localStorage.getItem("web_agent_manager_diff_mode") ?? localStorage.getItem("myagent_diff_mode")) === "split" ? "split" : "unified");
  const [git, setGit] = useState<Json>({});
  const [changes, setChanges] = useState<Json[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [diff, setDiff] = useState("");
  const [diffError, setDiffError] = useState("");
  const [github, setGithub] = useState<Json | null>(null);
  const [githubLoading, setGithubLoading] = useState(false);
  const [githubLoaded, setGithubLoaded] = useState(false);
  const githubRequest = useRef(0);
  const [commitMessage, setCommitMessage] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  // 좁은 화면 전용 사이드바 접기 상태(넓은 화면에서는 CSS가 항상 펼친 상태로 되돌린다).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Diff 화면이 조회할 작업공간. 비우면 선택 채팅(없으면 프로젝트 공유 checkout) 기준이다.
  const [workspaces, setWorkspaces] = useState<Json[]>([]);
  const [workspacePath, setWorkspacePath] = useState("");
  // 커밋 내역만 다른 브랜치 기준으로 볼 때 쓴다. 실제 checkout은 바꾸지 않는다.
  const [branches, setBranches] = useState<Json[]>([]);
  const [defaultBranch, setDefaultBranch] = useState("");
  const [commitRef, setCommitRef] = useState("");
  const [worktreeStatus, setWorktreeStatus] = useState("");
  // "더 보기"로 늘린 조회 개수. 커밋과 GitHub 각 탭이 따로 늘어난다.
  const [commitLimit, setCommitLimit] = useState(COMMIT_PAGE);
  const [githubLimits, setGithubLimits] = useState(GITHUB_PAGE);
  // 워크플로는 Actions 탭에서만 쓰는 별도 조회 결과다(목록과 함께 부르면 첫 진입이 그만큼 느려진다).
  const [githubRuns, setGithubRuns] = useState<Json | null>(null);
  const githubRunsRequest = useRef(0);
  const [selectedCommit, setSelectedCommit] = useState<Json | null>(null);
  const commitDetailRef = useRef<HTMLElement | null>(null);
  const [commitDiff, setCommitDiff] = useState("");
  const [commitDetail, setCommitDetail] = useState<Json | null>(null);
  const [commitLoading, setCommitLoading] = useState(false);
  const selectedSet = useMemo(() => new Set(selectedFiles), [selectedFiles]);
  // "선택한 채팅 기준" 같은 서술형 대신 실제 브랜치명을 보여주기 위해 상태 텍스트에서 뽑아둔다(실사용
  // 요청: 지금 어느 브랜치를 보고 있는지 드롭다운 문구만 보고는 알 수 없었다).
  const currentBranchName = useMemo(() => currentBranchFromStatus(git.status || ""), [git.status]);
  // 변경 파일 목록을 상위 폴더 하나(바로 위 디렉터리)로 묶어, 폴더 단위로 한 번에 선택·롤백할 수 있게 한다.
  // git status는 파일 단위로만 나오므로 폴더 자체를 골라 되돌린다는 건 "그 폴더 아래 변경 파일 전부"를 뜻한다.
  const changeGroups = useMemo(() => {
    const groups = new Map<string, Json[]>();
    for (const change of changes as Json[]) {
      const path = String(change.path);
      const slash = path.lastIndexOf("/");
      const key = slash === -1 ? "" : path.slice(0, slash);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(change);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [changes]);
  // 커밋 diff의 파일 목록은 파서가 만든 구조를 그대로 쓴다(원문 헤더를 다시 훑지 않는다).
  const commitFiles = useMemo(() => parseDiffFiles(commitDiff), [commitDiff]);
  useEffect(() => { localStorage.setItem("web_agent_manager_diff_mode", diffMode); }, [diffMode]);

  // GitHub 이슈·PR·Actions 목록만 다시 읽는다. 예전엔 프로젝트 진입 시 한 번만 불러오고 GitHub 탭을
  // 나갔다 들어와도 다시 읽지 않아, 그사이 GitHub에서 상태가 바뀌어도 새로고침 버튼을 직접 눌러야만
  // 반영됐다(실사용 피드백: "업데이트가 느린 것 같다", 2026-07-23) — GitHub 탭을 누를 때마다 자동으로
  // 다시 읽도록 바꿨다.
  async function loadGithub(force = false): Promise<void> {
    if (!project) return;
    const request = ++githubRequest.current;
    setGithubLoading(true);
    try {
      let path = withQuery(`/projects/${project.id}/github`, "refresh", force ? 1 : null);
      path = withQuery(withQuery(path, "issues", githubLimits.issues), "pulls", githubLimits.pulls);
      const data = await api(chatPath(path, chat?.id));
      if (githubRequest.current === request) {
        setGithub(data);
        setGithubLoaded(true);
      }
    } catch {
      if (githubRequest.current === request) {
        setGithub(null);
        setGithubLoaded(true);
      }
    } finally {
      if (githubRequest.current === request) setGithubLoading(false);
    }
  }

  // 로컬 저장소 상태(브랜치·커밋 목록·변경 파일)만 다시 읽는다.
  // 커밋 "더 보기"는 GitHub 목록까지 다시 읽을 이유가 없어 이쪽만 따로 부른다.
  async function loadGit(force = false): Promise<void> {
    if (!project) return;
    const refresh = force ? 1 : null;
    let gitPath = withQuery(`/projects/${project.id}/git`, "refresh", refresh);
    gitPath = withQuery(withQuery(gitPath, "commits", commitLimit), "ref", commitRef);
    const [gitData, changeData] = await Promise.all([
      api(chatPath(gitPath, chat?.id, workspacePath)),
      api(chatPath(withQuery(`/projects/${project.id}/git/changes`, "refresh", refresh), chat?.id, workspacePath)),
    ]);
    const nextChanges = changeData.changes || [];
    setGit(gitData);
    setChanges(nextChanges);
    setSelectedFiles((current) => current.filter((file) => nextChanges.some((change: Json) => change.path === file)));
  }

  // 저장소 상태와 GitHub 데이터를 동시에 다시 읽는다. force는 서버 캐시를 건너뛰고 실제 CLI를 기다린다.
  async function load(force = false): Promise<void> {
    await loadGit(force);
    void loadGithub(force);
  }

  // 프로젝트가 바뀌면 고를 수 있는 작업공간 목록을 다시 읽고 선택은 기본값(채팅 기준)으로 되돌린다.
  // 작업공간 목록·브랜치 목록과 함께 "기본(선택한 채팅)" 작업공간의 실제 현재 브랜치명을 읽어둔다.
  // git.status에서 뽑는 currentBranchName은 지금 보고 있는 대상(다른 worktree·브랜치를 골랐을 수 있음)
  // 기준이라, "선택한 채팅 기준으로 돌아가기" 옵션 자체의 이름표로는 이 별도 조회가 더 정확하다.
  async function loadWorkspaceMeta(): Promise<void> {
    if (!project) { setWorkspaces([]); setBranches([]); setDefaultBranch(""); return; }
    const [workspacesData, workspaceData] = await Promise.all([
      api(`/projects/${project.id}/git/workspaces`).catch(() => ({ workspaces: [] })),
      api(chatPath(`/projects/${project.id}/git/workspace`, chat?.id)).catch(() => ({})),
    ]);
    setWorkspaces(workspacesData.workspaces || []);
    setBranches(workspaceData.branches || []);
    setDefaultBranch(workspaceData.branch || "");
  }
  useEffect(() => {
    setWorkspacePath("");
    setCommitRef("");
    void loadWorkspaceMeta();
  }, [project?.id]);

  // 조회 대상이 바뀌면 "더 보기"로 늘려 둔 개수를 기본값으로 되돌린다. effect가 아니라 렌더 중에
  // 맞춰야, 새 대상을 옛 개수로 한 번 조회한 뒤 기본 개수로 다시 조회하는 낭비가 생기지 않는다.
  const scopeKey = `${project?.id ?? ""}|${chat?.id ?? ""}|${workspacePath}|${commitRef}`;
  const [loadedScope, setLoadedScope] = useState(scopeKey);
  if (loadedScope !== scopeKey) {
    setLoadedScope(scopeKey);
    setCommitLimit(COMMIT_PAGE);
    setGithubLimits(GITHUB_PAGE);
  }

  // 로컬 Git 상태는 조회 대상이나 커밋 표시 개수가 바뀔 때 다시 읽는다.
  useEffect(() => {
    void loadGit().catch(() => undefined);
  }, [project?.id, chat?.id, workspacePath, commitRef, commitLimit]);

  // 조회 대상이 바뀌면 GitHub 결과를 비운다. 표시 개수만 늘어난 경우에는 비우지 않아,
  // "더 보기"를 눌러도 보고 있던 목록이 사라졌다 다시 나타나지 않는다.
  useEffect(() => {
    githubRequest.current += 1;
    setGithub(null);
    setGithubLoaded(false);
    setGithubLoading(false);
    setGithubRuns(null);
  }, [project?.id, chat?.id, workspacePath]);

  useEffect(() => {
    void loadGithub().catch(() => undefined);
  }, [project?.id, chat?.id, workspacePath, githubLimits]);

  // 서버가 캐시해 둔 저장소·GitHub 상태를 1분마다 다시 읽어 새로고침 버튼 없이도 최신 상태를 유지한다.
  // 화면이 보이지 않는 동안에는 건너뛰고, 다시 보일 때 한 번 즉시 읽어 대기 없이 따라잡는다.
  // workspacePath·commitRef를 의존성에서 빠뜨리면 이 effect가 다시 실행되지 않아 setInterval 콜백이
  // 작업공간 선택 전 시점의 load()를 계속 들고 있는다 — 그래서 1분 뒤 예전 작업공간 데이터로 되돌아가
  // 방금 고른 작업공간 선택이 "안 먹는" 것처럼 보였다(실사용 보고로 확인).
  useEffect(() => {
    if (!project || tab === "repositories") return;
    const refresh = (): void => { if (document.visibilityState === "visible") { void load().catch(() => undefined); void loadWorkspaceMeta().catch(() => undefined); } };
    const timer = window.setInterval(refresh, 60_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [project?.id, chat?.id, tab, workspacePath, commitRef]);

  // 로컬 diff는 사용자가 파일을 명시적으로 골랐을 때만 조회하고, 늦은 이전 응답은 무시한다.
  useEffect(() => {
    setDiff("");
    setDiffError("");
    if (!project || !selectedFiles.length) return;
    let active = true;
    const query = fileQuery(selectedFiles);
    const path = `/projects/${project.id}/git/diff?${query}`;
    void api(chatPath(path, chat?.id, workspacePath))
      .then((data) => { if (active) setDiff(data.diff || ""); })
      .catch((error) => { if (active) setDiffError(error instanceof Error ? error.message : "diff를 불러오지 못했습니다."); });
    return () => { active = false; };
  }, [project?.id, chat?.id, workspacePath, selectedFiles.join("\n")]);

  // Actions 탭 전용 워크플로 조회. `gh run list`가 가장 느려서 목록 조회와 분리해 두었다.
  async function loadGithubRuns(force = false): Promise<void> {
    if (!project) return;
    const request = ++githubRunsRequest.current;
    try {
      const path = withQuery(withQuery(`/projects/${project.id}/github/runs`, "refresh", force ? 1 : null), "runs", githubLimits.runs);
      const data = await api(chatPath(path, chat?.id));
      if (githubRunsRequest.current === request) setGithubRuns(data);
    } catch {
      if (githubRunsRequest.current === request) setGithubRuns({ runs: [], hasMore: false });
    }
  }

  // 한 번 읽은 뒤 "더 보기"로 개수가 늘면 다시 읽는다. 아직 안 읽었으면 Actions 탭을 열 때 읽는다.
  useEffect(() => {
    if (githubRuns) void loadGithubRuns().catch(() => undefined);
  }, [githubLimits.runs]);

  // GitHub 탭에서 "더 보기"를 누른 목록의 조회 개수만 한 묶음 늘린다. 나머지 탭은 그대로 둔다.
  function loadMoreGithub(panel: keyof typeof GITHUB_PAGE): void {
    setGithubLimits((current) => ({ ...current, [panel]: current[panel] + GITHUB_PAGE[panel] }));
  }

  // 쓰기 작업을 실행하고 성공 시 저장소 상태를 다시 읽는다.
  async function mutate(path: string, body: Json): Promise<void> {
    if (!project) return;
    try { await api(`/projects/${project.id}${path}`, { method: "POST", body: JSON.stringify(chatBody(body, chat?.id)) }); await load(); }
    catch (error) { window.alert(error instanceof Error ? error.message : "작업 실패"); }
  }

  // 파일 선택 체크박스 상태를 변경한다.
  function toggleFile(file: string): void {
    setSelectedFiles((current) => current.includes(file) ? current.filter((item) => item !== file) : [...current, file]);
  }

  // 폴더 묶음 헤더 체크박스: 그 폴더 안 파일이 전부 선택돼 있으면 전체 해제, 아니면 전체 선택한다.
  function toggleGroup(items: Json[]): void {
    const allSelected = items.every((item) => selectedSet.has(item.path));
    setSelectedFiles((current) => {
      const set = new Set(current);
      for (const item of items) { if (allSelected) set.delete(item.path); else set.add(item.path); }
      return [...set];
    });
  }

  // 현재 선택한 파일 목록을 한 번에 커밋한다.
  async function commitSelected(): Promise<void> {
    if (!selectedFiles.length || !commitMessage.trim()) return;
    await mutate("/git/commit", { files: selectedFiles, message: commitMessage.trim() });
    setCommitMessage("");
  }

  // 선택한 파일·폴더의 커밋되지 않은 변경을 되돌린다. 커밋 손실과 같은 급으로 되돌릴 수 없어 먼저 확인받는다.
  async function discardSelected(): Promise<void> {
    if (!selectedFiles.length) return;
    if (!window.confirm(`선택한 파일 ${selectedFiles.length}개의 변경을 되돌릴까요?\n\n커밋되지 않은 내용은 복구할 수 없습니다.`)) return;
    await mutate("/git/discard", { files: selectedFiles });
    setSelectedFiles([]);
  }

  // 최근 커밋을 클릭했을 때 해당 커밋의 패치와 메타 정보를 읽는다.
  // 좁은 화면에서 커밋을 고르면 접이식 목록을 접고 상세로 이동해 바로 읽게 한다.
  // 이슈·PR과 같은 이유로 접기와 이동을 나눈다 — 접히는 도중에 스크롤하면 상세 중간에서 멈춘다.
  const [revealCommit, setRevealCommit] = useState(false);
  function revealCommitDetail(): void {
    if (!isStackedLayout(700)) return;
    setSidebarOpen(false);
    setRevealCommit(true);
  }

  // 이슈·PR과 달리 커밋 상세는 본문·diff를 나중에 받아 높이가 크게 늘어난다. 로딩 중에 이동하면
  // 그때는 문서가 짧아 상세가 화면 위까지 올라오지 못하므로, 내용이 채워진 뒤에 옮긴다.
  useLayoutEffect(() => {
    if (!revealCommit || sidebarOpen || commitLoading) return;
    scrollToDetail(commitDetailRef.current);
    setRevealCommit(false);
  }, [revealCommit, sidebarOpen, commitLoading]);

  async function openCommit(commit: Json): Promise<void> {
    if (!project) return;
    setSelectedCommit(commit);
    revealCommitDetail();
    setCommitDiff("");
    setCommitDetail(null);
    setCommitLoading(true);
    try {
      const data = await api(chatPath(`/projects/${project.id}/git/commit/${commit.hash}`, chat?.id, workspacePath));
      setCommitDiff(data.diff || "");
      setCommitDetail(data.commit || null);
    } catch (error) {
      setCommitDetail({ subject: error instanceof Error ? error.message : "커밋을 불러오지 못했습니다.", failed: true });
    } finally {
      setCommitLoading(false);
    }
  }

  // 보고 있는 작업공간에 같은 폴더를 쓰는 채팅을 하나 더 만든다(Claude·Codex를 나란히 두기 위함).
  async function addChatToWorkspace(provider: string): Promise<void> {
    if (!project) return;
    const selected = workspaces.find((item: Json) => item.path === workspacePath);
    const branch = String(selected?.branch ?? "");
    if (!branch) { setWorktreeStatus("브랜치가 없는 작업공간에는 채팅을 추가할 수 없습니다."); return; }
    setWorktreeStatus(`${provider} 채팅을 추가하는 중…`);
    try {
      const data = await api("/chats/worktree", {
        method: "POST",
        body: JSON.stringify({ projectId: project.id, provider, branch, create: false, title: `${branch} 작업` }),
      });
      setWorktreeStatus("");
      await refreshChats();
      if (data.chat && onOpenChat) onOpenChat(data.chat);
    } catch (error: any) {
      setWorktreeStatus(error?.message || "채팅을 추가하지 못했습니다.");
    }
  }

  // 작업이 끝난 worktree를 정리한다. 미커밋 변경이 남아 있으면 한 번 더 확인받는다.
  async function removeWorkspace(): Promise<void> {
    if (!project || !workspacePath) return;
    const selected = workspaces.find((item: Json) => item.path === workspacePath);
    if (!window.confirm(`작업공간을 정리할까요?\n\n${selected?.branch ?? ""}\n${workspacePath}\n\n연결된 채팅은 남고 작업공간 연결만 끊깁니다.`)) return;
    setWorktreeStatus("작업공간을 정리하는 중…");
    const remove = async (force: boolean): Promise<void> => {
      await api(`/projects/${project.id}/git/worktree?path=${encodeURIComponent(workspacePath)}${force ? "&force=1" : ""}`, { method: "DELETE" });
    };
    try {
      await remove(false);
    } catch (error: any) {
      const message = error?.message || "정리하지 못했습니다.";
      // 미커밋 변경이 남아 있으면 커밋할 기회를 준 뒤, 그래도 지울지 다시 확인한다.
      if (!/미커밋|커밋되지|정리한 뒤/.test(message) || !window.confirm(`${message}\n\n커밋하지 않은 변경을 버리고 그대로 삭제할까요?`)) {
        setWorktreeStatus(message);
        return;
      }
      try {
        await remove(true);
      } catch (forced: any) {
        setWorktreeStatus(forced?.message || "정리하지 못했습니다.");
        return;
      }
    }
    setWorktreeStatus("작업공간을 정리했습니다.");
    setWorkspacePath("");
    setSelectedCommit(null);
    setCommitDiff("");
    await refreshChats();
    void api(`/projects/${project.id}/git/workspaces`).then((data) => setWorkspaces(data.workspaces || [])).catch(() => undefined);
  }

  // 이슈로 작업을 시작할 때 GitHub가 연결해 둔 브랜치가 있으면 그대로 쓰고, 없으면 제안 이름을 채운다.
  async function startIssueWork(issue: Json): Promise<void> {
    if (!project) return;
    setWorktreeStatus("이슈의 연결 브랜치를 확인하는 중…");
    let suggested = `issue-${issue.number}`;
    let linked = false;
    try {
      const data = await api(chatPath(`/projects/${project.id}/github/issue/${issue.number}/branches`, chat?.id, workspacePath));
      suggested = data.suggested || suggested;
      linked = !!(data.linked || []).length;
    } catch {
      // 연결 브랜치를 못 읽어도 제안 이름으로 계속 진행한다.
    }
    setWorktreeStatus("");
    await startWorktreeWork({ branch: suggested, create: !linked, title: `#${issue.number} ${issue.title ?? ""}`.trim() });
  }

  // 이슈·브랜치로 새 worktree와 전용 채팅을 만들어 그 작업으로 바로 넘어간다.
  // 현재 채팅이 다른 worktree에 묶여 있어도 새 채팅을 만들기 때문에 영향을 주지 않는다.
  async function startWorktreeWork(options: { branch: string; create: boolean; title: string }): Promise<void> {
    if (!project) return;
    const provider = String(providers?.[0]?.id ?? "claude");
    const branch = window.prompt("새 작업공간에서 사용할 브랜치 이름", options.branch)?.trim();
    if (!branch) return;
    setWorktreeStatus("작업공간을 만드는 중…");
    try {
      const data = await api("/chats/worktree", {
        method: "POST",
        body: JSON.stringify({ projectId: project.id, provider, branch, create: options.create && branch === options.branch ? options.create : undefined, title: options.title }),
      });
      setWorktreeStatus("");
      await refreshChats();
      if (data.chat && onOpenChat) onOpenChat(data.chat);
    } catch (error: any) {
      setWorktreeStatus(error?.message || "작업공간을 만들지 못했습니다.");
    }
  }

  // hunk 사이 감춰진 원본 줄을 펼칠 때 쓴다. 커밋 상세는 그 커밋 시점, 미커밋 diff는 작업 트리 기준이다.
  function expandLinesFor(revision?: string): ExpandLines {
    return async (path: string) => {
      if (!project) return [];
      const query = new URLSearchParams({ path });
      if (revision) query.set("rev", revision);
      const data = await api(chatPath(`/projects/${project.id}/git/blob?${query}`, chat?.id, workspacePath));
      return data.lines || [];
    };
  }

  // 사용자가 새로고침을 눌렀을 때는 캐시를 무시하고 실제 저장소·GitHub 상태를 다시 읽는다.
  async function refreshCurrent(): Promise<void> {
    setRefreshing(true);
    try { await load(true); }
    catch { /* 조회 실패는 아래 상태 표시와 각 영역의 오류 문구로 드러난다. */ }
    finally { setRefreshing(false); }
  }

  const filesToShow = selectedFiles;
  // 조회 대상을 기본값이 아닌 작업공간·브랜치로 바꾼 동안에는 쓰기를 막는다. 커밋·push는 채팅 기준
  // 경로로 나가기 때문에, 보고 있는 변경과 실제로 커밋되는 경로가 어긋날 수 있다.
  const viewingOnly = !!workspacePath || !!commitRef;

  return <section className="panel git-page"><div className="section-head"><div><span className="eyebrow">버전 관리</span><h2>GitHub</h2></div>{tab !== "repositories" && <div className="git-refresh-controls">{git.cachedAt && <span className="git-cached-at">{shortDate(git.cachedAt)} 기준 · 1분마다 자동 갱신</span>}<button onClick={() => void refreshCurrent()} disabled={!project || refreshing}>{refreshing ? "갱신 중..." : "새로고침"}</button></div>}</div>
    <div className="git-tabs"><button className={tab === "diff" ? "active" : ""} disabled={!project} onClick={() => setTab("diff")}>로컬</button><button className={tab === "github" ? "active" : ""} disabled={!project} onClick={() => { setTab("github"); void loadGithub(); }}>깃허브</button><button className={tab === "repositories" ? "active" : ""} onClick={() => setTab("repositories")}>저장소</button></div>
    {tab === "repositories" && <div className="github-repositories-tab"><GithubRepositoryList onProject={onOpenProject} /></div>}
    {/* GitHub 탭은 변경 내역을 확인하는 화면이라 실제 브랜치를 바꾸지 않는다. 전환 UI는 채팅 화면에만
        두고 여기서는 현재 브랜치 표시만 한다 — 그래야 터미널이 실행 중이어도 조회가 막히지 않는다. */}
    {tab !== "repositories" && project && <GitBranchControl projectId={project.id} chat={chat} canManage={false} onChanged={async () => { await refreshChats(); await refreshCurrent(); }} />}
    {tab === "diff" && <div className="git-layout">
      {/* 모바일에서는 사이드바가 화면을 다 차지해 정작 diff가 한참 아래로 밀렸다 — 좁은 화면에서만
          접이식으로 바꿔 diff부터 보이게 하고, 넓은 화면은 예전처럼 항상 펼친 좌측 열로 둔다. */}
      <button type="button" className="git-sidebar-toggle" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen((current) => !current)}>
        <span>{sidebarOpen ? "▾" : "▸"} 변경 파일 · 커밋</span>
        <span className="git-sidebar-summary">{changes.length}개 변경{selectedFiles.length ? ` · ${selectedFiles.length}개 선택` : ""}</span>
      </button>
      <aside className={`git-sidebar${sidebarOpen ? " open" : ""}`}>
        <section className="git-box"><h3>변경 파일</h3>
          <div className="git-file-actions"><button onClick={() => setSelectedFiles(changes.map((change) => change.path))}>전체 선택</button><button onClick={() => setSelectedFiles([])}>선택 해제</button></div>
          {changes.length ? <div className="git-file-list">{changeGroups.map(([folder, items]) => <div className="git-file-group" key={folder || "(root)"}>
            {folder && <label className={`git-file-group-head${items.every((item) => selectedSet.has(item.path)) ? " active" : ""}`}>
              <input type="checkbox" checked={items.every((item) => selectedSet.has(item.path))} ref={(el) => { if (el) el.indeterminate = !items.every((item) => selectedSet.has(item.path)) && items.some((item) => selectedSet.has(item.path)); }} onChange={() => toggleGroup(items)} />
              <span>{folder}/</span><b>{items.length}개</b>
            </label>}
            {items.map((change) => <label key={change.path} className={`git-file-row${folder ? " nested" : ""}${selectedSet.has(change.path) ? " active" : ""}`}><input type="checkbox" checked={selectedSet.has(change.path)} onChange={() => toggleFile(change.path)} /><span>{folder ? change.path.slice(folder.length + 1) : change.path}</span><b>{changeLabel(change)}</b></label>)}
          </div>)}</div> : <p className="muted">변경 파일 없음</p>}
          <div className="commit-form"><textarea value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder="커밋 메시지" disabled={viewingOnly} /><button className="primary" disabled={viewingOnly || !selectedFiles.length || !commitMessage.trim()} onClick={() => void commitSelected()}>선택 파일 커밋</button><button className="danger" disabled={viewingOnly || !selectedFiles.length} onClick={() => void discardSelected()}>선택 파일 롤백</button>{viewingOnly && <p className="muted view-only-note">다른 작업공간·브랜치를 보는 중에는 커밋·롤백할 수 없습니다. 하려면 "기본값으로"를 누르세요.</p>}</div>
        </section>
        <section className="git-box"><h3>최근 커밋</h3>
          <div className="commit-list">{(git.commits || []).map((commit: Json) => <button key={commit.hash} className={selectedCommit?.hash === commit.hash ? "active" : ""} onClick={() => void openCommit(commit)}><code>{commit.hash}</code><span>{commit.subject}</span><small>{commit.author} · {shortDate(commit.date)}</small></button>)}</div>
          {!(git.commits || []).length && <p className="muted">커밋 없음</p>}
          {git.hasMoreCommits && <button className="list-more" onClick={() => setCommitLimit((current) => current + COMMIT_PAGE)}>커밋 더 보기</button>}
        </section>
      </aside>
      <main className="git-main">
        {/* 조회 대상 작업공간 선택. 다른 폴더로 빼둔 worktree의 커밋 내역·미커밋 변경도 여기서 본다. */}
        <div className="workspace-picker">
          <label htmlFor="git-workspace-select">작업공간</label>
          <select id="git-workspace-select" value={workspacePath} onChange={(event) => { setWorkspacePath(event.target.value); setSelectedCommit(null); setCommitDiff(""); setSelectedFiles([]); }}>
            <option value="">{defaultBranch || "감지 중…"}{chat?.id ? ` (#${chat.id})` : " (프로젝트 공유)"}</option>
            {workspaces.map((item: Json) => <option key={item.path} value={item.path}>
              {item.main ? "공유 checkout" : item.appManaged ? "채팅 전용" : "외부 worktree"} · {item.branch || "(분리된 HEAD)"} · {item.path}
            </option>)}
          </select>
          <label htmlFor="git-ref-select">커밋 내역</label>
          <select id="git-ref-select" value={commitRef} onChange={(event) => { setCommitRef(event.target.value); setSelectedCommit(null); setCommitDiff(""); }}>
            <option value="">{currentBranchName || "현재"} 브랜치</option>
            {branches.map((item: Json) => <option key={`${item.remote ? "r" : "l"}:${item.name}`} value={item.name}>{item.name}{item.remote ? " (원격)" : ""}</option>)}
          </select>
          {(workspacePath || commitRef) && <button type="button" onClick={() => { setWorkspacePath(""); setCommitRef(""); setSelectedCommit(null); setCommitDiff(""); }}>기본값으로</button>}
          {user?.role === "admin" && <button type="button" onClick={() => void startWorktreeWork({ branch: commitRef || "feature/new-work", create: !commitRef, title: commitRef ? `${commitRef} 작업` : "새 작업" })}>
            새 작업공간
          </button>}
          {user?.role === "admin" && workspacePath && !workspaces.find((item: Json) => item.path === workspacePath)?.main && <>
            {(providers ?? []).map((item: Json) => <button key={item.id} type="button" onClick={() => void addChatToWorkspace(String(item.id))}>+ {item.label || item.id}</button>)}
            <button type="button" className="danger" onClick={() => void removeWorkspace()}>정리</button>
          </>}
          <span className="workspace-picker-note">확인 전용 · 실제 브랜치는 바뀌지 않습니다</span>
          {worktreeStatus && <span className="inline-status">{worktreeStatus}</span>}
        </div>
        <section className="git-box git-status"><div className="git-box-head"><h3>상태</h3><button disabled={viewingOnly} title={viewingOnly ? "다른 작업공간·브랜치를 보는 중에는 push할 수 없습니다." : undefined} onClick={() => { if (window.confirm("현재 브랜치를 origin으로 push할까요?")) void mutate("/git/push", { confirm: true }); }}>Push</button></div><pre>{git.status || "저장소를 선택하세요."}</pre></section>
        <section className="git-box"><div className="git-box-head"><h3>{selectedFiles.length ? `선택 파일 diff (${selectedFiles.length})` : "파일 diff"}</h3><div className="git-box-head-actions"><span>{filesToShow.length ? `${filesToShow.length}개 파일` : "파일을 선택하세요"}</span><DiffModeToggle mode={diffMode} onChange={setDiffMode} /></div></div>
          {!selectedFiles.length ? <p className="muted">변경 파일을 선택하면 해당 파일의 diff를 표시합니다.</p> : diffError ? <p className="error-text">{diffError}</p> : diff ? <DiffView diff={diff} mode={diffMode} expandLines={expandLinesFor()} /> : <p className="muted">선택한 파일에 표시할 변경사항이 없습니다.</p>}
        </section>
        {selectedCommit && <section className="git-box commit-detail" ref={commitDetailRef}>
          <div className="git-box-head"><h3>커밋 상세</h3><div className="git-box-head-actions"><DiffModeToggle mode={diffMode} onChange={setDiffMode} /><button onClick={() => { setSelectedCommit(null); setCommitDiff(""); setCommitDetail(null); }}>닫기</button></div></div>
          <div className="commit-meta-card">
            <p className="commit-title"><code>{selectedCommit.hash}</code> {commitDetail?.subject || selectedCommit.subject}</p>
            <p className="commit-byline">{commitDetail?.author || selectedCommit.author}{commitDetail?.date ? ` · ${shortDate(commitDetail.date)}` : ""}</p>
            {commitDetail?.body && <pre className="commit-body">{commitDetail.body}</pre>}
          </div>
          {commitLoading && <LoadingState label="커밋 diff를 불러오는 중입니다." />}
          {!commitLoading && !!commitFiles.length && <>
            <div className="commit-file-list">
              <div className="commit-file-list-head">변경된 파일 {commitFiles.length}개</div>
              {commitFiles.map((file) => <a key={file.path} className="commit-file-item" href={`#commit-file-${encodeURIComponent(file.path)}`}>
                <span className={`diff-status diff-status-${file.status}`}>{statusLabel(file.status)}</span>
                <span className="commit-file-path">{file.path}</span>
                <span className="diff-stat">{file.additions > 0 && <b className="diff-stat-add">+{file.additions}</b>}{file.deletions > 0 && <b className="diff-stat-del">−{file.deletions}</b>}</span>
              </a>)}
            </div>
            <div className="diff-file-list">{commitFiles.map((file) => <div key={file.path} id={`commit-file-${encodeURIComponent(file.path)}`}>
              <DiffFileCard file={file} mode={diffMode} expandLines={expandLinesFor(selectedCommit.hash)} />
            </div>)}</div>
          </>}
          {!commitLoading && !commitFiles.length && <p className="muted">{commitDetail?.failed ? commitDetail.subject : "이 커밋에는 표시할 변경 내용이 없습니다."}</p>}
        </section>}
      </main>
    </div>}
    {tab === "github" && project && <GitHubTab projectId={project.id} chatId={chat?.id} github={github} runsData={githubRuns} loadRuns={loadGithubRuns} loading={githubLoading} loaded={githubLoaded} load={load} loadMore={loadMoreGithub} diffMode={diffMode} setDiffMode={setDiffMode} onStartWork={startIssueWork} />}
  </section>;
}
