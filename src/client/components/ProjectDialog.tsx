import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FolderGit2, FolderOpen, FolderPlus, X } from "lucide-react";
import { api } from "../api";
import type { Json } from "../types";
import { GithubRepositoryList } from "./GithubRepositoryList";
import { useDialogHistory } from "../lib/dialog-history";

type ProjectMode = "create" | "existing" | "github";

// 새 Git 프로젝트 생성, 기존 폴더 등록, GitHub 저장소 clone을 한 모달에서 제공한다.
export function ProjectDialog({
  open,
  defaultPath,
  defaultWorkspacePath,
  onClose,
  onProject,
}: {
  open: boolean;
  defaultPath: string;
  defaultWorkspacePath: string;
  onClose: () => void;
  onProject: (project: Json) => void;
}): React.ReactElement | null {
  const [mode, setMode] = useState<ProjectMode>("create");
  const [workspacePath, setWorkspacePath] = useState(defaultWorkspacePath);
  const [directoryName, setDirectoryName] = useState("");
  const [projectPath, setProjectPath] = useState(defaultPath);
  const [name, setName] = useState("");
  const [createGithub, setCreateGithub] = useState(false);
  const [repository, setRepository] = useState("");
  const [visibility, setVisibility] = useState("private");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dismiss = useDialogHistory(open, onClose, "project-create");

  useEffect(() => {
    if (!open) return;
    setMode("create");
    setWorkspacePath(defaultWorkspacePath);
    setProjectPath(defaultPath);
    setDirectoryName("");
    setName("");
    setCreateGithub(false);
    setRepository("");
    setVisibility("private");
    setDescription("");
    setError("");
  }, [open, defaultPath, defaultWorkspacePath]);
  if (!open) return null;

  async function submitProject(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = mode === "create"
        ? { mode: "create", workspacePath, directoryName, name, createGithub, repository, visibility, description }
        : { mode: "register", path: projectPath, name, createGithub, repository, visibility, description };
      const data = await api("/projects", { method: "POST", body: JSON.stringify(body) });
      dismiss(() => onProject(data.project));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "프로젝트 생성에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }

  const githubOptions = <>
    <label className="check-row"><input type="checkbox" checked={createGithub} onChange={(event) => setCreateGithub(event.target.checked)} /><span>GitHub 저장소 생성 및 origin 연결</span></label>
    {createGithub && <div className="github-create-options">
      <label>저장소 이름<input value={repository} onChange={(event) => setRepository(event.target.value)} placeholder={directoryName || "폴더명 사용 또는 owner/repository"} /></label>
      <label>공개 범위<select value={visibility} onChange={(event) => setVisibility(event.target.value)}><option value="private">비공개 (Private)</option><option value="public">공개 (Public)</option><option value="internal">조직 내부 (Internal)</option></select></label>
      <label className="full">설명<input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={350} /></label>
    </div>}
  </>;

  return createPortal(<div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) dismiss(); }}>
    <section className="project-dialog" role="dialog" aria-modal="true" aria-label="프로젝트 생성">
      <header><div><span className="eyebrow">작업공간</span><h2>프로젝트 추가</h2></div><button type="button" className="icon-button" title="닫기" aria-label="닫기" onClick={() => dismiss()} disabled={busy}><X size={18} /></button></header>
      <div className="segmented project-source-tabs">
        <button type="button" className={mode === "create" ? "active" : ""} onClick={() => { setMode("create"); setError(""); }}><FolderPlus size={16} />새 프로젝트</button>
        <button type="button" className={mode === "existing" ? "active" : ""} onClick={() => { setMode("existing"); setError(""); }}><FolderOpen size={16} />기존 폴더</button>
        <button type="button" className={mode === "github" ? "active" : ""} onClick={() => { setMode("github"); setError(""); }}><FolderGit2 size={16} />GitHub 저장소</button>
      </div>
      {mode === "create" && <form className="project-form" onSubmit={submitProject}>
        <p className="project-form-note">워크스페이스 아래에 새 폴더를 만들고 <b>main</b> 브랜치 Git 저장소로 초기화합니다.</p>
        <label>워크스페이스 경로<input value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} required autoFocus /></label>
        <label>프로젝트 폴더명<input value={directoryName} onChange={(event) => setDirectoryName(event.target.value)} placeholder="study" required /></label>
        <label>표시 이름<input value={name} onChange={(event) => setName(event.target.value)} placeholder={directoryName || "폴더명 사용"} /></label>
        {workspacePath && directoryName && <span className="project-path-preview">생성 위치: {workspacePath.replace(/[\\/]+$/, "")}/{directoryName}</span>}
        {githubOptions}
        {error && <div className="error">{error}</div>}
        <div className="dialog-actions"><button type="button" onClick={() => dismiss()} disabled={busy}>취소</button><button className="primary" disabled={busy}>{busy ? "생성 중" : "새 프로젝트 생성"}</button></div>
      </form>}
      {mode === "existing" && <form className="project-form" onSubmit={submitProject}>
        <p className="project-form-note">서버에 이미 존재하는 폴더를 WAM 프로젝트로 등록합니다.</p>
        <label>서버의 프로젝트 절대 경로<input value={projectPath} onChange={(event) => setProjectPath(event.target.value)} required autoFocus /></label>
        <label>표시 이름<input value={name} onChange={(event) => setName(event.target.value)} placeholder="폴더명 사용" /></label>
        {githubOptions}
        {error && <div className="error">{error}</div>}
        <div className="dialog-actions"><button type="button" onClick={() => dismiss()} disabled={busy}>취소</button><button className="primary" disabled={busy}>{busy ? "등록 중" : "기존 폴더 등록"}</button></div>
      </form>}
      {mode === "github" && <GithubRepositoryList onProject={(project) => dismiss(() => onProject(project))} />}
    </section>
  </div>, document.body);
}
