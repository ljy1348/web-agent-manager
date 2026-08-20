import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Download, File, FileArchive, FilePlus2, FileText, Film, FolderOpen, Image, Link2, Music, Pencil, Trash2, Upload, X,
} from "lucide-react";
import { api } from "../../api";
import { isImagePath, MessageBody } from "../../lib/attachments";
import { projectFileContentUrl, projectFileDownloadUrl } from "../../lib/file-links";
import { bytes } from "../../lib/format";
import type { Json } from "../../types";

interface FileTarget {
  projectId: number;
  path: string;
  line?: number | null;
  requestId: number;
}

type LineLinkTarget = { chatId: number } | { provider: string; accountId?: number | null };

// 채팅 검색·새 채팅 만들기를 함께 보여주는 줄 단위 링크 팝오버. 목록은 열릴 때 한 번만 불러오고
// 이후 입력은 클라이언트에서 제목·번호·공급자로 걸러 보여준다(입력창의 "#채팅" 멘션과 같은 방식).
// 전체 프로젝트를 대상으로 하는 목록이라, 제목이 기본값("새 Claude 채팅" 등)으로 겹칠 수 있어
// 어느 프로젝트인지 구분할 수 있게 프로젝트 이름도 함께 보여준다.
function LineChatLinkMenu({ providers, projects, onSelect, onClose }: { providers: Json[]; projects: Json[]; onSelect: (target: LineLinkTarget) => void; onClose: () => void }): React.ReactElement {
  const [query, setQuery] = useState("");
  const [chats, setChats] = useState<Json[] | null>(null);
  useEffect(() => { void api("/chats").then((data) => setChats(data.chats || [])).catch(() => setChats([])); }, []);
  const results = useMemo(() => {
    if (!chats) return [];
    const needle = query.trim().toLowerCase();
    return chats
      .filter((item: Json) => !needle || String(item.id).includes(needle) || String(item.title || "").toLowerCase().includes(needle) || String(item.provider || "").toLowerCase().includes(needle))
      .slice(0, 20);
  }, [chats, query]);
  return <div className="line-chat-menu" role="dialog" aria-label="채팅에 연결">
    <div className="line-chat-menu-head">
      <input autoFocus placeholder="채팅 검색…" value={query} onChange={(event) => setQuery(event.target.value)} />
      <button type="button" aria-label="닫기" onClick={onClose}>×</button>
    </div>
    <div className="line-chat-menu-new">{providers.map((provider: Json) => <button key={provider.id} type="button" onClick={() => onSelect({ provider: provider.id })}>+ 새 {provider.label} 채팅</button>)}</div>
    <div className="line-chat-menu-list">
      {chats === null && <div className="slash-empty">불러오는 중…</div>}
      {chats !== null && !results.length && <div className="slash-empty">일치하는 채팅이 없습니다.</div>}
      {results.map((item: Json) => <button key={item.id} type="button" className="line-chat-menu-item" onClick={() => onSelect({ chatId: item.id })}>
        <strong>{item.title || `채팅 #${item.id}`}</strong><small>#{item.id} · {item.provider} · {projects.find((project: Json) => project.id === item.project_id)?.name || ""}</small>
      </button>)}
    </div>
  </div>;
}

// 텍스트 미리보기를 줄 단위로 그려 특정 줄로 스크롤·강조하고, 줄마다 채팅 연결/생성 버튼을 붙인다.
function LineNumberedPreview({ content, truncated, targetLine, providers, projects, onLinkLine }: { content: string; truncated: boolean; targetLine?: number | null; providers: Json[]; projects: Json[]; onLinkLine: (line: number, target: LineLinkTarget) => void }): React.ReactElement {
  const lines = content.split("\n");
  const targetRef = useRef<HTMLDivElement>(null);
  const [openLine, setOpenLine] = useState<number | null>(null);
  useEffect(() => { if (targetLine) targetRef.current?.scrollIntoView({ block: "center" }); }, [targetLine, content]);
  return <div className="file-preview-lines">
    {lines.map((lineText, index) => {
      const lineNumber = index + 1;
      const isTarget = targetLine === lineNumber;
      return <div key={lineNumber} ref={isTarget ? targetRef : undefined} className={`file-preview-line${isTarget ? " target" : ""}`}>
        <span className="file-preview-line-number">{lineNumber}</span>
        <button type="button" className="file-preview-line-link" aria-label={`${lineNumber}번째 줄을 채팅에 연결`} onClick={() => setOpenLine((current) => current === lineNumber ? null : lineNumber)}><Link2 size={12} aria-hidden="true" /></button>
        <code className="file-preview-line-code">{lineText || " "}</code>
        {openLine === lineNumber && <LineChatLinkMenu providers={providers} projects={projects} onClose={() => setOpenLine(null)} onSelect={(target) => { onLinkLine(lineNumber, target); setOpenLine(null); }} />}
      </div>;
    })}
    {truncated && <p className="preview-truncated">일부만 표시됨</p>}
  </div>;
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
function PreviewContent({ preview, project, chatId, workspacePath, openProjectFile, targetLine, providers, projects, onLinkLine }: { preview: Json; project: Json; chatId?: number | null; workspacePath?: string; openProjectFile: (path: string, line?: number) => void; targetLine?: number | null; providers: Json[]; projects: Json[]; onLinkLine: (line: number, target: LineLinkTarget) => void }): React.ReactElement {
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
  return <LineNumberedPreview content={preview.content || ""} truncated={!!preview.truncated} targetLine={targetLine} providers={providers} projects={projects} onLinkLine={onLinkLine} />;
}

// 선택 프로젝트의 파일 목록과 탐색·업로드·형식별 미리보기를 제공한다.
export function FilesView({ project, chat, target, onNavigate, providers, projects, onLinkFileLine }: { project: Json | null; chat?: Json | null; target?: FileTarget | null; onNavigate?: (path: string) => void; providers?: Json[]; projects?: Json[]; onLinkFileLine?: (path: string, line: number, target: LineLinkTarget) => void }): React.ReactElement {
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
  // 채팅 메시지의 줄 링크로 들어왔을 때 텍스트 미리보기에서 스크롤·강조할 대상 줄.
  const [previewTargetLine, setPreviewTargetLine] = useState<number | null>(null);
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

  // 서버의 형식 판정을 읽어 선택 파일의 미리보기를 연다. 대상 줄은 revealPath가 이 함수의 완료를
  // 기다린 뒤 별도로 설정하므로, 여기서는 직접 클릭 등 줄 지정 없는 진입을 기본값(null)으로 되돌린다.
  async function previewFile(filePath: string): Promise<void> {
    if (!project) return;
    setDraft(null);
    setEditStatus("");
    setPreviewTargetLine(null);
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

  // 프로젝트 상대 경로를 파일 탭에서 드러내고 폴더면 진입, 파일이면 미리보기를 연다. line이 있으면
  // (채팅 메시지의 줄 링크를 눌러 들어온 경우) 미리보기가 실제로 로드된 뒤에 대상 줄을 지정한다.
  async function revealPath(filePath: string, line?: number): Promise<void> {
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
    else {
      await previewFile(normalized);
      if (line) setPreviewTargetLine(line);
    }
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
    if (targetPath !== null) void revealPath(targetPath, target?.line ?? undefined);
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

  // 파일·폴더를 삭제한다(되돌릴 수 없음, 관리자·신뢰 네트워크 전용). 지우려는 항목이 지금 미리보기
  // 중이면 미리보기도 함께 닫고, 성공하면 현재 디렉터리 목록을 다시 읽는다.
  async function deleteEntry(entryPath: string, isDirectory: boolean): Promise<void> {
    if (!project) return;
    const message = isDirectory
      ? `"${entryPath}" 폴더와 그 안의 모든 내용을 삭제할까요? 되돌릴 수 없습니다.`
      : `"${entryPath}"을(를) 삭제할까요? 되돌릴 수 없습니다.`;
    if (!window.confirm(message)) return;
    try {
      await api(`/projects/${project.id}/files?path=${encodeURIComponent(entryPath)}${chatQuery}`, { method: "DELETE" });
      if (preview?.path === entryPath) { setDraft(null); setPreview(null); }
      await loadDirectory(directory, false);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "삭제하지 못했습니다.");
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
        <div className="file-actions">
          {!entry.directory && project && <a title="다운로드" aria-label={`${entry.name} 다운로드`} href={projectFileDownloadUrl(project.id, relativePath, chat?.id)}><Download /></a>}
          {project && <button type="button" className="danger" title="삭제" aria-label={`${entry.name} 삭제`} onClick={() => void deleteEntry(relativePath, !!entry.directory)}><Trash2 /></button>}
        </div>
      </div>;
    })}
      {!entries.length && <p className="file-list-empty">이 폴더는 비어 있습니다.</p>}
    </div>
    {preview && project && <aside className="file-preview" role="dialog" aria-modal="true" aria-label={`${preview.path} 미리보기`}><div className="git-box-head"><h3>{draft === null ? "미리보기" : "편집"}</h3><div className="file-preview-head-actions">
      <a title="다운로드" aria-label={`${preview.path} 다운로드`} href={projectFileDownloadUrl(project.id, preview.path, chat?.id)}><Download /></a>
      {draft === null && isEditable(preview) && <button type="button" title="편집" aria-label={`${preview.path} 편집`} onClick={() => { setDraft(preview.content || ""); setEditStatus(""); }}><Pencil /></button>}
      <button type="button" className="danger" title="삭제" aria-label={`${preview.path} 삭제`} onClick={() => void deleteEntry(preview.path, false)}><Trash2 /></button>
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
      </> : preview && project ? <><PreviewContent
          preview={preview}
          project={project}
          chatId={chat?.id}
          workspacePath={chat?.worktree_path}
          openProjectFile={(path, line) => { if (!confirmDiscard()) return; onNavigate?.(path); void revealPath(path, line); }}
          targetLine={previewTargetLine}
          providers={providers || []}
          projects={projects || []}
          onLinkLine={(line, target) => onLinkFileLine?.(preview.path, line, target)}
        />
        {editStatus && <p className="inline-status">{editStatus}</p>}
      </> : <p className="muted">파일을 선택하면 형식에 맞는 미리보기가 표시됩니다.</p>}
    </aside>}</div>
  </section>;
}
