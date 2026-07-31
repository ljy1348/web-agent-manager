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
});
