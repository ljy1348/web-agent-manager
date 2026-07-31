import React, { useEffect, useRef, useState } from "react";
import {
  Download, File, FileArchive, FilePlus2, FileText, Film, FolderOpen, Image, Music, Upload, X,
} from "lucide-react";
import { api } from "../../api";
import { isImagePath, MessageBody } from "../../lib/attachments";
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

// 파일 미리보기 원본을 경로 세그먼트별로 인코딩한 API URL로 만든다.
export function fileContentUrl(projectId: number, filePath: string): string {
  const encodedPath = filePath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `/api/projects/${projectId}/files/content/${encodedPath}`;
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

// 서버가 판정한 파일 종류에 맞는 미리보기 본문을 렌더링한다.
function PreviewContent({ preview, project, openProjectFile }: { preview: Json; project: Json; openProjectFile: (path: string) => void }): React.ReactElement {
  const url = fileContentUrl(project.id, preview.path);
  if (!preview.previewable) return <p className="muted">{preview.reason || "미리볼 수 없는 파일입니다."}</p>;
  if (preview.kind === "markdown") {
    const linkBasePath = preview.path.split("/").slice(0, -1).join("/");
    return <div className="file-preview-markdown"><MessageBody content={preview.content || ""} projectId={project.id} projectPath={project.path} linkBasePath={linkBasePath} onOpenProjectFile={openProjectFile} />{preview.truncated && <p className="preview-truncated">일부만 표시됨</p>}</div>;
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
export function FilesView({ project, target, onNavigate }: { project: Json | null; target?: FileTarget | null; onNavigate?: (path: string) => void }): React.ReactElement {
  const [directory, setDirectory] = useState("");
  const [entries, setEntries] = useState<Json[]>([]);
  const [preview, setPreview] = useState<Json | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [uploadCount, setUploadCount] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  // 지정 디렉터리의 목록을 불러오고 현재 탐색 위치를 갱신한다.
  async function loadDirectory(nextPath: string, clearPreview = true): Promise<Json[]> {
    if (!project) return [];
    try {
      const data = await api(`/projects/${project.id}/files?path=${encodeURIComponent(nextPath)}`);
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

  // 서버의 형식 판정을 읽어 선택 파일의 미리보기를 연다.
  async function previewFile(filePath: string): Promise<void> {
    if (!project) return;
    setPreviewLoading(true);
    setPreview({ path: filePath, previewable: true, kind: "loading" });
    try {
      const data = await api(`/projects/${project.id}/files/preview?path=${encodeURIComponent(filePath)}`);
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
    if (!project) {
      setDirectory("");
      setEntries([]);
      setPreview(null);
      return;
    }
    const targetPath = target && target.projectId === project.id ? target.path : null;
    if (targetPath !== null) void revealPath(targetPath);
    else void loadDirectory("");
  }, [project?.id, target?.requestId]);

  // 선택한 파일들을 현재 디렉터리에 업로드한 뒤 목록을 갱신한다.
  async function upload(): Promise<void> {
    if (!project || !input.current?.files?.length) return;
    const form = new FormData();
    Array.from(input.current.files).forEach((file) => form.append("files", file));
    await api(`/projects/${project.id}/files/upload?path=${encodeURIComponent(directory)}`, { method: "POST", body: form });
    input.current.value = "";
    setUploadCount(0);
    await loadDirectory(directory);
  }

  // 목록 항목의 기본 동작을 폴더 진입 또는 파일 미리보기로 연결한다.
  function openEntry(entry: Json, relativePath: string): void {
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
          {image && <span className="file-thumb"><img src={fileContentUrl(project.id, relativePath)} alt={entry.name} loading="lazy" /></span>}
          {!image && <span className="file-row-icon">{entry.directory ? <FolderOpen aria-hidden="true" /> : <FileIcon path={relativePath} />}</span>}
          <b>{entry.name}</b>
        </button>
        <span className="file-row-size">{entry.directory ? "-" : bytes(entry.size)}</span>
        <time className="file-row-modified" dateTime={entry.modifiedAt || undefined}>{fileDate(entry.modifiedAt)}</time>
        <div className="file-actions">{!entry.directory && <a title="다운로드" aria-label={`${entry.name} 다운로드`} href={`/api/projects/${project?.id}/files/download?path=${encodeURIComponent(relativePath)}`}><Download /></a>}</div>
      </div>;
    })}
      {!entries.length && <p className="file-list-empty">이 폴더는 비어 있습니다.</p>}
    </div>
    {preview && <aside className="file-preview" role="dialog" aria-modal="true" aria-label={`${preview.path} 미리보기`}><div className="git-box-head"><h3>미리보기</h3><button type="button" title="미리보기 닫기" aria-label="미리보기 닫기" onClick={() => { setPreview(null); onNavigate?.(directory); }}><X /></button></div>
      {preview && <strong>{preview.path}</strong>}
      {previewLoading ? <p className="muted">불러오는 중...</p> : preview && project ? <PreviewContent preview={preview} project={project} openProjectFile={(path) => { onNavigate?.(path); void revealPath(path); }} /> : <p className="muted">파일을 선택하면 형식에 맞는 미리보기가 표시됩니다.</p>}
    </aside>}</div>
  </section>;
}
