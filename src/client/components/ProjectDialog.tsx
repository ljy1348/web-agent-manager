import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FolderGit2, FolderPlus, X } from "lucide-react";
import { api } from "../api";
import type { Json } from "../types";
import { GithubRepositoryList } from "./GithubRepositoryList";

type ProjectMode = "local" | "github";

// 로컬 경로 등록과 GitHub 저장소 clone을 한 모달에서 제공한다.
export function ProjectDialog({ open, defaultPath, onClose, onProject }: { open: boolean; defaultPath: string; onClose: () => void; onProject: (project: Json) => void }): React.ReactElement | null {
  const [mode, setMode] = useState<ProjectMode>("local");
  const [projectPath, setProjectPath] = useState(defaultPath);
  const [name, setName] = useState("");
  const [createGithub, setCreateGithub] = useState(false);
  const [repository, setRepository] = useState("");
  const [visibility, setVisibility] = useState("private");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { if (open) setProjectPath(defaultPath); }, [open, defaultPath]);
  if (!open) return null;

  // 로컬 디렉터리를 등록하고 선택 시 GitHub 저장소와 origin도 함께 만든다.
  async function submitLocal(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await api("/projects", {
        method: "POST",
        body: JSON.stringify({ path: projectPath, name, createGithub, repository, visibility, description }),
      });
      onProject(data.project);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "프로젝트 등록에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return createPortal(<div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="project-dialog" role="dialog" aria-modal="true" aria-label="프로젝트 생성">
      <header><div><span className="eyebrow">작업공간</span><h2>프로젝트 생성</h2></div><button type="button" className="icon-button" title="닫기" onClick={onClose}><X size={18} /></button></header>
      <div className="segmented project-source-tabs">
        <button type="button" className={mode === "local" ? "active" : ""} onClick={() => setMode("local")}><FolderPlus size={16} />로컬 경로</button>
        <button type="button" className={mode === "github" ? "active" : ""} onClick={() => setMode("github")}><FolderGit2 size={16} />GitHub 저장소</button>
      </div>
      {mode === "local" ? <form className="project-form" onSubmit={submitLocal}>
        <label>서버의 프로젝트 절대 경로<input value={projectPath} onChange={(event) => setProjectPath(event.target.value)} required autoFocus /></label>
        <label>표시 이름<input value={name} onChange={(event) => setName(event.target.value)} placeholder="폴더명 사용" /></label>
        <label className="check-row"><input type="checkbox" checked={createGithub} onChange={(event) => setCreateGithub(event.target.checked)} /><span>GitHub 저장소 생성 및 origin 연결</span></label>
        {createGithub && <div className="github-create-options">
          <label>저장소 이름<input value={repository} onChange={(event) => setRepository(event.target.value)} placeholder="폴더명 사용 또는 owner/repository" /></label>
          <label>공개 범위<select value={visibility} onChange={(event) => setVisibility(event.target.value)}><option value="private">비공개</option><option value="public">공개</option><option value="internal">조직 내부</option></select></label>
          <label className="full">설명<input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={350} /></label>
        </div>}
        {error && <div className="error">{error}</div>}
        <div className="dialog-actions"><button type="button" onClick={onClose}>취소</button><button className="primary" disabled={busy}>{busy ? "생성 중" : "프로젝트 생성"}</button></div>
      </form> : <GithubRepositoryList onProject={(project) => { onProject(project); onClose(); }} />}
    </section>
  </div>, document.body);
}
