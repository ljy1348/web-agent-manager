import React, { useEffect, useRef, useState } from "react";
import {
  Download, File, FileArchive, FilePlus2, FileText, Film, FolderOpen, Image, Music, Pencil, Upload, X,
} from "lucide-react";
import { api } from "../../api";
import { isImagePath, MessageBody } from "../../lib/attachments";
import { projectFileContentUrl } from "../../lib/file-links";
import { bytes } from "../../lib/format";
import type { Json } from "../../types";

interface FileTarget {
  projectId: number;
  path: string;
  requestId: number;
}

const FILE_DATE_FORMATTER = new Intl.DateTimeFormat("ko-KR", {
  year: "2-digit", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});

// 현재 디렉터리와 파일명을 프로젝트 상대 경로로 합친다.
function joinPath(directory: string, name: string): string {
  return [directory, name].filter(Boolean).join("/");
}

// 파일 목록의 수정 시각을 짧고 일관된 현지 형식으로 표시한다.
function fileDate(value: unknown): string {
  if (typeof value !== "string") return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return FILE_DATE_FORMATTER.format(date);
}

// 파일 확장자에 맞는 목록 아이콘을 선택한다.
function FileIcon({ path }: { path: string }): React.ReactElement {
  if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(path)) return <Image aria-hidden="true" />;
  if (/\.(mp4|m4v|mov|webm|ogv)$/i.test(path)) return <Film aria-hidden="true" />;
  if (/\.(mp3|wav|ogg|oga|m4a|flac)$/i.test(path)) return <Music aria-hidden="true" />;
  if (/\.(zip|epub)$/i.test(path)) return <FileArchive aria-hidden="true" />;
  if (/\.(md|markdown|txt|html?|pdf)$/i.test(path)) return <FileText aria-hidden="true" />;
  return <File aria-hidden="true" />;
}

// 서버가 텍스트로 판정했고 전체 내용을 받은 파일만 편집을 허용한다(잘린 내용으로 저장하면 뒷부분이 사라짐).
function isEditable(preview: Json | null): boolean {
  return !!preview?.previewable && !preview.truncated && (preview.kind === "text" || preview.kind === "markdown");
}

// 서버가 판정한 파일 종류에 맞는 미리보기 본문을 렌더링한다.
function PreviewContent({ preview, project, chatId, workspacePath, openProjectFile }: { preview: Json; project: Json; chatId?: number | null; workspacePath?: string; openProjectFile: (path: string) => void }): React.ReactElement {
  const url = projectFileContentUrl(project.id, preview.path, chatId);
  if (!preview.previewable) return <p className="muted">{preview.reason || "미리볼 수 없는 파일입니다."}</p>;
  if (preview.kind === "markdown") {
    const linkBasePath = preview.path.split("/").slice(0, -1).join("/");
    return <div className="file-preview-markdown"><MessageBody content={preview.content || ""} projectId={project.id} projectPath={project.path} workspacePath={workspacePath} chatId={chatId} linkBasePath={linkBasePath} onOpenProjectFile={openProjectFile} />{preview.truncated && <p className="preview-truncated">일부만 표시됨</p>}</div>;
  }
  if (preview.kind === "html") return <iframe className="file-preview-frame" src={url} sandbox="" title={`${preview.path} HTML 미리보기`} />;
  if (preview.kind === "image") return <img className="file-preview-media" src={url} alt={preview.path} />;
  if (preview.kind === "video") return <video className="file-preview-media" src={url} controls preload="metadata" />;
  if (preview.kind === "audio") return <audio className="file-preview-audio" src={url} controls preload="metadata" />;
  if (preview.kind === "pdf") return <iframe className="file-preview-frame" src={url} title={`${preview.path} PDF 미리보기`} />;
  if (preview.kind === "archive") return <p className="muted">압축파일입니다.</p>;
  return <pre>{preview.content}{preview.truncated ? "\n\n... 일부만 표시됨" : ""}</pre>;
}

// 선택 프로젝트의 파일 목록과 탐색·업로드·형식별 미리보기를 제공한다.
export function FilesView({ project, chat, target, onNavigate }: { project: Json | null; chat?: Json | null; target?: FileTarget | null; onNavigate?: (path: string) => void }): React.ReactElement {
  // 선택한 채팅이 전용 worktree를 쓰면 파일 탭도 그 폴더를 봐야 한다.
  const chatQuery = chat?.id ? `&chatId=${chat.id}` : "";
  const [directory, setDirectory] = useState("");
  const [entries, setEntries] = useState<Json[]>([]);
  const [preview, setPreview] = useState<Json | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [uploadCount, setUploadCount] = useState(0);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editStatus, setEditStatus] = useState("");
  const input = useRef<HTMLInputElement>(null);

  // 지정 디렉터리의 목록을 불러오고 현재 탐색 위치를 갱신한다.
  async function loadDirectory(nextPath: string, clearPreview = true): Promise<Json[]> {
    if (!project) return [];
    try {
      const data = await api(`/projects/${project.id}/files?path=${encodeURIComponent(nextPath)}${chatQuery}`);
      const nextEntries = data.entries || [];
      setDirectory(nextPath);
      setEntries(nextEntries);
      setListError("");
      if (clearPreview) setPreview(null);
      return nextEntries;
    } catch (error) {
      setListError(error instanceof Error ? error.message : "파일 목록을 불러오지 못했습니다.");
      return [];
    }
  }

  // 편집 중인 내용을 버리고 다른 곳으로 이동해도 되는지 사용자에게 확인한다.
  function confirmDiscard(): boolean {
    if (draft === null) return true;
    return window.confirm("편집 중인 내용이 저장되지 않았습니다. 변경을 버리고 이동할까요?");
  }

  // 서버의 형식 판정을 읽어 선택 파일의 미리보기를 연다.
  async function previewFile(filePath: string): Promise<void> {
    if (!project) return;
    setDraft(null);
    setEditStatus("");
    setPreviewLoading(true);
    setPreview({ path: filePath, previewable: true, kind: "loading" });
    try {
      const data = await api(`/projects/${project.id}/files/preview?path=${encodeURIComponent(filePath)}${chatQuery}`);
      setPreview({ ...data, path: filePath });
    } catch (error) {
      setPreview({ path: filePath, previewable: false, reason: error instanceof Error ? error.message : "미리보기 실패" });
    } finally {
      setPreviewLoading(false);
    }
  }

  // 프로젝트 상대 경로를 파일 탭에서 드러내고 폴더면 진입, 파일이면 미리보기를 연다.
  async function revealPath(filePath: string): Promise<void> {
    const normalized = filePath.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
    if (!normalized) {
      await loadDirectory("");
      return;
    }
    const parts = normalized.split("/");
    const name = parts.pop() || "";
    const parent = parts.join("/");
    const parentEntries = await loadDirectory(parent, false);
    const entry = parentEntries.find((item: Json) => item.name === name);
    if (entry?.directory) await loadDirectory(normalized);
    else await previewFile(normalized);
  }

  useEffect(() => {
    setDraft(null);
    setEditStatus("");
    if (!project) {
      setDirectory("");
      setEntries([]);
      setPreview(null);
      return;
    }
    const targetPath = target && target.projectId === project.id ? target.path : null;
    if (targetPath !== null) void revealPath(targetPath);
    else void loadDirectory("");
  }, [project?.id, chat?.id, target?.requestId]);

  // 선택한 파일들을 현재 디렉터리에 업로드한 뒤 목록을 갱신한다.
  async function upload(): Promise<void> {
    if (!project || !input.current?.files?.length) return;
    const form = new FormData();
    Array.from(input.current.files).forEach((file) => form.append("files", file));
    await api(`/projects/${project.id}/files/upload?path=${encodeURIComponent(directory)}${chatQuery}`, { method: "POST", body: form });
    input.current.value = "";
    setUploadCount(0);
    await loadDirectory(directory);
  }

  // 편집 중인 텍스트를 저장하고 미리보기와 목록의 크기·수정 시각을 갱신한다.
  async function saveDraft(): Promise<void> {
    if (!project || !preview || draft === null) return;
    setSaving(true);
    setEditStatus("");
    try {
      await api(`/projects/${project.id}/files/content?chatId=${chat?.id ?? ""}`, { method: "PUT", body: JSON.stringify({ path: preview.path, content: draft }) });
      setDraft(null);
      await previewFile(preview.path);
      await loadDirectory(directory, false);
      setEditStatus("저장했습니다.");
    } catch (error) {
      setEditStatus(error instanceof Error ? error.message : "저장하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  }

  // 목록 항목의 기본 동작을 폴더 진입 또는 파일 미리보기로 연결한다.
  function openEntry(entry: Json, relativePath: string): void {
    if (!confirmDiscard()) return;
    onNavigate?.(relativePath);
    if (entry.directory) void loadDirectory(relativePath);
    else void previewFile(relativePath);
  }

  return <section className="panel"><div className="section-head"><div><span className="eyebrow">프로젝트 파일</span><h2>{project?.name || "프로젝트를 선택하세요"}</h2></div><div className="file-upload-controls">
    <input ref={input} className="file-input" type="file" multiple onChange={(event) => setUploadCount(event.currentTarget.files?.length || 0)} />
    <button type="button" onClick={() => input.current?.click()}><FilePlus2 />파일 선택</button>
    {uploadCount > 0 && <span>{uploadCount}개 선택</span>}
    <button type="button" className="primary" disabled={!uploadCount} onClick={() => void upload()}><Upload />업로드</button>
  </div></div>
    <div className="breadcrumb"><button onClick={() => { onNavigate?.(""); void loadDirectory(""); }}>root</button>{directory.split("/").filter(Boolean).map((part, index, all) => {
      const targetPath = all.slice(0, index + 1).join("/");
      return <button key={index} onClick={() => { onNavigate?.(targetPath); void loadDirectory(targetPath); }}>/ {part}</button>;
    })}</div>
    {listError && <p className="error-text">{listError}</p>}
    <div className={`file-browser${preview ? " has-preview" : ""}`}><div className="file-list">
      <div className="file-list-head" aria-hidden="true"><span>이름</span><span>크기</span><span>수정</span><span>작업</span></div>
      {entries.map((entry) => {
      const relativePath = joinPath(directory, entry.name);
      const image = !entry.directory && project && isImagePath(relativePath);
      return <div
        key={entry.name}
        className={`file-row ${entry.directory ? "file-folder" : "file-item"}${preview?.path === relativePath ? " active" : ""}`}
      >
        <button type="button" className="file-row-open" title={entry.name} aria-label={`${entry.directory ? "폴더 열기" : "파일 미리보기"}: ${entry.name}`} onClick={() => openEntry(entry, relativePath)}>
          {image && <span className="file-thumb"><img src={projectFileContentUrl(project.id, relativePath, chat?.id)} alt={entry.name} loading="lazy" /></span>}
          {!image && <span className="file-row-icon">{entry.directory ? <FolderOpen aria-hidden="true" /> : <FileIcon path={relativePath} />}</span>}
          <b>{entry.name}</b>
        </button>
        <span className="file-row-size">{entry.directory ? "-" : bytes(entry.size)}</span>
        <time className="file-row-modified" dateTime={entry.modifiedAt || undefined}>{fileDate(entry.modifiedAt)}</time>
        <div className="file-actions">{!entry.directory && <a title="다운로드" aria-label={`${entry.name} 다운로드`} href={`/api/projects/${project?.id}/files/download?path=${encodeURIComponent(relativePath)}${chatQuery}`}><Download /></a>}</div>
      </div>;
    })}
      {!entries.length && <p className="file-list-empty">이 폴더는 비어 있습니다.</p>}
    </div>
    {preview && <aside className="file-preview" role="dialog" aria-modal="true" aria-label={`${preview.path} 미리보기`}><div className="git-box-head"><h3>{draft === null ? "미리보기" : "편집"}</h3><div className="file-preview-head-actions">
      {draft === null && isEditable(preview) && <button type="button" title="편집" aria-label={`${preview.path} 편집`} onClick={() => { setDraft(preview.content || ""); setEditStatus(""); }}><Pencil /></button>}
      <button type="button" title="미리보기 닫기" aria-label="미리보기 닫기" onClick={() => { if (!confirmDiscard()) return; setDraft(null); setPreview(null); onNavigate?.(directory); }}><X /></button>
    </div></div>
      {preview && <strong>{preview.path}</strong>}
      {previewLoading ? <p className="muted">불러오는 중...</p> : draft !== null ? <>
        <textarea className="file-preview-editor" value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false} aria-label={`${preview.path} 내용 편집`} />
        <div className="file-edit-actions">
          <button type="button" className="primary" disabled={saving} onClick={() => void saveDraft()}>{saving ? "저장 중..." : "저장"}</button>
          <button type="button" disabled={saving} onClick={() => { if (!confirmDiscard()) return; setDraft(null); setEditStatus(""); }}>취소</button>
          {editStatus && <span className="inline-status">{editStatus}</span>}
        </div>
      </> : preview && project ? <><PreviewContent preview={preview} project={project} chatId={chat?.id} workspacePath={chat?.worktree_path} openProjectFile={(path) => { if (!confirmDiscard()) return; onNavigate?.(path); void revealPath(path); }} />
        {editStatus && <p className="inline-status">{editStatus}</p>}
      </> : <p className="muted">파일을 선택하면 형식에 맞는 미리보기가 표시됩니다.</p>}
    </aside>}</div>
  </section>;
}
