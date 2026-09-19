import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Docker 런타임 이미지 CLI", () => {
  it("Grok CLI를 Codex·Claude와 함께 전역 설치한다", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");
    expect(dockerfile).toMatch(/ARG GROK_VERSION=/);
    expect(dockerfile).toContain("@xai-official/grok@${GROK_VERSION}");
    expect(dockerfile).toContain("@openai/codex@${CODEX_VERSION}");
    expect(dockerfile).toContain("@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}");
  });
});
