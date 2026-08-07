import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { FolderGit2, Globe2, LoaderCircle, LockKeyhole, RefreshCw, X } from "lucide-react";
import { api } from "../api";
import type { Json } from "../types";
import { useDialogHistory } from "../lib/dialog-history";

// GitHub 저장소 목록에서 기존 프로젝트 이동 또는 새 clone 프로젝트 생성을 제공한다.
export function GithubRepositoryList({ onProject }: { onProject: (project: Json) => void }): React.ReactElement {
  const [repositories, setRepositories] = useState<Json[]>([]);
  const [owners, setOwners] = useState<Json[]>([]);
  const [owner, setOwner] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const [pendingRepository, setPendingRepository] = useState<Json | null>(null);
  const [destination, setDestination] = useState("");
  const dismissPending = useDialogHistory(!!pendingRepository, () => setPendingRepository(null), "github-project-create");
  const filtered = useMemo(() => repositories.filter((repository) => {
    const repositoryOwner = String(repository.nameWithOwner).split("/", 1)[0].toLowerCase();
    return (!owner || repositoryOwner === owner.toLowerCase())
      && `${repository.nameWithOwner} ${repository.description || ""}`.toLowerCase().includes(query.toLowerCase());
  }), [repositories, owner, query]);

  // 인증된 gh 계정의 저장소와 WAM 연결 상태를 새로 읽는다.
  async function load(): Promise<void> {
    setLoading(true);
    setError("");
    try {
      const data = await api("/github/repositories");
      setRepositories(data.repositories || []);
      setOwners(data.owners || []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "GitHub 저장소를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  // 연결된 프로젝트는 열고 미연결 저장소는 생성 확인 모달을 연다.
  function openRepository(repository: Json): void {
    if (repository.projectId) {
      onProject({ id: repository.projectId, name: repository.name, path: repository.localPath, active: 1 });
      return;
    }
    setError("");
    setPendingRepository(repository);
    setDestination(repository.localPath);
  }

  // 확인한 저장소와 목적 경로로 clone 프로젝트를 생성한다.
  async function createProject(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!pendingRepository) return;
    setWorking(pendingRepository.nameWithOwner);
    setError("");
    try {
      const data = await api("/github/projects", { method: "POST", body: JSON.stringify({ repository: pendingRepository.nameWithOwner, destination }) });
      dismissPending(() => onProject(data.project));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "프로젝트 생성에 실패했습니다.");
    } finally {
      setWorking("");
    }
  }

  return <div className="github-repository-browser">
    <div className="repository-toolbar">
      <select value={owner} onChange={(event) => setOwner(event.target.value)} aria-label="GitHub 소유자 필터">
        <option value="">전체 소유자</option>
        {owners.map((item) => <option value={item.login} key={item.login}>{item.login} · {item.type === "organization" ? "조직" : "개인"}</option>)}
      </select>
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="저장소 이름 검색" aria-label="GitHub 저장소 검색" />
      <button type="button" title="저장소 새로고침" onClick={() => void load()} disabled={loading}><RefreshCw className={loading ? "spin" : ""} size={16} /></button>
    </div>
    {error && <div className="error">{error}</div>}
    {loading ? <div className="resource-loading"><LoaderCircle className="spin" size={18} /> 저장소 불러오는 중</div> : <div className="repository-list">
      {filtered.length ? filtered.map((repository) => <div className="repository-row" key={repository.nameWithOwner}>
        <span className="repository-visibility" title={repository.isPrivate ? "비공개 저장소" : "공개 저장소"}>{repository.isPrivate ? <LockKeyhole size={16} /> : <Globe2 size={16} />}</span>
        <div><strong>{repository.nameWithOwner}</strong><span>{repository.description || "설명 없음"}</span><small>{repository.projectId ? `연결됨 · ${repository.localPath}` : repository.localPath}</small></div>
        <button type="button" className={repository.projectId ? "" : "primary"} disabled={!!working} onClick={() => openRepository(repository)}>
          {working === repository.nameWithOwner ? <LoaderCircle className="spin" size={15} /> : <FolderGit2 size={15} />}{repository.projectId ? "채팅 열기" : "프로젝트 생성"}
        </button>
      </div>) : <p className="resource-empty">표시할 저장소가 없습니다.</p>}
    </div>}
    {pendingRepository && createPortal(<div className="modal-backdrop repository-project-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !working) dismissPending(); }}>
      <section className="repository-project-dialog" role="dialog" aria-modal="true" aria-label="GitHub 프로젝트 생성">
        <header><div><span className="eyebrow">GitHub 저장소</span><h2>새 프로젝트</h2></div><button type="button" className="icon-button" title="닫기" aria-label="닫기" onClick={() => dismissPending()} disabled={!!working}><X size={18} /></button></header>
        <form className="project-form" onSubmit={createProject}>
          <div className="repository-project-name"><strong>{pendingRepository.nameWithOwner}</strong><span>{pendingRepository.description || "설명 없음"}</span></div>
          <label>프로젝트 경로<input value={destination} onChange={(event) => setDestination(event.target.value)} required autoFocus /></label>
          {error && <div className="error">{error}</div>}
          <div className="dialog-actions"><button type="button" onClick={() => dismissPending()} disabled={!!working}>취소</button><button className="primary" disabled={!!working}>{working ? <><LoaderCircle className="spin" size={15} /> 생성 중</> : "프로젝트 생성"}</button></div>
        </form>
      </section>
    </div>, document.body)}
  </div>;
}
