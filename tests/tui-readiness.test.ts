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

  // Codex 0.148.0에서 도입된 고정 문구. 이걸 모르면 isReady가 항상 false가 되어, isReady를 거치는
  // 초기화 고정(keepalive)만 조용히 막힌다 — 사용량 조회는 isReady를 안 거쳐 멀쩡히 도는 탓에
  // 원인을 찾기 어려웠다(실측 #59: 준비 대기를 90초로 늘려도 실패, 문구를 추가하니 0초에 통과).
  it("Codex 0.148.0의 새 입력창 문구도 빈 입력창으로 본다", () => {
    const screen = `
╭───────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.148.0)                │
│ model:     gpt-5.6-sol   /model to change │
╰───────────────────────────────────────────╯
• You have 1 usage limit reset available. Run /usage to use one.
› Ask Codex to do anything

  gpt-5.6-sol default · /home/ubuntu/myagent`;
    expect(codex.isReady(screen)).toBe(true);
  });

  it("Codex resume·MCP 부팅 화면은 composer가 보여도 초기화 중으로 구분한다", () => {
    expect(codex.isInitializing?.(`
  Resuming session…
› 아직 제출되지 않은 질문
`)).toBe(true);
    expect(codex.isInitializing?.(`
• Booting MCP server: codex_apps (0s • esc to interrupt)
› 아직 제출되지 않은 질문
`)).toBe(true);
    expect(codex.isInitializing?.("› Ask Codex to do anything")).toBe(false);
  });

  it("Codex 프롬프트에 사용자가 입력 중인 내용이 있으면 준비 상태로 보지 않는다", () => {
    const screen = `
• 이전 응답입니다.

› 아직 제출하지 않은 터미널 입력

  gpt-5.5 high · /home/testuser/web-agent-manager`;
    expect(codex.isReady(screen)).toBe(false);
    expect(codex.readPromptDraft(screen)).toBe("아직 제출하지 않은 터미널 입력");
  });

  it("Codex가 순환 표시하는 다른 placeholder 문구도 빈 입력창으로 본다", () => {
    const screen = `
• 이전 응답입니다.

› Use /skills to list available skills

  gpt-5.5 high · /home/testuser/web-agent-manager`;
    expect(codex.isReady(screen)).toBe(true);
    expect(codex.readPromptDraft(screen)).toBe("");
  });

  it("Codex 번호 선택 메뉴는 미전송 입력창으로 오인하지 않는다", () => {
    const screen = [
      "Do you want to proceed?",
      "› 1. Yes, continue",
      "  2. No, quit",
      "Press enter to confirm or esc to go back",
    ].join("\n");
    expect(codex.readPromptDraft(screen)).toBeNull();
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

  it("상태줄이 tmux 상태바에 밀려 잘려도 진행 스피너 줄로 busy를 감지한다", () => {
    // 서버는 tmux를 직접 캡처하지 않고 자체 화면 버퍼(TerminalScreen, DEFAULT_ROWS=36)를 읽는데, 실제
    // pane은 다른 tmux 클라이언트가 attach되면 그 크기(실측 31행)로 줄어든다. 그러면 버퍼 아래쪽에
    // tmux 상태바가 들어오면서 Claude 하단 상태줄(esc to interrupt)이 통째로 밀려 사라져, 작업 중인데도
    // busy가 풀렸다(실측: 화면 25회 연속 샘플링 내내 작업 중인데 서버 판정은 isBusy=false).
    const screen = [
      "✻ Crunched for 8m 1s · done 10:35 AM",
      "❯ 우선은 클로드 작업중 이상 먼저 수정하고,",
      "  코덱스는 변경된게 맞아, 그리고 클로드랑 코덱스 둘 다 cli 바이너리 확인해서",
      "* Cogitating…",
      "──────────────────────────",
      "❯",
      "──────────────────────────",
      "[web_agent0:claude*",
    ].join("\n");
    expect(claude.isBusy(screen)).toBe(true);
  });

  it("턴이 끝난 요약 줄만 남은 화면은 스피너로 오인하지 않는다", () => {
    // 완료 줄은 "…"가 없고 "· done"으로 끝난다. 스피너 신호를 추가하면서 이 줄까지 busy로 읽으면
    // 응답이 끝난 뒤에도 작업중 표시가 영영 안 풀린다.
    const screen = [
      "✻ Churned for 58s · done 9:14 AM",
      "──────────────────────────",
      "❯",
      "──────────────────────────",
      "  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent",
    ].join("\n");
    expect(claude.isBusy(screen)).toBe(false);
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

  // 채팅 #257에서 실제로 겪은 교착이다. 입력창에 미전송 글자가 남으면 isReady·isBusy가 동시에 false가
  // 되어 준비 대기가 15초마다 타임아웃하고 상태를 다시 error로 덮어써, 웹에서 복구할 방법이 없었다.
  // readPromptDraft는 그 초안을 읽어내 "입력창은 있다"는 사실과 지울 글자 수를 함께 알려준다.
  it("입력창에 미전송 초안이 남아 있으면 그 텍스트를 읽어낸다", () => {
    const screen = [
      "✻ Brewed for 13m 15s",
      "──────────────────────────",
      "❯ backend 복구해줘",
      "──────────────────────────",
      "  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent",
    ].join("\n");
    expect(claude.isReady(screen)).toBe(false);
    expect(claude.isBusy(screen)).toBe(false);
    expect(claude.readPromptDraft(screen)).toBe("backend 복구해줘");
  });

  it("빈 입력창은 지울 초안이 없는 빈 문자열로 본다", () => {
    const screen = [
      "──────────────────────────",
      "❯ ",
      "──────────────────────────",
      "  ⏵⏵ auto mode on (shift+tab to cycle)",
    ].join("\n");
    expect(claude.readPromptDraft(screen)).toBe("");
  });

  it("입력창이 없는 선택 메뉴 화면은 null로 구분해 채팅 입력을 흘려보내지 않는다", () => {
    const screen = [
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. No, and tell Claude what to do differently",
    ].join("\n");
    expect(claude.readPromptDraft(screen)).toBeNull();
  });
});
