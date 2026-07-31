import { describe, expect, it } from "vitest";
import { projectFilePathFromHref } from "../src/client/lib/file-links";

describe("채팅 프로젝트 파일 링크", () => {
  it("프로젝트 절대 경로와 줄 번호를 상대 파일 경로로 바꾼다", () => {
    expect(projectFilePathFromHref("/home/testuser/web-agent-manager/src/client/main.tsx:403", "/home/testuser/web-agent-manager")).toBe("src/client/main.tsx");
    expect(projectFilePathFromHref("file:///home/testuser/web-agent-manager/README.md:12:3", "/home/testuser/web-agent-manager")).toBe("README.md");
  });

  it("프로젝트 상대 경로를 정규화한다", () => {
    expect(projectFilePathFromHref("./src/client/../server/index.ts#L10", "/home/testuser/web-agent-manager")).toBe("src/server/index.ts");
    expect(projectFilePathFromHref("../images/diagram.png", "/home/testuser/web-agent-manager", "docs/guide")).toBe("docs/images/diagram.png");
  });

  it("외부 URL과 프로젝트 밖 절대·상위 경로는 가로채지 않는다", () => {
    expect(projectFilePathFromHref("https://example.com/file.ts", "/home/testuser/web-agent-manager")).toBeNull();
    expect(projectFilePathFromHref("/home/testuser/other/file.ts", "/home/testuser/web-agent-manager")).toBeNull();
    expect(projectFilePathFromHref("../../etc/passwd", "/home/testuser/web-agent-manager")).toBeNull();
    expect(projectFilePathFromHref("#section", "/home/testuser/web-agent-manager")).toBeNull();
  });
});
