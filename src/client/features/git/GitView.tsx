import React, { useEffect, useMemo, useRef, useState } from "react";
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

// Git·GitHub 조회 URL에 현재 채팅 작업공간 식별자를 보존한다.
// worktree를 직접 고른 경우에는 채팅 대신 그 경로를 기준으로 조회한다.
function chatPath(path: string, chatId?: number | null, worktree?: string): string {
  const suffix = worktree ? `worktree=${encodeURIComponent(worktree)}` : chatId ? `chatId=${chatId}` : "";
  if (!suffix) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${suffix}`;
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
function IssueDetail({ projectId, chatId, issue, refresh, onStartWork }: { projectId: number; chatId?: number | null; issue: Json | null; refresh: () => Promise<void>; onStartWork?: (issue: Json) => void }): React.ReactElement {
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

  return <section className="github-detail">
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
function PullRequestDetail({ projectId, chatId, pullRequest, refresh, diffMode, setDiffMode }: { projectId: number; chatId?: number | null; pullRequest: Json | null; refresh: () => Promise<void>; diffMode: DiffMode; setDiffMode: (mode: DiffMode) => void }): React.ReactElement {
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

  return <section className="github-detail">
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
function GitHubTab({ projectId, chatId, github, loading, loaded, load, diffMode, setDiffMode, onStartWork }: { projectId: number; chatId?: number | null; github: Json | null; loading: boolean; loaded: boolean; load: () => Promise<void>; diffMode: DiffMode; setDiffMode: (mode: DiffMode) => void; onStartWork?: (issue: Json) => void }): React.ReactElement {
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

  useEffect(() => { if (github?.repository?.defaultBranchRef?.name) setPrBase(github.repository.defaultBranchRef.name); }, [github?.repository?.defaultBranchRef?.name]);

  async function mutate(path: string, body: Json, pendingLabel: string, successLabel: string): Promise<boolean> {
    setBusy(true);
    setActionStatus(pendingLabel);
    try {
      await api(`/projects/${projectId}${path}`, { method: "POST", body: JSON.stringify(chatBody(body, chatId)) });
      setActionStatus(successLabel);
      await load();
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
  if (!github) return <section className="git-box"><p className="muted">gh 인증 또는 원격 저장소가 필요합니다.</p></section>;

  return <div className="github-tab">
    <div className="github-repo"><a href={github.repository.url} target="_blank" rel="noreferrer">{github.repository.nameWithOwner}</a><span>{loading && <LoaderCircle className="spin" size={13} aria-label="GitHub 새로고침 중" />}이슈 {github.issues.length} · PR {github.pullRequests.length} · 워크플로 {github.runs.length}</span></div>
    {github.errors && Object.values(github.errors).some(Boolean) && <div className="github-errors">{Object.entries(github.errors).filter(([, message]) => message).map(([key, message]) => <p key={key}>{key}: {String(message)}</p>)}</div>}
    {actionStatus && <span className="session-action-status">{actionStatus}</span>}
    <div className="git-subtabs"><button className={panel === "issues" ? "active" : ""} onClick={() => setPanel("issues")}>이슈</button><button className={panel === "pulls" ? "active" : ""} onClick={() => setPanel("pulls")}>PR</button><button className={panel === "actions" ? "active" : ""} onClick={() => setPanel("actions")}>Actions</button></div>
    {panel === "issues" && <div className="github-split">
      <aside className="github-list"><form className="github-create" onSubmit={(event) => { event.preventDefault(); if (issueTitle.trim()) void mutate("/github/issue", { title: issueTitle, body: issueBody }, "이슈 생성 중…", "이슈를 생성했습니다.").then((ok) => { if (ok) { setIssueTitle(""); setIssueBody(""); } }); }}><strong>이슈 생성</strong><input value={issueTitle} onChange={(event) => setIssueTitle(event.target.value)} placeholder="제목" /><textarea value={issueBody} onChange={(event) => setIssueBody(event.target.value)} placeholder="본문" /><button className="primary" disabled={busy}>생성</button></form>{github.issues.length ? github.issues.map((issue: Json) => <button key={issue.number} className={selectedIssue?.number === issue.number ? "active" : ""} onClick={() => void openIssue(issue.number)}><b>#{issue.number} {issue.title}</b><span>{stateLabel(issue.state)} · {authorName(issue)} · {shortDate(issue.updatedAt)}</span></button>) : <p className="resource-empty compact">이슈 기록 없음</p>}</aside>
      <IssueDetail projectId={projectId} chatId={chatId} issue={selectedIssue} refresh={refreshIssueDetail} onStartWork={onStartWork} />
    </div>}
    {panel === "pulls" && <div className="github-split">
      <aside className="github-list"><form className="github-create" onSubmit={(event) => { event.preventDefault(); if (prTitle.trim()) void mutate("/github/pr", { title: prTitle, body: prBody, base: prBase }, "PR 생성 중…", "PR을 생성했습니다.").then((ok) => { if (ok) { setPrTitle(""); setPrBody(""); } }); }}><strong>PR 생성</strong><input value={prTitle} onChange={(event) => setPrTitle(event.target.value)} placeholder="제목" /><input value={prBase} onChange={(event) => setPrBase(event.target.value)} placeholder="base 브랜치" /><textarea value={prBody} onChange={(event) => setPrBody(event.target.value)} placeholder="본문" /><button className="primary" disabled={busy}>생성</button></form>{github.pullRequests.length ? github.pullRequests.map((pr: Json) => <button key={pr.number} className={selectedPullRequest?.number === pr.number ? "active" : ""} onClick={() => void openPullRequest(pr.number)}><b>#{pr.number} {pr.title}</b><span>{stateLabel(pr.state)} · {pr.headRefName} → {pr.baseRefName} · {shortDate(pr.updatedAt)}</span></button>) : <p className="resource-empty compact">PR 기록 없음</p>}</aside>
      <PullRequestDetail projectId={projectId} chatId={chatId} pullRequest={selectedPullRequest} refresh={refreshPullRequestDetail} diffMode={diffMode} setDiffMode={setDiffMode} />
    </div>}
    {panel === "actions" && <div className="github-actions-panel">
      <form className="github-create" onSubmit={(event) => { event.preventDefault(); const id = Number(runId); if (id && window.confirm("이 workflow를 재실행할까요?")) void mutate(`/github/run/${id}/rerun`, { confirm: true }, "재실행 요청 중…", "재실행을 요청했습니다.").then((ok) => { if (ok) setRunId(""); }); }}><strong>Workflow 재실행</strong><input value={runId} onChange={(event) => setRunId(event.target.value)} placeholder="run ID" /><button disabled={busy}>재실행</button></form>
      <div className="github-run-list">{github.runs.length ? github.runs.map((run: Json) => <article key={run.databaseId}><b>{run.name}</b><span>#{run.databaseId} · {run.status} · {run.conclusion || "진행 중"} · {shortDate(run.updatedAt)}</span><a href={run.url} target="_blank" rel="noreferrer">열기</a></article>) : <p className="resource-empty compact">워크플로 실행 기록 없음</p>}</div>
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
  const [commitRef, setCommitRef] = useState("");
  const [worktreeStatus, setWorktreeStatus] = useState("");
  const [selectedCommit, setSelectedCommit] = useState<Json | null>(null);
  const [commitDiff, setCommitDiff] = useState("");
  const [commitDetail, setCommitDetail] = useState<Json | null>(null);
  const [commitLoading, setCommitLoading] = useState(false);
  const selectedSet = useMemo(() => new Set(selectedFiles), [selectedFiles]);
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
      const data = await api(chatPath(`/projects/${project.id}/github${force ? "?refresh=1" : ""}`, chat?.id));
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

  // 저장소 상태와 GitHub 데이터를 동시에 다시 읽는다. force는 서버 캐시를 건너뛰고 실제 CLI를 기다린다.
  async function load(force = false): Promise<void> {
    if (!project) return;
    const suffix = force ? "?refresh=1" : "";
    const [gitData, changeData] = await Promise.all([
      api(chatPath(`/projects/${project.id}/git${suffix}${commitRef ? `${suffix ? "&" : "?"}ref=${encodeURIComponent(commitRef)}` : ""}`, chat?.id, workspacePath)),
      api(chatPath(`/projects/${project.id}/git/changes${suffix}`, chat?.id, workspacePath)),
    ]);
    const nextChanges = changeData.changes || [];
    setGit(gitData);
    setChanges(nextChanges);
    setSelectedFiles((current) => current.filter((file) => nextChanges.some((change: Json) => change.path === file)));
    void loadGithub(force);
  }

  // 프로젝트가 바뀌면 고를 수 있는 작업공간 목록을 다시 읽고 선택은 기본값(채팅 기준)으로 되돌린다.
  useEffect(() => {
    setWorkspacePath("");
    setCommitRef("");
    if (!project) { setWorkspaces([]); setBranches([]); return; }
    let active = true;
    void api(`/projects/${project.id}/git/workspaces`)
      .then((data) => { if (active) setWorkspaces(data.workspaces || []); })
      .catch(() => { if (active) setWorkspaces([]); });
    void api(chatPath(`/projects/${project.id}/git/workspace`, chat?.id))
      .then((data) => { if (active) setBranches(data.branches || []); })
      .catch(() => { if (active) setBranches([]); });
    return () => { active = false; };
  }, [project?.id]);

  useEffect(() => {
    githubRequest.current += 1;
    setGithub(null);
    setGithubLoaded(false);
    setGithubLoading(false);
    void load().catch(() => undefined);
  }, [project?.id, chat?.id, workspacePath, commitRef]);

  // 서버가 캐시해 둔 저장소·GitHub 상태를 1분마다 다시 읽어 새로고침 버튼 없이도 최신 상태를 유지한다.
  // 화면이 보이지 않는 동안에는 건너뛰고, 다시 보일 때 한 번 즉시 읽어 대기 없이 따라잡는다.
  useEffect(() => {
    if (!project || tab === "repositories") return;
    const refresh = (): void => { if (document.visibilityState === "visible") void load().catch(() => undefined); };
    const timer = window.setInterval(refresh, 60_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [project?.id, chat?.id, tab]);

  useEffect(() => {
    if (!project) return;
    const query = fileQuery(selectedFiles);
    const path = `/projects/${project.id}/git/diff${query ? `?${query}` : ""}`;
    void api(chatPath(path, chat?.id, workspacePath)).then((data) => setDiff(data.diff || "")).catch(() => setDiff(""));
  }, [project?.id, chat?.id, workspacePath, selectedFiles.join("\n")]);

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

  // 현재 선택한 파일 목록을 한 번에 커밋한다.
  async function commitSelected(): Promise<void> {
    if (!selectedFiles.length || !commitMessage.trim()) return;
    await mutate("/git/commit", { files: selectedFiles, message: commitMessage.trim() });
    setCommitMessage("");
  }

  // 최근 커밋을 클릭했을 때 해당 커밋의 패치와 메타 정보를 읽는다.
  async function openCommit(commit: Json): Promise<void> {
    if (!project) return;
    setSelectedCommit(commit);
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

  const filesToShow = selectedFiles.length ? selectedFiles : changes.map((change) => change.path);
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
          <div className="git-file-actions"><button onClick={() => setSelectedFiles(changes.map((change) => change.path))}>전체 선택</button><button onClick={() => setSelectedFiles([])}>전체 diff</button></div>
          {changes.length ? <div className="git-file-list">{changes.map((change) => <label key={change.path} className={selectedSet.has(change.path) ? "active" : ""}><input type="checkbox" checked={selectedSet.has(change.path)} onChange={() => toggleFile(change.path)} /><span>{change.path}</span><b>{changeLabel(change)}</b></label>)}</div> : <p className="muted">변경 파일 없음</p>}
          <div className="commit-form"><textarea value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder="커밋 메시지" disabled={viewingOnly} /><button className="primary" disabled={viewingOnly || !selectedFiles.length || !commitMessage.trim()} onClick={() => void commitSelected()}>선택 파일 커밋</button>{viewingOnly && <p className="muted view-only-note">다른 작업공간·브랜치를 보는 중에는 커밋할 수 없습니다. 커밋하려면 "기본값으로"를 누르세요.</p>}</div>
        </section>
        <section className="git-box"><h3>최근 커밋</h3>
          <div className="commit-list">{(git.commits || []).map((commit: Json) => <button key={commit.hash} className={selectedCommit?.hash === commit.hash ? "active" : ""} onClick={() => void openCommit(commit)}><code>{commit.hash}</code><span>{commit.subject}</span><small>{commit.author} · {shortDate(commit.date)}</small></button>)}</div>
          {!(git.commits || []).length && <p className="muted">커밋 없음</p>}
        </section>
      </aside>
      <main className="git-main">
        {/* 조회 대상 작업공간 선택. 다른 폴더로 빼둔 worktree의 커밋 내역·미커밋 변경도 여기서 본다. */}
        <div className="workspace-picker">
          <label htmlFor="git-workspace-select">작업공간</label>
          <select id="git-workspace-select" value={workspacePath} onChange={(event) => { setWorkspacePath(event.target.value); setSelectedCommit(null); setCommitDiff(""); setSelectedFiles([]); }}>
            <option value="">선택한 채팅 기준{chat?.id ? ` (#${chat.id})` : " (프로젝트 공유)"}</option>
            {workspaces.map((item: Json) => <option key={item.path} value={item.path}>
              {item.main ? "공유 checkout" : item.appManaged ? "채팅 전용" : "외부 worktree"} · {item.branch || "(분리된 HEAD)"} · {item.path}
            </option>)}
          </select>
          <label htmlFor="git-ref-select">커밋 내역</label>
          <select id="git-ref-select" value={commitRef} onChange={(event) => { setCommitRef(event.target.value); setSelectedCommit(null); setCommitDiff(""); }}>
            <option value="">현재 작업공간 브랜치</option>
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
        <section className="git-box"><div className="git-box-head"><h3>{selectedFiles.length ? `선택 파일 diff (${selectedFiles.length})` : "전체 diff"}</h3><div className="git-box-head-actions"><span>{filesToShow.length ? `${filesToShow.length}개 파일` : "변경 없음"}</span><DiffModeToggle mode={diffMode} onChange={setDiffMode} /></div></div>
          {diff ? <DiffView diff={diff} mode={diffMode} expandLines={expandLinesFor()} /> : <p className="muted">변경사항 없음</p>}
        </section>
        {selectedCommit && <section className="git-box commit-detail">
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
    {tab === "github" && project && <GitHubTab projectId={project.id} chatId={chat?.id} github={github} loading={githubLoading} loaded={githubLoaded} load={load} diffMode={diffMode} setDiffMode={setDiffMode} onStartWork={startIssueWork} />}
  </section>;
}
