import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../src/server/providers/codex";
import { ClaudeAdapter } from "../src/server/providers/claude";

const codex = new CodexAdapter();
const claude = new ClaudeAdapter("/tmp/claude-settings.json", {});

describe("TUI 입력 가능 상태 판정", () => {
  it("Codex 현재 입력 프롬프트가 비어 있으면 준비 상태로 본다", () => {
    const screen = `
• 이전 응답입니다.

› Run /review on my current changes

  gpt-5.5 high · /home/testuser/web-agent-manager`;
    expect(codex.isReady(screen)).toBe(true);
  });

  it("Codex 프롬프트에 사용자가 입력 중인 내용이 있으면 준비 상태로 보지 않는다", () => {
    const screen = `
• 이전 응답입니다.

› 아직 제출하지 않은 터미널 입력

  gpt-5.5 high · /home/testuser/web-agent-manager`;
    expect(codex.isReady(screen)).toBe(false);
  });

  it("Codex가 순환 표시하는 다른 placeholder 문구도 빈 입력창으로 본다", () => {
    const screen = `
• 이전 응답입니다.

› Use /skills to list available skills

  gpt-5.5 high · /home/testuser/web-agent-manager`;
    expect(codex.isReady(screen)).toBe(true);
  });

  it("Codex 작업중 상태 영역이 보이면 프롬프트가 있어도 준비 상태로 보지 않는다", () => {
    const screen = `
• 파일을 읽는 중입니다.

› Run /review on my current changes

  Esc to interrupt · gpt-5.5 high`;
    expect(codex.isReady(screen)).toBe(false);
  });

  it("Codex 작업중 상태 영역을 busy 상태로 감지한다", () => {
    const screen = `
› Summarize recent commits

  gpt-5.5 high · /home/testuser/web-agent-manager

  Working (23s • esc to interrupt)`;
    expect(codex.isBusy(screen)).toBe(true);
  });

  it("Codex 작업중 상태 영역이 프롬프트 위에 있어도 busy로 감지한다", () => {
    const screen = `
◦ Working (57s • esc to interrupt)

› Write tests for @filename

  gpt-5.5 medium · /home/testuser/web-agent-manager`;
    expect(codex.isBusy(screen)).toBe(true);
    expect(codex.isReady(screen)).toBe(false);
  });

  it("Claude shell 프롬프트는 기존 규칙대로 준비 상태로 본다", () => {
    expect(claude.isReady("\n$ ")).toBe(true);
  });

  it("Claude가 dim 스타일로 채운 다음 질문 제안은 빈 입력창으로 본다", () => {
    const screen = [
      "✻ Sautéed for 1m 10s",
      "──────────────────────────",
      "\u001b[39m❯\u00a0\u001b[2m2, 4, 5번도 다시 훑어봐\u001b[0m",
      "──────────────────────────",
      "  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent",
    ].join("\n");
    expect(claude.isReady(screen)).toBe(true);
  });

  it("Claude 입력창의 실제 미전송 입력은 준비 상태로 보지 않는다", () => {
    expect(claude.isReady("\u001b[39m❯\u00a0직접 입력한 문장\u001b[0m")).toBe(false);
  });

  it("Claude 실제 입력 뒤에 dim 자동완성만 붙은 경우도 준비 상태로 보지 않는다", () => {
    expect(claude.isReady("\u001b[39m❯\u00a0직접 입력\u001b[2m 뒤 자동완성\u001b[0m")).toBe(false);
  });

  it("Claude가 응답 생성 중이면 $ 프롬프트가 있어도 준비 상태로 보지 않는다", () => {
    const screen = `
- 39: 합성수 — 3×13=39로 3이 약수입니다.
auto mode on (shift+tab to cycle)  ·  esc to interrupt
$`;
    expect(claude.isReady(screen)).toBe(false);
    expect(claude.isBusy(screen)).toBe(true);
  });

  it("응답이 끝난 뒤 오래된 버퍼에 남은 esc to interrupt 문구는 준비 상태 판정에 영향을 주지 않는다", () => {
    // waitUntilReady는 최근 4000자의 누적 버퍼와 현재 스냅샷을 합쳐서 검사하는데, 그 누적 버퍼 안에는
    // 방금 끝난 응답이 생성되는 동안 계속 떠 있던 "esc to interrupt" 문구가 그대로 남아 있다. 마지막
    // $ 프롬프트 바로 앞 몇 줄만 봐야 하고, 그보다 앞선 오래된 버퍼는 무시해야 한다.
    const staleBusyBuffer = "auto mode on (shift+tab to cycle)  ·  esc to interrupt\n".repeat(50);
    const currentIdleSnapshot = "정리하면 다음과 같습니다.\nCooked for 24s\nauto mode on (shift+tab to cycle)\n$";
    expect(claude.isReady(`${staleBusyBuffer}${currentIdleSnapshot}`)).toBe(true);
  });

  it("esc to interrupt 상태줄이 입력창 프롬프트보다 아래에 있어도 busy로 감지한다", () => {
    // 최신 Claude TUI는 작업 중에도 빈 입력창(❯)이 계속 떠 있고, "esc to interrupt" 상태줄은
    // 그 입력창 테두리 "아래"에 온다(실제 서버에서 tmux capture-pane으로 재현·확인함). 프롬프트
    // 줄까지만 보고 자르면 이 상태줄을 놓쳐 작업중인데도 준비 상태로 오판했다.
    const screen = [
      "✽ Synthesizing… (2m 29s · ↓ 9.7k tokens)",
      "──────────────────────────",
      "❯ ",
      "──────────────────────────",
      "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← 1 agent",
    ].join("\n");
    expect(claude.isBusy(screen)).toBe(true);
    expect(claude.isReady(screen)).toBe(false);
  });

  it("도구 실행 중이라 입력창 자체가 안 보여도, pane 하단 빈 줄 패딩에 가려지지 않고 busy로 감지한다", () => {
    // tmux capture-pane은 항상 고정 행 수(36행)를 반환하는데, 도구 실행 화면처럼 프롬프트 줄이 아예
    // 안 보이는 경우 실제 내용 아래로 빈 줄이 잔뜩 남는다. 이 빈 줄들이 "마지막 N줄" 판정에 섞이면
    // 위쪽의 실제 "esc to interrupt" 표시를 놓쳐 작업중으로 감지되지 않는 문제가 실제로 있었다.
    const content = "⏺ Bash(long running command)\n  esc to interrupt";
    const paddedPane = `${content}${"\n".repeat(20)}`;
    expect(claude.isBusy(paddedPane)).toBe(true);
    expect(claude.isReady(paddedPane)).toBe(false);
  });
});
