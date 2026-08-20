import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { attachmentUrl, isImagePath, MessageBody } from "../src/client/lib/attachments";

describe("첨부 이미지 판정·URL", () => {
  it("이미지 확장자만 미리보기 대상으로 판정한다", () => {
    expect(isImagePath("shot.png")).toBe(true);
    expect(isImagePath("dir/shot.JPEG")).toBe(true);
    expect(isImagePath("icon.svg")).toBe(false);
    expect(isImagePath("notes.txt")).toBe(false);
    expect(isImagePath("archive.zip")).toBe(false);
  });

  it("채팅 첨부 전용 API URL을 만들고 다운로드 여부를 명시한다", () => {
    expect(attachmentUrl(7, ".web-agent-manager-uploads/12/shot 1.png")).toBe(
      "/api/projects/7/attachments/content?path=.web-agent-manager-uploads%2F12%2Fshot%201.png",
    );
    expect(attachmentUrl(7, ".web-agent-manager-uploads/12/report.pdf", true)).toBe(
      "/api/projects/7/attachments/content?path=.web-agent-manager-uploads%2F12%2Freport.pdf&download=1",
    );
  });

  it("이미지가 아닌 첨부는 파일 탭 우회 없이 전용 다운로드 링크로 렌더링한다", () => {
    const html = renderToStaticMarkup(React.createElement(MessageBody, {
      content: "[첨부: .web-agent-manager-uploads/12/report.pdf]",
      projectId: 7,
      projectPath: "/home/testuser/web-agent-manager",
      onOpenProjectFile: () => undefined,
    }));
    expect(html).not.toContain('class="project-file-link"');
    expect(html).toContain("/api/projects/7/attachments/content?path=.web-agent-manager-uploads%2F12%2Freport.pdf&amp;download=1");
  });

  it("프로젝트 상대·절대 이미지 첨부를 현재 채팅 작업공간의 미리보기 URL로 렌더링한다", () => {
    const html = renderToStaticMarkup(React.createElement(MessageBody, {
      content: "[첨부: artifacts/relative shot.png]\n[첨부: /home/testuser/web-agent-manager/artifacts/absolute.png]",
      projectId: 7,
      projectPath: "/home/testuser/web-agent-manager",
      chatId: 199,
      onOpenProjectFile: () => undefined,
    }));
    expect(html).toContain("/api/projects/7/files/content/artifacts/relative%20shot.png?chatId=199");
    expect(html).toContain("/api/projects/7/files/content/artifacts/absolute.png?chatId=199");
    expect(html.match(/attachment-thumb-link/g)).toHaveLength(2);
  });

  it("worktree와 공유 프로젝트의 절대 이미지 경로를 모두 현재 채팅 작업공간에서 연다", () => {
    const html = renderToStaticMarkup(React.createElement(MessageBody, {
      content: "![worktree](/tmp/worktrees/chat-9/artifacts/tree.png)\n![shared](/home/testuser/web-agent-manager/artifacts/shared.png)",
      projectId: 7,
      projectPath: "/home/testuser/web-agent-manager",
      workspacePath: "/tmp/worktrees/chat-9",
      chatId: 9,
      onOpenProjectFile: () => undefined,
    }));
    expect(html).toContain("/api/projects/7/files/content/artifacts/tree.png?chatId=9");
    expect(html).toContain("/api/projects/7/files/content/artifacts/shared.png?chatId=9");
  });

  it("프로젝트 밖 절대 첨부 경로는 파일 API로 노출하지 않는다", () => {
    const html = renderToStaticMarkup(React.createElement(MessageBody, {
      content: "[첨부: /etc/secret.png]",
      projectId: 7,
      projectPath: "/home/testuser/web-agent-manager",
      onOpenProjectFile: () => undefined,
    }));
    expect(html).not.toContain("/api/projects/7/files/content");
    expect(html).toContain("[첨부: /etc/secret.png]");
  });

  it("chat: 링크는 onOpenChat이 있을 때만 채팅 이동 링크로 렌더링하고 없으면 새 탭 외부 링크로 남긴다", () => {
    const withHandler = renderToStaticMarkup(React.createElement(MessageBody, {
      content: "[#42 다른 채팅](chat:42)",
      onOpenChat: () => undefined,
    }));
    expect(withHandler).toContain('href="chat:42"');
    expect(withHandler).toContain('class="project-file-link"');

    const withoutHandler = renderToStaticMarkup(React.createElement(MessageBody, {
      content: "[#42 다른 채팅](chat:42)",
    }));
    expect(withoutHandler).toContain('href="chat:42"');
    expect(withoutHandler).toContain('target="_blank"');
    expect(withoutHandler).not.toContain('class="project-file-link"');
  });

  it("파일 미리보기 줄 링크(#L줄번호)는 프로젝트 파일 링크로 인식되어 새 탭이 아닌 파일 탭 이동 링크로 렌더링된다", () => {
    const html = renderToStaticMarkup(React.createElement(MessageBody, {
      content: "[src/client/main.tsx:3](src/client/main.tsx#L3)",
      projectId: 7,
      projectPath: "/home/testuser/web-agent-manager",
      onOpenProjectFile: () => undefined,
    }));
    expect(html).toContain('class="project-file-link"');
    expect(html).toContain('href="src/client/main.tsx#L3"');
    expect(html).not.toContain('target="_blank"');
  });
});
