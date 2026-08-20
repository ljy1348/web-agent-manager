import React, { useEffect, useMemo, useState } from "react";
import { ChevronDown, GitBranch, Link2, Plus, X } from "lucide-react";
import { api } from "../api";
import type { Json } from "../types";

interface GitBranchControlProps {
  projectId: number;
  chat: Json | null;
  canManage: boolean;
  variant?: "bar" | "inline";
  onChanged?: () => void | Promise<void>;
}

// 선택 채팅의 브랜치·worktree 상태 조회와 전환 UI를 제공한다.
export function GitBranchControl({ projectId, chat, canManage, variant = "bar", onChanged }: GitBranchControlProps): React.ReactElement | null {
  const [workspace, setWorkspace] = useState<Json | null>(null);
  const [branch, setBranch] = useState("");
  const [mode, setMode] = useState<"shared" | "worktree">("shared");
  const [newBranch, setNewBranch] = useState("");
  const [externalPath, setExternalPath] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const query = chat?.id ? `?chatId=${chat.id}` : "";
  const unassignedWorktrees = useMemo(() => (workspace?.worktrees || []).filter((item: Json) => !item.main && !item.assignedChatId), [workspace]);

  // 서버에서 실제 checkout 상태를 다시 읽어 선택 컨트롤과 맞춘다.
  async function load(): Promise<void> {
    setWorkspace(null);
    try {
      const data = await api(`/projects/${projectId}/git/workspace${query}`);
      if (!data || typeof data.path !== "string" || !Array.isArray(data.branches)) {
        setWorkspace(null);
        setError("");
        return;
      }
      setWorkspace(data);
      setBranch(data.branch || data.branches?.[0]?.name || "");
      setMode(data.mode || "shared");
      setError("");
    } catch (loadError: any) {
      setWorkspace(null);
      setError(loadError?.message || "Git 작업공간을 조회하지 못했습니다.");
    }
  }

  useEffect(() => { setEditing(false); void load(); }, [projectId, chat?.id]);
  // 채팅 터미널 안에서 AI가 직접 git checkout -b 등으로 브랜치를 바꾸면 이 앱의 브랜치 전환 API를
  // 거치지 않아 이 위젯은 그 사실을 알 방법이 없다(실사용 보고: 채팅에서 새 브랜치로 전환해도 GitHub
  // 탭 배지·diff가 예전 브랜치에 계속 머묾). 짧은 주기로 다시 읽어 자연히 따라잡되, 지금 메뉴를
  // 펼쳐 고르는 중이거나 전환 요청이 진행 중이면 화면이 발밑에서 바뀌지 않도록 건너뛴다.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!editing && !busy && document.visibilityState === "visible") void load();
    }, 20_000);
    return () => window.clearInterval(timer);
  }, [projectId, chat?.id, editing, busy]);

  // 기존 또는 새 브랜치를 선택한 공유·전용 작업공간에 적용한다.
  async function switchBranch(target: string, create: boolean): Promise<void> {
    if (!target.trim()) return;
    setBusy(true);
    try {
      const data = await api(`/projects/${projectId}/git/branch`, {
        method: "POST",
        body: JSON.stringify({ chatId: chat?.id || null, branch: target.trim(), create, mode }),
      });
      setWorkspace(data);
      setBranch(data.branch || target.trim());
      setMode(data.mode || mode);
      setNewBranch("");
      setEditing(false);
      setError("");
      await onChanged?.();
    } catch (switchError: any) {
      setError(switchError?.message || "브랜치를 전환하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  // Git이 발견한 외부 worktree를 선택 채팅에 명시적으로 연결한다.
  async function attachWorktree(): Promise<void> {
    if (!chat?.id || !externalPath) return;
    setBusy(true);
    try {
      const data = await api(`/projects/${projectId}/git/worktree`, {
        method: "POST",
        body: JSON.stringify({ chatId: chat.id, path: externalPath }),
      });
      setWorkspace(data);
      setBranch(data.branch || "");
      setMode(data.mode || "worktree");
      setExternalPath("");
      setEditing(false);
      setError("");
      await onChanged?.();
    } catch (attachError: any) {
      setError(attachError?.message || "worktree를 연결하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  if (!workspace) return null;
  const summary = <>
      <GitBranch size={16} aria-hidden="true" />
      <code>{workspace.branch || "detached HEAD"}</code>
      <span className="git-workspace-badge">{workspace.mode === "worktree" ? "전용" : "공유"}</span>
      {canManage && <ChevronDown className={editing ? "open" : ""} size={14} aria-hidden="true" />}
    </>;
  return <section className={`git-branch-control ${variant}`} aria-label="Git 브랜치 작업공간">
    {canManage
      ? <button type="button" className="git-branch-trigger" title={workspace.path} aria-label="Git 작업공간 변경" aria-expanded={editing} onClick={() => setEditing((value) => !value)}>{summary}</button>
      : <div className="git-branch-trigger readonly" title={workspace.path}>{summary}</div>}
    {canManage && editing && <div className="git-branch-editor">
      <div className="git-branch-editor-head"><strong>Git 작업공간</strong><code>{workspace.path}</code><button type="button" className="icon-button" title="작업공간 메뉴 닫기" aria-label="작업공간 메뉴 닫기" onClick={() => setEditing(false)}><X size={14} /></button></div>
      <div className="git-branch-switch">
        <select aria-label="Git 브랜치 선택" value={branch} disabled={busy || !workspace.canSwitch} onChange={(event) => setBranch(event.target.value)}>
          {(workspace.branches || []).map((item: Json) => <option key={`${item.remote ? "remote" : "local"}:${item.name}`} value={item.name}>{item.name}{item.remote ? " (원격)" : ""}</option>)}
        </select>
        <div className="segmented git-workspace-mode" aria-label="Git 작업공간 방식">
          <button type="button" className={mode === "shared" ? "active" : ""} disabled={busy || !workspace.canSwitch} onClick={() => setMode("shared")}>공유</button>
          <button type="button" className={mode === "worktree" ? "active" : ""} disabled={busy || !workspace.canSwitch || !chat} onClick={() => setMode("worktree")}>전용</button>
        </div>
        <button type="button" disabled={busy || !workspace.canSwitch || !branch} onClick={() => void switchBranch(branch, false)}>{busy ? "처리 중" : "전환"}</button>
      </div>
      <div className="git-branch-create-row">
        <form className="git-new-branch" onSubmit={(event) => { event.preventDefault(); void switchBranch(newBranch, true); }}>
          <input aria-label="새 Git 브랜치 이름" value={newBranch} disabled={busy || !workspace.canSwitch} onChange={(event) => setNewBranch(event.target.value)} placeholder="새 브랜치" />
          <button type="submit" className="icon-button" title="새 브랜치 생성 후 전환" aria-label="새 브랜치 생성 후 전환" disabled={busy || !workspace.canSwitch || !newBranch.trim()}><Plus size={15} /></button>
        </form>
        {!!chat && !!unassignedWorktrees.length && <div className="git-external-worktree">
          <select aria-label="외부 worktree 선택" value={externalPath} disabled={busy || !workspace.canSwitch} onChange={(event) => setExternalPath(event.target.value)}><option value="">발견된 worktree 연결</option>{unassignedWorktrees.map((item: Json) => <option key={item.path} value={item.path}>{item.branch || "detached"} · {item.path}</option>)}</select>
          <button type="button" className="icon-button" title="선택한 worktree 연결" aria-label="선택한 worktree 연결" disabled={busy || !workspace.canSwitch || !externalPath} onClick={() => void attachWorktree()}><Link2 size={15} /></button>
        </div>}
      </div>
      {!workspace.canSwitch && <span className="git-branch-note">터미널을 종료한 뒤 브랜치를 전환할 수 있습니다.</span>}
      {error && <span className="git-branch-error">{error}</span>}
    </div>}
  </section>;
}
