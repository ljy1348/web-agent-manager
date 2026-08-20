import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareChatPrompt } from "../src/server/services/chat-prompt";
import { LONG_PROMPT_CHARACTER_THRESHOLD, promptCharacterCount } from "../src/shared/chat-prompt";

const roots: string[] = [];

// 테스트용 임시 프로젝트를 만들고 종료 뒤 정리 대상으로 등록한다.
function temporaryProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-prompt-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("장문 채팅 프롬프트", () => {
  it("1,000자 이하는 기존 본문을 그대로 전달한다", () => {
    const root = temporaryProject();
    const text = "가".repeat(LONG_PROMPT_CHARACTER_THRESHOLD);

    expect(prepareChatPrompt(41, root, root, text)).toMatchObject({ terminalText: text, attachmentPath: null });
  });

  it("1,000자를 넘으면 원문 파일과 짧은 첨부 참조를 만든다", () => {
    const root = temporaryProject();
    const text = `첫 줄\n${"나".repeat(LONG_PROMPT_CHARACTER_THRESHOLD)}`;
    const prepared = prepareChatPrompt(41, root, root, text);

    expect(prepared.attachmentPath).toMatch(/^\.web-agent-manager-uploads\/41\/\d+_[a-f0-9]{8}_pasted-text\.txt$/);
    expect(prepared.terminalText).toContain(`[첨부: ${prepared.attachmentPath}]`);
    expect(fs.readFileSync(path.join(root, prepared.attachmentPath!), "utf8")).toBe(text);
  });

  it("전용 worktree에도 같은 상대경로와 원문을 저장한다", () => {
    const project = temporaryProject();
    const workspace = temporaryProject();
    const text = "x".repeat(LONG_PROMPT_CHARACTER_THRESHOLD + 1);
    const prepared = prepareChatPrompt(42, project, workspace, text);

    expect(fs.readFileSync(path.join(project, prepared.attachmentPath!), "utf8")).toBe(text);
    expect(fs.readFileSync(path.join(workspace, prepared.attachmentPath!), "utf8")).toBe(text);
  });

  it("슬래시·셸 명령은 길어도 명령 의미를 보존한다", () => {
    const root = temporaryProject();
    for (const prefix of ["/", "!"]) {
      const text = `${prefix}${"x".repeat(LONG_PROMPT_CHARACTER_THRESHOLD + 1)}`;
      expect(prepareChatPrompt(43, root, root, text)).toMatchObject({ terminalText: text, attachmentPath: null });
    }
  });

  it("한글과 이모지는 UTF-16 단위가 아닌 문자 수로 센다", () => {
    expect(promptCharacterCount("가😀나")).toBe(3);
  });

  it("첨부 디렉터리 symlink로 프로젝트 밖에 쓰지 못한다", () => {
    const root = temporaryProject();
    const outside = temporaryProject();
    fs.symlinkSync(outside, path.join(root, ".web-agent-manager-uploads"));

    expect(() => prepareChatPrompt(44, root, root, "x".repeat(LONG_PROMPT_CHARACTER_THRESHOLD + 1)))
      .toThrow("프로젝트 경로를 벗어났습니다.");
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
