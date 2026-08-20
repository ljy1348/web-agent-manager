import React, { useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { projectFileContentUrl, projectFilePathFromHref } from "./file-links";

// 업로드 첨부 참조 표시("[첨부: 경로]")와 이미지 확장자 판정에 쓰는 공통 규칙.
const ATTACHMENT_MARKER = /\[첨부: ([^\]]+)\]/g;
const STORED_ATTACHMENT_PATH = /^\.(?:web-agent-manager|myagent)-uploads\/[1-9]\d*\/[^/]+$/;
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|bmp)$/i;
// 채팅 입력창의 "#채팅" 멘션이 삽입하는 pseudo-scheme 링크(chat:번호). 프로젝트가 달라도 그 채팅으로 바로 이동시킨다.
const CHAT_LINK = /^chat:(\d+)$/;
// 파일 미리보기의 줄 링크가 삽입하는 "경로#L줄번호" 프래그먼트. cleanLinkedPath가 경로 판정 전에
// 프래그먼트를 이미 잘라내므로 원본 href에서 별도로 읽어야 특정 줄로 이동시킬 수 있다.
const LINE_FRAGMENT = /#L(\d+)$/;

// 첨부 경로가 브라우저가 바로 그릴 수 있는 이미지 형식인지 확인한다.
export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSION.test(path);
}

// 채팅·프로젝트 소속을 검증하는 첨부 전용 API URL을 만든다.
export function attachmentUrl(projectId: number, path: string, download = false): string {
  return `/api/projects/${projectId}/attachments/content?path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`;
}

// 현재 작업공간과 공유 프로젝트 루트 중 하나에 속하는 메시지 파일 경로를 상대경로로 바꾼다.
function messageProjectFile(path: string | undefined, projectPath?: string, workspacePath?: string, relativeTo = ""): string | null {
  const workspaceFile = projectFilePathFromHref(path, workspacePath || projectPath, relativeTo);
  if (workspaceFile !== null) return workspaceFile;
  return workspacePath && workspacePath !== projectPath ? projectFilePathFromHref(path, projectPath, relativeTo) : null;
}

// 마크다운 링크 목적지에서 공백·괄호 등이 문법으로 오인되지 않도록 경로 세그먼트를 인코딩한다.
function markdownFileHref(filePath: string): string {
  return filePath.split("/").map(encodeURIComponent).join("/");
}

// 메시지 본문의 "[첨부: 경로]"를 저장 첨부 API 또는 프로젝트 파일 미리보기로 변환한다.
function substituteAttachments(content: string, projectId?: number, projectPath?: string, workspacePath?: string, relativeTo = ""): string {
  if (!projectId) return content;
  return content.replace(ATTACHMENT_MARKER, (marker, attachedPath: string) => {
    if (STORED_ATTACHMENT_PATH.test(attachedPath)) return isImagePath(attachedPath)
      ? `![${attachedPath}](${attachmentUrl(projectId, attachedPath)})`
      : `[첨부: ${attachedPath}](${attachmentUrl(projectId, attachedPath, true)})`;
    const projectFile = messageProjectFile(attachedPath, projectPath, workspacePath, relativeTo);
    if (projectFile === null) return marker;
    const href = markdownFileHref(projectFile);
    return isImagePath(projectFile) ? `![${attachedPath}](${href})` : `[첨부: ${attachedPath}](${href})`;
  });
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
function AttachmentImage({ src, alt, projectFile, onOpenProjectFile }: { src: string; alt?: string; projectFile?: string | null; onOpenProjectFile?: (path: string, line?: number) => void }): React.ReactElement {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="attachment-thumb-box attachment-thumb-broken">이미지를 불러올 수 없습니다{alt ? `: ${alt}` : ""}</span>;
  if (onOpenProjectFile && projectFile) return <button type="button" className="attachment-thumb-box attachment-thumb-link" onClick={() => onOpenProjectFile(projectFile)}>
    <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />
  </button>;
  return <a className="attachment-thumb-box attachment-thumb-link" href={src}><img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} /></a>;
}

// react-markdown은 XSS 방지를 위해 알 수 없는 URI scheme의 href를 기본적으로 빈 문자열로 지운다
// (defaultUrlTransform). "#채팅" 멘션이 쓰는 chat: pseudo-scheme만 예외로 통과시키고 나머지는 그대로
// 기본 정책을 따른다.
function urlTransform(value: string): string {
  return CHAT_LINK.test(value) ? value : defaultUrlTransform(value);
}

// URL이 현재 프로젝트의 첨부 전용 읽기 API인지 확인한다.
function isAttachmentUrl(src: string, projectId: number | undefined): boolean {
  return !!projectId && src.startsWith(`/api/projects/${projectId}/attachments/content?`);
}

// Markdown 링크 중 현재 프로젝트 파일만 파일 탭으로 보내고 외부 링크는 새 탭으로 유지한다.
export function MessageBody({ content, projectId, projectPath, workspacePath, chatId, linkBasePath = "", onOpenProjectFile, onOpenChat }: { content: string; projectId?: number; projectPath?: string; workspacePath?: string; chatId?: number | null; linkBasePath?: string; onOpenProjectFile?: (path: string, line?: number) => void; onOpenChat?: (chatId: number) => void }): React.ReactElement {
  return <div className="message-body markdown-body">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={urlTransform}
      components={{
        img: ({ src, alt }) => {
          const source = String(src ?? "");
          const projectFile = isAttachmentUrl(source, projectId) ? null : messageProjectFile(source, projectPath, workspacePath, linkBasePath);
          const imageSource = projectFile !== null && projectId ? projectFileContentUrl(projectId, projectFile, chatId) : source;
          return <AttachmentImage src={imageSource} alt={alt} projectFile={projectFile} onOpenProjectFile={onOpenProjectFile} />;
        },
        a: ({ href, children }) => {
          const chatMatch = href ? href.match(CHAT_LINK) : null;
          if (chatMatch && onOpenChat) {
            const targetChatId = Number(chatMatch[1]);
            return <a href={href} className="project-file-link" onClick={(event) => { event.preventDefault(); onOpenChat(targetChatId); }}>{children}</a>;
          }
          const projectFile = href && isAttachmentUrl(href, projectId) ? null : messageProjectFile(href, projectPath, workspacePath, linkBasePath);
          const lineMatch = href ? href.match(LINE_FRAGMENT) : null;
          return projectFile !== null && onOpenProjectFile
            ? <a href={href} className="project-file-link" onClick={(event) => { event.preventDefault(); onOpenProjectFile(projectFile, lineMatch ? Number(lineMatch[1]) : undefined); }}>{children}</a>
            : <a href={href} target="_blank" rel="noreferrer">{children}</a>;
        },
      }}
    >
      {substituteAttachments(content, projectId, projectPath, workspacePath, linkBasePath)}
    </ReactMarkdown>
  </div>;
}
