import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { LoaderCircle } from "lucide-react";
import { api } from "../../api";
import { LoadingState } from "../../components/LoadingState";
import { GithubRepositoryList } from "../../components/GithubRepositoryList";
import { DiffModeToggle, DiffView, type DiffMode } from "../../lib/diff-view";
import type { Json } from "../../types";

type GitTab = "repositories" | "diff" | "github";
type GitHubPanel = "issues" | "pulls" | "actions";
type DiffSection = { path: string; diff: string };

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

// 통합 diff 문자열을 diff --git 헤더 기준으로 파일별 블록 목록으로 나눈다.
function splitDiffSections(diff: string): DiffSection[] {
  const sections = diff.split(/(?=^diff --git )/m).filter(Boolean);
  return sections.flatMap((section) => {
    const match = section.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    const path = match?.[2];
    return path ? [{ path, diff: section.trimEnd() }] : [];
  });
}

// 파일별 diff를 기존 선택 파일 순서로 찾기 쉽게 경로 맵으로 바꾼다.
function splitDiffByFile(diff: string): Record<string, string> {
  return Object.fromEntries(splitDiffSections(diff).map((section) => [section.path, section.diff]));
}

// git show 출력에서 첫 파일 diff 앞의 커밋 메타데이터와 stat 영역을 분리한다.
function diffPreamble(diff: string): string {
  const index = diff.search(/^diff --git /m);
  return index > 0 ? diff.slice(0, index).trimEnd() : "";
}

// 대용량 PR은 사용자가 펼친 파일만 실제 줄 DOM으로 만들어 초기 렌더링 비용을 제한한다.
function LazyDiffSection({ section, mode }: { section: DiffSection; mode: DiffMode }): React.ReactElement {
  const [open, setOpen] = useState(false);
  return <details className="file-diff" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{section.path}</summary>
    {open && <DiffView diff={section.diff} mode={mode} />}
  </details>;
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
function IssueDetail({ projectId, issue, refresh }: { projectId: number; issue: Json | null; refresh: () => Promise<void> }): React.ReactElement {
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
      await api(`/projects/${projectId}${path}`, { method: "POST", body: JSON.stringify(body) });
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
    <div className="github-detail-head"><div><span className={`state-badge ${issue.state?.toLowerCase?.() || ""}`}>{stateLabel(issue.state)}</span><h3>#{issue.number} {issue.title}</h3><small>{authorName(issue)} · {shortDate(issue.updatedAt || issue.createdAt || "")}</small></div><a href={issue.url} target="_blank" rel="noreferrer">GitHub에서 열기</a></div>
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
function PullRequestDetail({ projectId, pullRequest, refresh, diffMode, setDiffMode }: { projectId: number; pullRequest: Json | null; refresh: () => Promise<void>; diffMode: DiffMode; setDiffMode: (mode: DiffMode) => void }): React.ReactElement {
  const [comment, setComment] = useState("");
  const [reviewBody, setReviewBody] = useState("");
  const [reviewAction, setReviewAction] = useState("comment");
  const [closeComment, setCloseComment] = useState("");
  const [mergeMethod, setMergeMethod] = useState("squash");
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [diff, setDiff] = useState("");
  const [diffLoaded, setDiffLoaded] = useState(false);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const diffSections = useMemo(() => splitDiffSections(diff), [diff]);
  // 예전엔 병합 실패(예: base와 충돌) 같은 오류가 콘솔에만 조용히 남고 화면엔 아무 표시가 없었다 —
  // "작업 중…" → 성공/실패 문구로 바뀌는 상태 표시와, 중복 클릭 방지용 busy를 추가했다.
  const [actionStatus, setActionStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function loadDiff(number: number): Promise<void> {
    setLoadingDiff(true);
    try {
      const data = await api(`/projects/${projectId}/github/pr/${number}/diff`);
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
      await api(`/projects/${projectId}${path}`, { method: "POST", body: JSON.stringify(body) });
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
      <div className="git-box-head"><h3>PR diff</h3><div className="git-box-head-actions">{diffLoaded && !!diffSections.length && <span>{diffSections.length}개 파일</span>}{loadingDiff && <span className="inline-busy"><span className="busy-dots"><i /><i /><i /></span>불러오는 중…</span>}<DiffModeToggle mode={diffMode} onChange={setDiffMode} /></div></div>
      {diffLoaded && (diffSections.length
        ? <div className="file-diff-stack">{diffSections.map((section) => <LazyDiffSection key={`${pullRequest.number}:${section.path}`} section={section} mode={diffMode} />)}</div>
        : <p className="muted">diff 없음</p>)}
    </section>
    <h4>댓글</h4><Comments comments={pullRequest.comments} />
  </section>;
}

// GitHub 이슈·PR·Actions 목록과 상세 액션 탭을 렌더링한다.
function GitHubTab({ projectId, github, loading, loaded, load, diffMode, setDiffMode }: { projectId: number; github: Json | null; loading: boolean; loaded: boolean; load: () => Promise<void>; diffMode: DiffMode; setDiffMode: (mode: DiffMode) => void }): React.ReactElement {
  const [panel, setPanel] = useState<GitHubPanel>("issues");
  const [issueTitle, setIssueTitle] = useState("");
  const [issueBody, setIssueBody] = useState("");
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [prBase, setPrBase] = useState("main");
  const [branch, setBranch] = useState("");
  const [runId, setRunId] = useState("");
  const [selectedIssue, setSelectedIssue] = useState<Json | null>(null);
  const [selectedPullRequest, setSelectedPullRequest] = useState<Json | null>(null);
  // 이슈·PR 생성, 브랜치 생성, workflow 재실행도 실패하면 콘솔에만 조용히 남았다 — 동일하게
  // "작업 중…" → 성공/실패 문구로 바뀌는 상태 표시와 중복 클릭 방지용 busy를 추가했다.
  const [actionStatus, setActionStatus] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (github?.repository?.defaultBranchRef?.name) setPrBase(github.repository.defaultBranchRef.name); }, [github?.repository?.defaultBranchRef?.name]);

  async function mutate(path: string, body: Json, pendingLabel: string, successLabel: string): Promise<boolean> {
    setBusy(true);
    setActionStatus(pendingLabel);
    try {
      await api(`/projects/${projectId}${path}`, { method: "POST", body: JSON.stringify(body) });
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
    const data = await api(`/projects/${projectId}/github/issue/${number}`);
    setSelectedIssue(data.issue);
    setPanel("issues");
  }

  // PR diff는 무거울 수 있어 여기서 같이 안 불러오고, PullRequestDetail 안에서 원할 때만 불러온다.
  async function openPullRequest(number: number): Promise<void> {
    const detail = await api(`/projects/${projectId}/github/pr/${number}`);
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
      <IssueDetail projectId={projectId} issue={selectedIssue} refresh={refreshIssueDetail} />
    </div>}
    {panel === "pulls" && <div className="github-split">
      <aside className="github-list"><form className="github-create" onSubmit={(event) => { event.preventDefault(); if (prTitle.trim()) void mutate("/github/pr", { title: prTitle, body: prBody, base: prBase }, "PR 생성 중…", "PR을 생성했습니다.").then((ok) => { if (ok) { setPrTitle(""); setPrBody(""); } }); }}><strong>PR 생성</strong><input value={prTitle} onChange={(event) => setPrTitle(event.target.value)} placeholder="제목" /><input value={prBase} onChange={(event) => setPrBase(event.target.value)} placeholder="base 브랜치" /><textarea value={prBody} onChange={(event) => setPrBody(event.target.value)} placeholder="본문" /><button className="primary" disabled={busy}>생성</button></form>{github.pullRequests.length ? github.pullRequests.map((pr: Json) => <button key={pr.number} className={selectedPullRequest?.number === pr.number ? "active" : ""} onClick={() => void openPullRequest(pr.number)}><b>#{pr.number} {pr.title}</b><span>{stateLabel(pr.state)} · {pr.headRefName} → {pr.baseRefName} · {shortDate(pr.updatedAt)}</span></button>) : <p className="resource-empty compact">PR 기록 없음</p>}</aside>
      <PullRequestDetail projectId={projectId} pullRequest={selectedPullRequest} refresh={refreshPullRequestDetail} diffMode={diffMode} setDiffMode={setDiffMode} />
    </div>}
    {panel === "actions" && <div className="github-actions-panel">
      <form className="github-create" onSubmit={(event) => { event.preventDefault(); if (branch.trim()) void mutate("/git/branch", { branch, create: true }, "브랜치 생성 중…", "브랜치를 만들었습니다.").then((ok) => { if (ok) setBranch(""); }); }}><strong>브랜치 생성</strong><input value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="feature/new-work" /><button disabled={busy}>생성 후 전환</button></form>
      <form className="github-create" onSubmit={(event) => { event.preventDefault(); const id = Number(runId); if (id && window.confirm("이 workflow를 재실행할까요?")) void mutate(`/github/run/${id}/rerun`, { confirm: true }, "재실행 요청 중…", "재실행을 요청했습니다.").then((ok) => { if (ok) setRunId(""); }); }}><strong>Workflow 재실행</strong><input value={runId} onChange={(event) => setRunId(event.target.value)} placeholder="run ID" /><button disabled={busy}>재실행</button></form>
      <div className="github-run-list">{github.runs.length ? github.runs.map((run: Json) => <article key={run.databaseId}><b>{run.name}</b><span>#{run.databaseId} · {run.status} · {run.conclusion || "진행 중"} · {shortDate(run.updatedAt)}</span><a href={run.url} target="_blank" rel="noreferrer">열기</a></article>) : <p className="resource-empty compact">워크플로 실행 기록 없음</p>}</div>
    </div>}
  </div>;
}

// 로컬 Git 상태·파일별 diff와 GitHub 조회·쓰기 동작을 제공한다.
export function GitView({ project, onOpenProject }: { project: Json | null; onOpenProject: (project: Json) => void }): React.ReactElement {
  const [tab, setTab] = useState<GitTab>("repositories");
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
  const [selectedCommit, setSelectedCommit] = useState<Json | null>(null);
  const [commitDiff, setCommitDiff] = useState("");
  const selectedSet = useMemo(() => new Set(selectedFiles), [selectedFiles]);
  const diffByFile = useMemo(() => splitDiffByFile(diff), [diff]);
  const commitDiffSections = useMemo(() => splitDiffSections(commitDiff), [commitDiff]);
  const commitMeta = useMemo(() => diffPreamble(commitDiff), [commitDiff]);
  useEffect(() => { localStorage.setItem("web_agent_manager_diff_mode", diffMode); }, [diffMode]);

  // GitHub 이슈·PR·Actions 목록만 다시 읽는다. 예전엔 프로젝트 진입 시 한 번만 불러오고 GitHub 탭을
  // 나갔다 들어와도 다시 읽지 않아, 그사이 GitHub에서 상태가 바뀌어도 새로고침 버튼을 직접 눌러야만
  // 반영됐다(실사용 피드백: "업데이트가 느린 것 같다", 2026-07-23) — GitHub 탭을 누를 때마다 자동으로
  // 다시 읽도록 바꿨다.
  async function loadGithub(): Promise<void> {
    if (!project) return;
    const request = ++githubRequest.current;
    setGithubLoading(true);
    try {
      const data = await api(`/projects/${project.id}/github`);
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

  // 저장소 상태와 GitHub 데이터를 동시에 다시 읽는다.
  async function load(): Promise<void> {
    if (!project) return;
    const [gitData, changeData] = await Promise.all([api(`/projects/${project.id}/git`), api(`/projects/${project.id}/git/changes`)]);
    const nextChanges = changeData.changes || [];
    setGit(gitData);
    setChanges(nextChanges);
    setSelectedFiles((current) => current.filter((file) => nextChanges.some((change: Json) => change.path === file)));
    void loadGithub();
  }

  useEffect(() => {
    githubRequest.current += 1;
    setGithub(null);
    setGithubLoaded(false);
    setGithubLoading(false);
    void load();
  }, [project?.id]);

  useEffect(() => {
    if (!project) return;
    const query = fileQuery(selectedFiles);
    void api(`/projects/${project.id}/git/diff${query ? `?${query}` : ""}`).then((data) => setDiff(data.diff || "")).catch(() => setDiff(""));
  }, [project?.id, selectedFiles.join("\n")]);

  // 쓰기 작업을 실행하고 성공 시 저장소 상태를 다시 읽는다.
  async function mutate(path: string, body: Json): Promise<void> {
    if (!project) return;
    try { await api(`/projects/${project.id}${path}`, { method: "POST", body: JSON.stringify(body) }); await load(); }
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
    const data = await api(`/projects/${project.id}/git/commit/${commit.hash}`);
    setCommitDiff(data.diff || "");
  }

  const filesToShow = selectedFiles.length ? selectedFiles : changes.map((change) => change.path);

  return <section className="panel git-page"><div className="section-head"><div><span className="eyebrow">버전 관리</span><h2>GitHub</h2></div>{tab !== "repositories" && <button onClick={load} disabled={!project}>새로고침</button>}</div>
    <div className="git-tabs"><button className={tab === "repositories" ? "active" : ""} onClick={() => setTab("repositories")}>저장소</button><button className={tab === "diff" ? "active" : ""} disabled={!project} onClick={() => setTab("diff")}>Diff</button><button className={tab === "github" ? "active" : ""} disabled={!project} onClick={() => { setTab("github"); void loadGithub(); }}>현재 저장소</button></div>
    {tab === "repositories" && <div className="github-repositories-tab"><GithubRepositoryList onProject={onOpenProject} /></div>}
    {tab === "diff" && <div className="git-layout">
      <aside className="git-sidebar">
        <section className="git-box"><h3>변경 파일</h3>
          <div className="git-file-actions"><button onClick={() => setSelectedFiles(changes.map((change) => change.path))}>전체 선택</button><button onClick={() => setSelectedFiles([])}>전체 diff</button></div>
          {changes.length ? <div className="git-file-list">{changes.map((change) => <label key={change.path} className={selectedSet.has(change.path) ? "active" : ""}><input type="checkbox" checked={selectedSet.has(change.path)} onChange={() => toggleFile(change.path)} /><span>{change.path}</span><b>{changeLabel(change)}</b></label>)}</div> : <p className="muted">변경 파일 없음</p>}
          <div className="commit-form"><textarea value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder="커밋 메시지" /><button className="primary" disabled={!selectedFiles.length || !commitMessage.trim()} onClick={() => void commitSelected()}>선택 파일 커밋</button></div>
        </section>
        <section className="git-box"><h3>최근 커밋</h3>
          <div className="commit-list">{(git.commits || []).map((commit: Json) => <button key={commit.hash} className={selectedCommit?.hash === commit.hash ? "active" : ""} onClick={() => void openCommit(commit)}><code>{commit.hash}</code><span>{commit.subject}</span><small>{commit.author} · {shortDate(commit.date)}</small></button>)}</div>
        </section>
      </aside>
      <main className="git-main">
        <section className="git-box git-status"><div className="git-box-head"><h3>상태</h3><button onClick={() => { if (window.confirm("현재 브랜치를 origin으로 push할까요?")) void mutate("/git/push", { confirm: true }); }}>Push</button></div><pre>{git.status || "저장소를 선택하세요."}</pre></section>
        <section className="git-box"><div className="git-box-head"><h3>{selectedFiles.length ? `선택 파일 diff (${selectedFiles.length})` : "전체 diff"}</h3><div className="git-box-head-actions"><span>{filesToShow.length ? `${filesToShow.length}개 파일` : "변경 없음"}</span><DiffModeToggle mode={diffMode} onChange={setDiffMode} /></div></div>
          {diff ? <div className="file-diff-stack">{filesToShow.map((file) => <details key={file} className="file-diff" open><summary>{file}</summary>{diffByFile[file] ? <DiffView diff={diffByFile[file]} mode={diffMode} /> : <p className="muted">표시할 diff가 없습니다.</p>}</details>)}</div> : <p className="muted">변경사항 없음</p>}
        </section>
        {selectedCommit && <section className="git-box"><div className="git-box-head"><h3>커밋 상세</h3><div className="git-box-head-actions"><DiffModeToggle mode={diffMode} onChange={setDiffMode} /><button onClick={() => { setSelectedCommit(null); setCommitDiff(""); }}>닫기</button></div></div><p className="commit-title"><code>{selectedCommit.hash}</code> {selectedCommit.subject}</p>{commitDiff ? <>{commitMeta && <pre className="commit-meta">{commitMeta}</pre>}{commitDiffSections.length ? <div className="file-diff-stack">{commitDiffSections.map((section) => <details key={section.path} className="file-diff" open><summary>{section.path}</summary><DiffView diff={section.diff} mode={diffMode} /></details>)}</div> : <DiffView diff={commitDiff} mode={diffMode} />}</> : <p className="muted">커밋 diff를 불러오는 중입니다.</p>}</section>}
      </main>
    </div>}
    {tab === "github" && project && <GitHubTab projectId={project.id} github={github} loading={githubLoading} loaded={githubLoaded} load={load} diffMode={diffMode} setDiffMode={setDiffMode} />}
  </section>;
}
