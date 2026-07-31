import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { projectFilePathFromHref } from "./file-links";

// 업로드 첨부 참조 표시("[첨부: 경로]")와 이미지 확장자 판정에 쓰는 공통 규칙.
const ATTACHMENT_MARKER = /\[첨부: ([^\]]+)\]/g;
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|bmp)$/i;

// 첨부 경로가 브라우저가 바로 그릴 수 있는 이미지 형식인지 확인한다.
export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSION.test(path);
}

// 채팅·프로젝트 소속을 검증하는 첨부 전용 API URL을 만든다.
export function attachmentUrl(projectId: number, path: string, download = false): string {
  return `/api/projects/${projectId}/attachments/content?path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`;
}

// 메시지 본문의 "[첨부: 경로]"를 이미지 썸네일 또는 파일 탭 링크로 변환한다.
function substituteAttachments(content: string, projectId?: number): string {
  if (!projectId) return content;
  return content.replace(ATTACHMENT_MARKER, (_match, attachedPath) => isImagePath(attachedPath)
    ? `![${attachedPath}](${attachmentUrl(projectId, attachedPath)})`
    : `[첨부: ${attachedPath}](${attachmentUrl(projectId, attachedPath, true)})`);
}

// AI 응답을 마크다운으로 렌더링한다(GFM: 표·취소선·작업 목록 포함). 일반 프로젝트 이미지는 파일
// 탭 미리보기로 보내고 숨김 저장소의 채팅 첨부는 소속 검증 전용 API에서 직접 연다. 커스텀 확대
// 오버레이는 모바일 제스처와 충돌했던 실사용 피드백에 따라 사용하지 않는다.
// 그 외 일반 링크는 페이지를 벗어나지 않도록 새 탭으로 연다.
// 원본 파일이 삭제됐거나(세션 기록엔 남아 있지만 실제로는 저장된 적 없는 경우 등) 애초에 없어 로딩이
// 실패하면, 크기 없는 img가 0→깨진 아이콘 크기로 튀며 레이아웃이 흔들리고 하필 그 위치가 화면
// 아래쪽이면 "맨 아래 자동 정렬"과 맞물려 채팅창이 계속 들썩이는 것처럼 보였다(실사용 재현). 이 행이
// 가상 스크롤 목록에서 화면 밖으로 나가 언마운트됐다가 다시 마운트되면(예: 새 메시지가 계속 쌓여 자동
// 스크롤이 반복될 때) 컴포넌트 state로만 "실패했음"을 기억해선 매번 초기화돼 다시 흔들린다 — 로딩·
// 성공·실패 어떤 상태든 바깥 박스 크기 자체가 절대 안 바뀌게 만들어 이 문제를 구조적으로 없앴다.
function AttachmentImage({ src, alt, projectFile, onOpenProjectFile }: { src: string; alt?: string; projectFile?: string | null; onOpenProjectFile?: (path: string) => void }): React.ReactElement {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="attachment-thumb-box attachment-thumb-broken">이미지를 불러올 수 없습니다{alt ? `: ${alt}` : ""}</span>;
  if (onOpenProjectFile && projectFile) return <button type="button" className="attachment-thumb-box attachment-thumb-link" onClick={() => onOpenProjectFile(projectFile)}>
    <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />
  </button>;
  return <a className="attachment-thumb-box attachment-thumb-link" href={src}><img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} /></a>;
}

// URL이 현재 프로젝트의 첨부 전용 읽기 API인지 확인한다.
function isAttachmentUrl(src: string, projectId: number | undefined): boolean {
  return !!projectId && src.startsWith(`/api/projects/${projectId}/attachments/content?`);
}

// Markdown 링크 중 현재 프로젝트 파일만 파일 탭으로 보내고 외부 링크는 새 탭으로 유지한다.
export function MessageBody({ content, projectId, projectPath, linkBasePath = "", onOpenProjectFile }: { content: string; projectId?: number; projectPath?: string; linkBasePath?: string; onOpenProjectFile?: (path: string) => void }): React.ReactElement {
  return <div className="message-body markdown-body">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        img: ({ src, alt }) => {
          const source = String(src);
          const projectFile = isAttachmentUrl(source, projectId) ? null : projectFilePathFromHref(source, projectPath, linkBasePath);
          return <AttachmentImage src={source} alt={alt} projectFile={projectFile} onOpenProjectFile={onOpenProjectFile} />;
        },
        a: ({ href, children }) => {
          const projectFile = href && isAttachmentUrl(href, projectId) ? null : projectFilePathFromHref(href, projectPath, linkBasePath);
          return projectFile !== null && onOpenProjectFile
            ? <a href={href} className="project-file-link" onClick={(event) => { event.preventDefault(); onOpenProjectFile(projectFile); }}>{children}</a>
            : <a href={href} target="_blank" rel="noreferrer">{children}</a>;
        },
      }}
    >
      {substituteAttachments(content, projectId)}
    </ReactMarkdown>
  </div>;
}
