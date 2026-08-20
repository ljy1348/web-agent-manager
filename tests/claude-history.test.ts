import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeAdapter } from "../src/server/providers/claude";
import type { TmuxIO } from "../src/server/providers/provider";
import { USAGE_KEEPALIVE_PROMPT } from "../src/shared/usage-keepalive";

// ~/.claude/sessions/<pid>.json을 임시 디렉터리로 흉내내기 위해 os.homedir()을 잠깐 바꿔치기한다.
function withFakeClaudeSessionsDir(entries: Record<string, unknown>[]): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-home-"));
  fs.mkdirSync(path.join(home, ".claude", "sessions"), { recursive: true });
  entries.forEach((entry, index) => {
    fs.writeFileSync(path.join(home, ".claude", "sessions", `${index}.json`), JSON.stringify(entry));
  });
  vi.spyOn(os, "homedir").mockReturnValue(home);
}

// Claude API 프로토콜은 도구 실행 결과를 "user" 역할 턴으로 되돌려주므로,
// 실제 사람이 입력한 메시지와 구분되는지 검증한다.
function writeFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-history-"));
  const file = path.join(dir, "session.jsonl");
  const lines = [
    { type: "user", sessionId: "s1", cwd: "/home/testuser/web-agent-manager", message: { content: "ㅎㅇ" }, timestamp: "2026-07-06T00:00:00.000Z" },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "git status" } }] }, timestamp: "2026-07-06T00:00:01.000Z" },
    { type: "user", message: { content: [{ tool_use_id: "t1", type: "tool_result", content: "on branch main" }] }, timestamp: "2026-07-06T00:00:02.000Z" },
    { type: "assistant", message: { content: [{ type: "text", text: "확인했습니다." }] }, timestamp: "2026-07-06T00:00:03.000Z" },
  ];
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"));
  return file;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Claude 세션 기록 파싱", () => {
  it("상태 조회 전용 실행은 인증과 내장 명령만 남기는 경량 모드를 사용한다", () => {
    const adapter = new ClaudeAdapter("/tmp/settings.json", { WAM_HOOK: "enabled" });
    expect(adapter.createMonitorLaunch("/tmp")).toEqual({ command: "claude", args: ["--safe-mode", "--ax-screen-reader"] });
    expect(adapter.createLaunch("/tmp").args).toEqual(["--settings", "/tmp/settings.json"]);
    expect(adapter.promptQuirks).toMatchObject({ pasteSubmitDelayMs: 160, verifyPromptSubmission: true });
    // /usage 화면이 열린 채로 다음 주기에 다시 /usage를 보내면 무시돼 값이 영원히 굳는다(실측) — 다음 조회 전에 닫아야 한다.
    expect(adapter.usageScreenCloseInput).toBe("\u001b");
  });

  it("도구 실행 결과 턴을 user가 아닌 tool 역할로 분류한다", () => {
    const session = new ClaudeAdapter("", {}).parseHistoryFile(writeFixture());
    expect(session?.messages.map((message) => ({ role: message.role, kind: message.kind }))).toEqual([
      { role: "user", kind: "text" },
      { role: "assistant", kind: "tool_call" },
      { role: "tool", kind: "tool_result" },
      { role: "assistant", kind: "text" },
    ]);
  });

  it("제목은 실제 사용자 메시지에서만 뽑는다", () => {
    const session = new ClaudeAdapter("", {}).parseHistoryFile(writeFixture());
    expect(session?.title).toBe("ㅎㅇ");
  });

  it("/exit 같은 로컬 명령 실행과 결과 출력은 user가 아닌 system 역할로 분류한다", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-history-"));
    const file = path.join(dir, "session.jsonl");
    const lines = [
      { type: "user", sessionId: "s1", cwd: "/home/testuser/web-agent-manager", message: { content: "ㅎㅇ" }, timestamp: "2026-07-06T00:00:00.000Z" },
      { type: "user", content: "<command-name>/exit</command-name>\n<command-message>exit</command-message>\n<command-args></command-args>", timestamp: "2026-07-06T00:00:01.000Z" },
      { type: "user", content: "<local-command-stdout>Bye!</local-command-stdout>", timestamp: "2026-07-06T00:00:02.000Z" },
    ];
    fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"));
    const session = new ClaudeAdapter("", {}).parseHistoryFile(file);
    expect(session?.messages.map((message) => ({ role: message.role, kind: message.kind }))).toEqual([
      { role: "user", kind: "text" },
      { role: "system", kind: "local_command" },
      { role: "system", kind: "local_command" },
    ]);
  });

  it("서브에이전트(Task) 완료 알림은 user가 아니라 system 역할로 분류한다", () => {
    // 백그라운드 서브에이전트나 백그라운드 명령이 끝나면 그 결과가 tool_result가 아니라 순수 텍스트로
    // "user" 역할 턴에 주입된다(실제 사람이 입력한 게 아니라 하네스가 비동기로 알려주는 완료 통지).
    // 실제 chat_72 세션에서 재현·확인된 형태 그대로 고정한다.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-history-"));
    const file = path.join(dir, "session.jsonl");
    const lines = [
      { type: "user", sessionId: "s1", cwd: "/home/testuser/web-agent-manager", message: { content: "조사해줘" }, timestamp: "2026-07-06T00:00:00.000Z" },
      {
        type: "user",
        message: { content: "<task-notification>\n<task-id>abc123</task-id>\n<status>completed</status>\n<result>조사 결과입니다.</result>\n</task-notification>" },
        timestamp: "2026-07-06T00:00:01.000Z",
      },
    ];
    fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"));
    const session = new ClaudeAdapter("", {}).parseHistoryFile(file);
    expect(session?.messages.map((message) => ({ role: message.role, kind: message.kind }))).toEqual([
      { role: "user", kind: "text" },
      { role: "system", kind: "task_notification" },
    ]);
  });

  it("compact 자동 요약 턴은 user가 아니라 system 역할로 분류한다", () => {
    // /compact나 컨텍스트 한도 초과로 자동 압축이 실행되면, CLI가 그 요약 전체를 다음 턴을 잇기 위한
    // "user" 역할 턴으로 주입한다 — isCompactSummary 플래그가 없으면 실제 사람이 그 긴 요약문을 통째로
    // 직접 친 것처럼 채팅 말풍선에 보였다(실사용 보고로 확인, chat 125에서 재현).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-history-"));
    const file = path.join(dir, "session.jsonl");
    const lines = [
      { type: "user", sessionId: "s1", cwd: "/home/testuser/web-agent-manager", message: { content: "긴 대화 이어가자" }, timestamp: "2026-07-06T00:00:00.000Z" },
      {
        type: "user",
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
        message: { role: "user", content: "This session is being continued from a previous conversation that ran out of context. Summary: ..." },
        timestamp: "2026-07-06T00:00:01.000Z",
      },
    ];
    fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"));
    const session = new ClaudeAdapter("", {}).parseHistoryFile(file);
    expect(session?.messages.map((message) => ({ role: message.role, kind: message.kind }))).toEqual([
      { role: "user", kind: "text" },
      { role: "system", kind: "compact_summary" },
    ]);
  });

  it("assistant 응답에 기록된 모델 id를 세션의 현재 모델로 읽는다", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-history-"));
    const file = path.join(dir, "session.jsonl");
    const lines = [
      { type: "user", sessionId: "s1", cwd: "/home/testuser/web-agent-manager", message: { content: "ㅎㅇ" }, timestamp: "2026-07-06T00:00:00.000Z" },
      { type: "assistant", message: { content: [{ type: "text", text: "안녕하세요" }], model: "claude-sonnet-5" }, timestamp: "2026-07-06T00:00:01.000Z" },
    ];
    fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"));
    const session = new ClaudeAdapter("", {}).parseHistoryFile(file);
    expect(session?.model).toBe("Sonnet 5");
  });

  it("assistant 응답의 입력·캐시·출력 토큰 사용량을 보존한다", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-history-"));
    const file = path.join(dir, "session.jsonl");
    const lines = [
      { type: "user", sessionId: "s1", cwd: "/home/testuser/web-agent-manager", message: { content: "ㅎㅇ" }, timestamp: "2026-07-06T00:00:00.000Z" },
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "1" }],
          usage: { input_tokens: 2, cache_creation_input_tokens: 6519, cache_read_input_tokens: 13740, output_tokens: 3 },
        },
        timestamp: "2026-07-06T00:00:01.000Z",
      },
    ];
    fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"));

    expect(new ClaudeAdapter("", {}).parseHistoryFile(file)?.messages.at(-1)?.tokenUsage).toEqual({
      inputTokens: 2,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 6519,
      cacheReadInputTokens: 13740,
      outputTokens: 3,
      reasoningOutputTokens: 0,
      totalTokens: 20264,
    });
  });

  it("Claude assistant end_turn은 완료 판정용 kind로 표시한다", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-history-"));
    const file = path.join(dir, "session.jsonl");
    const lines = [
      { type: "user", sessionId: "s1", cwd: "/home/testuser/web-agent-manager", message: { content: "ㅎㅇ" }, timestamp: "2026-07-06T00:00:00.000Z" },
      { type: "assistant", message: { content: [{ type: "text", text: "완료" }], stop_reason: "end_turn" }, timestamp: "2026-07-06T00:00:01.000Z" },
    ];
    fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"));
    const session = new ClaudeAdapter("", {}).parseHistoryFile(file);
    expect(session?.messages.at(-1)?.kind).toBe("turn_end");
  });

  it("Claude assistant 메시지에 도구 호출 블록이 있으면 end_turn이어도 완료로 보지 않는다", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-history-"));
    const file = path.join(dir, "session.jsonl");
    const lines = [
      { type: "user", sessionId: "s1", cwd: "/home/testuser/web-agent-manager", message: { content: "확인해줘" }, timestamp: "2026-07-06T00:00:00.000Z" },
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Task", input: { description: "조사" } }], stop_reason: "end_turn" },
        timestamp: "2026-07-06T00:00:01.000Z",
      },
    ];
    fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"));
    const session = new ClaudeAdapter("", {}).parseHistoryFile(file);
    expect(session?.messages.at(-1)?.kind).toBe("tool_call");
  });

  it("Claude가 대화 중 계속 갱신하는 aiTitle 중 가장 최근 값을 displayTitle로 읽는다", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-history-"));
    const file = path.join(dir, "session.jsonl");
    const lines = [
      { type: "user", sessionId: "s1", cwd: "/home/testuser/web-agent-manager", message: { content: "인터넷 검색으로 프로젝트 수요 좀 체크해봐" }, aiTitle: "프로젝트 수요 조사 준비", timestamp: "2026-07-06T00:00:00.000Z" },
      { type: "assistant", message: { content: [{ type: "text", text: "확인해볼게요" }] }, aiTitle: "프로젝트 시장 수요 조사", timestamp: "2026-07-06T00:00:01.000Z" },
    ];
    fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"));
    const session = new ClaudeAdapter("", {}).parseHistoryFile(file);
    expect(session?.displayTitle).toBe("프로젝트 시장 수요 조사");
    expect(session?.title).toBe("인터넷 검색으로 프로젝트 수요 좀 체크해봐");
  });

  it("aiTitle이 없는 세션은 displayTitle이 null이라 원래 첫 메시지 제목만 쓴다", () => {
    const session = new ClaudeAdapter("", {}).parseHistoryFile(writeFixture());
    expect(session?.displayTitle).toBeNull();
  });

  it("nameSource가 derived(자동 생성 기본값)인 CLI 표시 이름은 폴더명 반복이라 무시하고 aiTitle을 쓴다", () => {
    const file = writeFixture();
    withFakeClaudeSessionsDir([
      { sessionId: "s1", name: "web-agent-manager-50", nameSource: "derived", kind: "interactive", updatedAt: 1 },
    ]);
    fs.appendFileSync(file, `\n${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "네" }] }, aiTitle: "인사 나누기", timestamp: "2026-07-06T00:00:01.000Z" })}`);
    const session = new ClaudeAdapter("", {}).parseHistoryFile(file);
    expect(session?.displayTitle).toBe("인사 나누기");
  });

  it("실제로 /rename한 CLI 표시 이름(nameSource 없음)은 aiTitle보다 우선한다", () => {
    const file = writeFixture();
    withFakeClaudeSessionsDir([
      { sessionId: "s1", name: "test", kind: "interactive", updatedAt: 1 },
    ]);
    fs.appendFileSync(file, `\n${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "네" }] }, aiTitle: "인사 나누기", timestamp: "2026-07-06T00:00:01.000Z" })}`);
    const session = new ClaudeAdapter("", {}).parseHistoryFile(file);
    expect(session?.displayTitle).toBe("test");
  });

  it("백그라운드 작업(kind:bg)의 name은 세션 이름이 아니라 작업 설명이라 무시한다", () => {
    const file = writeFixture();
    withFakeClaudeSessionsDir([
      { sessionId: "s1", name: "14003으로 변경", kind: "bg", updatedAt: 1 },
    ]);
    const session = new ClaudeAdapter("", {}).parseHistoryFile(file);
    expect(session?.displayTitle).toBeNull();
  });

  it("사용자 대화가 없는 Claude 상태 조회용 JSONL은 세션으로 등록하지 않는다", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-history-"));
    const file = path.join(dir, "session.jsonl");
    const lines = [
      { type: "summary", sessionId: "s1", cwd: "/home/testuser/web-agent-manager", summary: "web-agent-manager" },
      { type: "system", sessionId: "s1", cwd: "/home/testuser/web-agent-manager", content: "Claude Code" },
    ];
    fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"));
    expect(new ClaudeAdapter("", {}).parseHistoryFile(file)).toBeNull();
  });

  it("로컬 명령만 있는 Claude 기록은 빈 채팅으로 등록하지 않고 숨김 처리한다", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-history-"));
    const file = path.join(dir, "session.jsonl");
    const lines = [
      { type: "mode", sessionId: "s1" },
      { type: "permission-mode", sessionId: "s1" },
      { type: "system", subtype: "local_command", sessionId: "s1", cwd: "/home/testuser/web-agent-manager", content: "<command-name>/status</command-name>\n<command-message>status</command-message>\n<command-args></command-args>" },
      { type: "system", subtype: "local_command", sessionId: "s1", cwd: "/home/testuser/web-agent-manager", content: "<local-command-stdout>web-agent-manager</local-command-stdout>" },
      { type: "last-prompt", sessionId: "s1" },
    ];
    fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"));
    const adapter = new ClaudeAdapter("", {});
    expect(adapter.parseHistoryFile(file)).toBeNull();
    expect(adapter.isHiddenHistoryFile(file)).toBe(true);
  });

  it("사용량 창 활성화 단답 기록은 일반 채팅으로 등록하지 않는다", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-history-"));
    const file = path.join(dir, "session.jsonl");
    const lines = [
      { type: "user", sessionId: "usage-keepalive", cwd: "/home/testuser/web-agent-manager", message: { content: USAGE_KEEPALIVE_PROMPT } },
      { type: "assistant", sessionId: "usage-keepalive", cwd: "/home/testuser/web-agent-manager", message: { content: "1", stop_reason: "end_turn" } },
    ];
    fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"));

    expect(new ClaudeAdapter("", {}).isHiddenHistoryFile(file)).toBe(true);
  });

  it("숨김 판정 캐시는 파일이 갱신되어 실제 대화가 생기면 다시 검사해 숨김을 푼다", () => {
    // 판정이 파일 내용 전체를 읽는 비싼 연산이라 mtime 기반으로 캐시하는데, 캐시 때문에 로컬 명령
    // 전용이던 기록이 나중에 실제 대화로 이어졌을 때 숨김이 안 풀리면 안 된다.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-history-"));
    const file = path.join(dir, "session.jsonl");
    fs.writeFileSync(file, JSON.stringify({ type: "system", subtype: "local_command", sessionId: "s1", content: "<command-name>/status</command-name>" }));
    const adapter = new ClaudeAdapter("", {});
    expect(adapter.isHiddenHistoryFile(file)).toBe(true);
    const userLine = JSON.stringify({ type: "user", sessionId: "s1", cwd: "/tmp", message: { content: "ㅎㅇ" }, timestamp: "2026-07-06T00:00:00.000Z" });
    fs.appendFileSync(file, `\n${userLine}`);
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    expect(adapter.isHiddenHistoryFile(file)).toBe(false);
    // 실제 대화로 확정된 뒤에는 캐시가 영구 false를 반환한다(파일을 다시 읽지 않음).
    expect(adapter.isHiddenHistoryFile(file)).toBe(false);
  });

  it("선택 메뉴 없이 스크롤백에 남은 한도 문구만으로는 승인 요청으로 보지 않는다", () => {
    const stale = [
      "You've hit your session limit · resets 2:20pm (Asia/Seoul)",
      "Worked for 5m 32s",
      "auto mode on (shift+tab to cycle)",
      "~394k uncached · /clear to start fresh",
      "$",
    ].join("\n");
    expect(new ClaudeAdapter("", {}).detectApproval(stale)).toBeNull();
  });

  it("선택 메뉴 없는 최신 세션 리밋 배너는 유휴 프롬프트와 함께 감지한다", () => {
    const current = [
      "  ⎿  You've hit your session limit · resets 1:20am (Asia/Seoul)",
      "Worked for 5m 32s",
      "────────────────────────────────────────────────────────────────",
      "❯ Try \"continue\"",
      "⏵⏵ accept edits on (shift+tab to cycle)",
      "~394k uncached · /clear to start fresh",
    ].join("\n");
    const hint = new ClaudeAdapter("", {}).detectApproval(current);
    expect(hint?.requestType).toBe("session_limit_notice");
  });

  it("#190처럼 과거 세션 리밋 배너 뒤에 후속 대화가 있으면 다시 감지하지 않는다", () => {
    const resumed = [
      "  ⎿  You've hit your session limit · resets 1:20am (Asia/Seoul)",
      "you: 계속",
      "  ⎿  Ran javap to inspect the schema generator",
      "확인 결과 본문 스키마에는 넣을 수 없습니다.",
      "you: 계속",
      "────────────────────────────────────────────────────────────────",
      "$",
      "auto mode on (shift+tab to cycle)",
    ].join("\n");
    expect(new ClaudeAdapter("", {}).detectApproval(resumed)).toBeNull();
  });

  it("디렉터리 신뢰 확인(y/n) 화면은 한도 선택이 아니라 confirm_yn으로 감지한다", () => {
    // 실제 사용자가 보고한 화면 그대로(2026-07-08). "Enter to confirm · Esc to cancel" 푸터는
    // 세션 한도 화면 말고도 이 y/n 확인 화면에도 똑같이 떠서 예전 코드는 이걸 한도 선택(rate_limit_options)
    // 으로 오탐했다. 그 오탐을 막느라 아예 감지를 안 하게 좁혔더니, 이번엔 이 화면 자체에 웹으로
    // 응답할 방법이 없어져 세션이 막혔다 — confirm_yn으로 정확히 구분해 감지해야 한다.
    const trustPrompt = [
      "Permission Required: Accessing workspace:",
      "/home/testuser/web-agent-manager-verify-scratch8",
      "Quick safety check: Is this a project you created or one you trust?",
      "Claude Code'll be able to read, edit, and execute files here.",
      "y. Yes, I trust this folder",
      "n. No, exit",
      "Enter y/n:",
      "Enter to confirm · Esc to cancel",
    ].join("\n");
    const hint = new ClaudeAdapter("", {}).detectApproval(trustPrompt);
    expect(hint?.requestType).toBe("confirm_yn");
  });

  // 실제 운영 중 재현된 오탐: "Enter y/n:"이라는 문구 자체가 이 confirm_yn 기능을 설명하는 코드
  // 주석·문서에 리터럴로 들어있어서, 채팅 안에서 grep/cat으로 그 문서를 출력하거나 이 기능을 설명하는
  // assistant 텍스트를 쓰기만 해도 같은 tmux 화면에 그 문구가 찍혀 실제 프롬프트 없이 confirm_yn
  // 승인이 오탐 생성됐다. 도구 출력 뒤에 계속 응답 생성 중(esc to interrupt)이면 이미 지나간 문구로
  // 보고 오탐하지 않아야 한다.
  it("grep 등 도구 출력에 우연히 섞인 'Enter y/n:' 문구는 승인 요청으로 오탐하지 않는다", () => {
    const toolOutputMention = [
      "you: grep -n \"Enter y/n\" claude.ts",
      "308:  detectApproval(output: string): ApprovalHint | null {",
      "311:    if (/Enter y\\/n:/i.test(tailText)) return { requestType: \"confirm_yn\" };",
      "auto mode on (shift+tab to cycle)  ·  esc to interrupt",
    ].join("\n");
    expect(new ClaudeAdapter("", {}).detectApproval(toolOutputMention)).toBeNull();
  });

  // 실제 운영 중 재현된 두 번째 오탐(2026-07-11): 위 테스트처럼 뒤에 "esc to interrupt"가 이어지면
  // 안전한데, CODETREE.md 표의 한 줄(claude.ts 설명)이 원래 수천 자짜리라 git diff/cat으로 그 줄을
  // 띄우면 pane 안에서 여러 줄로 접혀 나온다. 그 안에 이 기능 자체를 설명하는 "Enter y/n:"이 포함돼
  // 있는데, 마침 그 직후에 다른 파일 diff 내용이 이어지고 아직 응답 생성 재개(esc to interrupt)
  // 표시가 안 뜬 순간의 스냅샷에서는 staleIndex보다 confirmIndex가 뒤로 밀려 그대로 오탐 승인이
  // 생성됐다. 실제 화면의 확인 문구는 그 줄에 단독으로만 찍히므로("Enter y/n:"만 있는 줄), 긴 문장
  // 중간에 인용부호로 낀 경우는 걸러내야 한다.
  it("긴 설명 문장 중간에 인용부호로 낀 'Enter y/n:'은 뒤에 다른 도구 출력이 더 와도 오탐하지 않는다", () => {
    const wrappedDocLine = [
      "  19  | `src/server/providers/claude.ts` | 디렉터리 신뢰 확인 등 y/n 확인 화면은",
      "\"Enter y/n:\"으로 별도 요청유형(confirm_yn) 감지 |",
      "  20  | `src/server/providers/usage-utils.ts` | 다른 파일 diff가 이어서 나오는 중 |",
    ].join("\n");
    expect(new ClaudeAdapter("", {}).detectApproval(wrappedDocLine)).toBeNull();
  });

  it("confirm_yn 화면의 결정을 실제 y/n 키 입력으로 매핑한다", () => {
    const adapter = new ClaudeAdapter("", {});
    expect(adapter.approvalInput("accept", "confirm_yn")).toBe("y\r");
    expect(adapter.approvalInput("acceptForSession", "confirm_yn")).toBe("y\r");
    expect(adapter.approvalInput("decline", "confirm_yn")).toBe("n\r");
    expect(adapter.approvalInput("cancel", "confirm_yn")).toBe("n\r");
  });

  it("실제 rate-limit 선택 메뉴가 떠 있으면 승인 요청으로 감지한다", () => {
    const prompt = [
      "you: /rate-limit-options",
      "What do you want to do?",
      "1. Stop and wait for limit to reset",
      "2. Upgrade your plan",
      "Enter selection [1-2]:",
      "Enter to confirm · Esc to cancel",
    ].join("\n");
    const hint = new ClaudeAdapter("", {}).detectApproval(prompt);
    expect(hint?.requestType).toBe("rate_limit_options");
  });

  it("Enter selection 줄이 없는 최신 rate-limit 선택 메뉴도 구조로 감지한다", () => {
    const prompt = [
      "10월분 진행 중입니다.",
      "────────────────────────────────────────────────────────────────",
      "What do you want to do?",
      "",
      "❯ 1. Stop and wait for limit to reset",
      "  2. Upgrade your plan",
      "",
      "Enter to confirm · Esc to cancel",
    ].join("\n");
    const hint = new ClaudeAdapter("", {}).detectApproval(prompt);
    expect(hint?.requestType).toBe("rate_limit_options");
  });

  it("최신 rate-limit 메뉴 문구가 지나간 뒤 idle 프롬프트가 나오면 감지하지 않는다", () => {
    const stale = [
      "What do you want to do?",
      "❯ 1. Stop and wait for limit to reset",
      "  2. Upgrade your plan",
      "Enter to confirm · Esc to cancel",
      "",
      "$",
    ].join("\n");
    expect(new ClaudeAdapter("", {}).detectApproval(stale)).toBeNull();
  });

  it("rate-limit 선택 화면의 두 선택지를 각각 다른 키 입력으로 매핑한다", () => {
    const adapter = new ClaudeAdapter("", {});
    expect(adapter.approvalInput("accept", "rate_limit_options")).toBe("1\r");
    expect(adapter.approvalInput("acceptForSession", "rate_limit_options")).toBe("2\r");
    expect(adapter.approvalInput("decline", "rate_limit_options")).toBe("\u001b");
  });

  it("resolveRateLimitInput은 고정 번호가 아니라 화면의 wait/upgrade 문구로 번호를 찾는다", () => {
    const adapter = new ClaudeAdapter("", {});
    const prompt = [
      "What do you want to do?",
      "1. Stop and wait for limit to reset",
      "2. Upgrade your plan",
      "Enter selection [1-2]:",
    ].join("\n");
    expect(adapter.resolveRateLimitInput("accept", prompt)).toBe("1\r");
    expect(adapter.resolveRateLimitInput("acceptForSession", prompt)).toBe("2\r");
    // 순서가 뒤집혀도(예: 미래 CLI 버전) 문구 기준으로 정확히 찾아야 한다.
    const swapped = [
      "What do you want to do?",
      "1. Upgrade your plan",
      "2. Stop and wait for limit to reset",
      "Enter selection [1-2]:",
    ].join("\n");
    expect(adapter.resolveRateLimitInput("accept", swapped)).toBe("2\r");
    expect(adapter.resolveRateLimitInput("acceptForSession", swapped)).toBe("1\r");
  });

  it("resolveRateLimitInput은 wait 옵션을 화면에서 못 찾으면 null을 반환해 아무 번호도 추측해 보내지 않는다", () => {
    const adapter = new ClaudeAdapter("", {});
    expect(adapter.resolveRateLimitInput("accept", "아무 메뉴도 없는 평범한 화면\n$ ")).toBeNull();
  });

  it("터미널 재시작 후 세션 재개 3지선다 화면을 resume_session_prompt으로 감지한다", () => {
    // 실제 사용자가 보고한 화면 그대로(2026-07-08). 저장된 대화가 커서 --resume 시 Claude가 요약/전체
    // 재개를 묻는데, rate_limit_options와 같은 "Enter selection [N-N]" 푸터를 써서 옵션 개수만으로
    // 구분하면 오탐 위험이 있어 "Resume from summary" 문구까지 함께 확인해 감지한다.
    const prompt = [
      "1. Resume from summary (recommended)",
      "2. Resume full session as-is",
      "3. Don't ask me again",
      "Enter selection [1-3]:",
    ].join("\n");
    const hint = new ClaudeAdapter("", {}).detectApproval(prompt);
    expect(hint?.requestType).toBe("resume_session_prompt");
  });

  it("최신 세션 재개 화면의 Enter 확인 푸터도 resume_session_prompt으로 감지한다", () => {
    const prompt = [
      "This session is 1d 20h old and 545k tokens.",
      "Resuming the full session will consume a substantial portion of your usage limits. We recommend resuming from a summary.",
      "",
      "❯ 1. Resume from summary (recommended)",
      "  2. Resume full session as-is",
      "  3. Don't ask me again",
      "",
      "Enter to confirm · Esc to cancel",
    ].join("\n");
    const hint = new ClaudeAdapter("", {}).detectApproval(prompt);
    expect(hint?.requestType).toBe("resume_session_prompt");
  });

  it("재개 프롬프트가 지나가고 응답 생성으로 넘어간 화면은 승인 요청으로 보지 않는다", () => {
    // 실제 사용자가 보고한 화면 그대로(2026-07-08). Claude가 재개 프롬프트를 화면 전체를 지우지 않고
    // 그 아래에 이어서 그려, 이미 답하고 응답 생성으로 넘어갔는데도 지나간 프롬프트 문구가 스냅샷에
    // 같이 남아 계속 승인 요청으로 오검출됐다(닫기도 "아직 응답을 기다리는 중"이라며 막혔다).
    const staleThenBusy = [
      "This session is 3h 3m old and 235.1k tokens. Resuming the full session will c",
      "1. Resume from summary (recommended)",
      "2. Resume full session as-is",
      "3. Don't ask me again",
      "Enter selection [1-3]:",
      "",
      "auto mode on (shift+tab to cycle)  ·  esc to interrupt",
      "$",
    ].join("\n");
    expect(new ClaudeAdapter("", {}).detectApproval(staleThenBusy)).toBeNull();
  });

  it("재개 프롬프트가 지나고 다시 대기(\"$\")로 넘어간 화면도 승인 요청으로 보지 않는다", () => {
    const staleThenIdle = [
      "1. Resume from summary (recommended)",
      "2. Resume full session as-is",
      "3. Don't ask me again",
      "Enter selection [1-3]:",
      "",
      "확인했습니다.",
      "$",
    ].join("\n");
    expect(new ClaudeAdapter("", {}).detectApproval(staleThenIdle)).toBeNull();
  });

  it("세션 재개 3지선다의 세 선택지를 각각 다른 키 입력으로 매핑한다", () => {
    const adapter = new ClaudeAdapter("", {});
    expect(adapter.approvalInput("accept", "resume_session_prompt")).toBe("1\r");
    expect(adapter.approvalInput("acceptForSession", "resume_session_prompt")).toBe("2\r");
    expect(adapter.approvalInput("decline", "resume_session_prompt")).toBe("3\r");
    expect(adapter.approvalInput("cancel", "resume_session_prompt")).toBe("3\r");
  });

  it("claude-in-chrome 등 스킬이 브라우저 확장을 요청하는 화면을 browser_permission_prompt로 감지한다", () => {
    // 실제 사용자가 보고한 화면 그대로(2026-07-23). "Permission Required:" 헤더가 없고 화살표 선택
    // 메뉴라 generic_permission_prompt/resume_session_prompt 어느 쪽에도 안 걸려 웹 승인 카드가
    // 안 떴던 화면.
    const prompt = [
      "Claude wants to use your browser",
      "",
      "This task could use your Chrome browser. The Claude in Chrome extension lets Claude navigate sites, click buttons, and fill forms in your existing session.",
      "",
      "❯ 1. Install extension  Opens the install page in Chrome",
      "  2. Not now            Continue without browser tools",
      "  3. Don't ask again    Revisit anytime with /chrome",
      "",
      "Enter to confirm · Esc to cancel",
    ].join("\n");
    const hint = new ClaudeAdapter("", {}).detectApproval(prompt);
    expect(hint?.requestType).toBe("browser_permission_prompt");
  });

  it("footer 없이 하단에 뜬 브라우저 확장 요청 화면도 browser_permission_prompt로 감지한다", () => {
    const prompt = [
      "Claude wants to use your browser",
      "",
      "This task could use your Chrome browser. The Claude in Chrome extension lets Claude navigate sites, click buttons, and fill forms in your existing session.",
      "",
      "❯ 1. Install extension  Opens the install page in Chrome",
      "  2. Not now            Continue without browser tools",
      "  3. Don't ask again    Revisit anytime with /chrome",
      "",
      "⏵⏵ auto mode on (shift+tab to cycle) · PR #11 · ← 1 agent",
    ].join("\n");
    const hint = new ClaudeAdapter("", {}).detectApproval(prompt);
    expect(hint?.requestType).toBe("browser_permission_prompt");
  });

  it("제목 문구가 달라도 같은 브라우저 확장 선택지 구조면 browser_permission_prompt로 감지한다", () => {
    const prompt = [
      "Browser access can help with this task",
      "",
      "The browser extension can navigate pages and fill forms in your existing session.",
      "",
      "❯ 1. Install extension  Opens the install page in Chrome",
      "  2. Not now            Continue without browser tools",
      "  3. Don't ask again    Revisit anytime with /chrome",
      "",
      "⏵⏵ auto mode on (shift+tab to cycle) · PR #11 · ← 1 agent",
    ].join("\n");
    const hint = new ClaudeAdapter("", {}).detectApproval(prompt);
    expect(hint?.requestType).toBe("browser_permission_prompt");
  });

  it("브라우저 확장 요청 화면이 지나고 응답 생성으로 넘어간 화면은 승인 요청으로 보지 않는다", () => {
    const staleThenBusy = [
      "Claude wants to use your browser",
      "❯ 1. Install extension  Opens the install page in Chrome",
      "  2. Not now            Continue without browser tools",
      "  3. Don't ask again    Revisit anytime with /chrome",
      "Enter to confirm · Esc to cancel",
      "",
      "auto mode on (shift+tab to cycle)  ·  esc to interrupt",
    ].join("\n");
    expect(new ClaudeAdapter("", {}).detectApproval(staleThenBusy)).toBeNull();
  });

  it("assistant 답변에 브라우저 확장 요청 문구가 있어도 실제 하단 메뉴가 아니면 오탐하지 않는다", () => {
    const explanation = [
      "왜 권한 확인으로 안 떴는지는 확인됐습니다.",
      "",
      "Claude wants to use your browser",
      "1. Install extension",
      "2. Not now",
      "3. Don't ask again",
      "",
      "위 텍스트는 답변 설명에 포함된 예시입니다.",
    ].join("\n");
    expect(new ClaudeAdapter("", {}).detectApproval(explanation)).toBeNull();
  });

  it("답변 끝이 브라우저 확장 선택지 목록이어도 선택 커서나 footer가 없으면 오탐하지 않는다", () => {
    const explanationAtBottom = [
      "실제 선택지는 다음과 같습니다.",
      "1. Install extension",
      "2. Not now",
      "3. Don't ask again",
    ].join("\n");
    expect(new ClaudeAdapter("", {}).detectApproval(explanationAtBottom)).toBeNull();
  });

  it("브라우저 확장 요청 화면 뒤에 일반 출력이 이어지면 지나간 메뉴로 보고 오탐하지 않는다", () => {
    const staleThenOutput = [
      "Claude wants to use your browser",
      "❯ 1. Install extension  Opens the install page in Chrome",
      "  2. Not now            Continue without browser tools",
      "  3. Don't ask again    Revisit anytime with /chrome",
      "",
      "● 브라우저 확장 없이는 제가 직접 화면을 열어볼 수 없습니다.",
    ].join("\n");
    expect(new ClaudeAdapter("", {}).detectApproval(staleThenOutput)).toBeNull();
  });

  it("브라우저 확장 요청 화면의 결정을 실제 선택지 번호로 매핑한다", () => {
    const adapter = new ClaudeAdapter("", {});
    expect(adapter.approvalInput("accept", "browser_permission_prompt")).toBe("1\r");
    expect(adapter.approvalInput("acceptForSession", "browser_permission_prompt")).toBe("3\r");
    expect(adapter.approvalInput("decline", "browser_permission_prompt")).toBe("2\r");
    expect(adapter.approvalInput("cancel", "browser_permission_prompt")).toBe("2\r");
  });

  it("시작 배너에서 모델명을 감지한다", () => {
    const banner = [
      "Claude Code v2.1.201",
      "Welcome back 테스터!",
      "Sonnet 5 · Claude Pro · user@example.com's Organization",
    ].join("\n");
    expect(new ClaudeAdapter("", {}).detectModel(banner)).toBe("Sonnet 5");
  });

  it("일반 TUI 시작 배너와 placeholder 프롬프트도 준비 상태와 모델명으로 읽는다", () => {
    const screen = [
      " ▐▛███▜▌   Claude Code v2.1.206",
      "▝▜█████▛▘  Sonnet 5 with low effort · Claude Pro",
      "  ▘▘ ▝▝    /home/testuser/web-agent-manager",
      "",
      "❯ Try \"refactor main.tsx\"",
      "",
      "  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent",
    ].join("\n");
    const adapter = new ClaudeAdapter("", {});
    expect(adapter.isReady(screen)).toBe(true);
    expect(adapter.isBusy(screen)).toBe(false);
    expect(adapter.detectModel(screen)).toBe("Sonnet 5");
    expect(adapter.detectPermissionMode?.(screen)).toBe("auto mode on");
    expect(adapter.parseModelOptions?.(screen).currentEffort).toBe("low");
  });

  it("배너가 스크롤 밖으로 밀려났으면 /model 변경 확인 메시지에서 모델명을 감지하고, 여러 개면 가장 최근 것을 쓴다", () => {
    const scrolledScreen = [
      "you: /model",
      "Set model to Opus 4.8 and saved as your default for new sessions",
      "you: /model",
      "Set model to Sonnet 5 for this session only",
      "auto mode on (shift+tab to cycle)",
    ].join("\n");
    expect(new ClaudeAdapter("", {}).detectModel(scrolledScreen)).toBe("Sonnet 5");
  });

  it("하단 상태줄에서 현재 권한 모드를 감지한다", () => {
    const adapter = new ClaudeAdapter("", {});
    expect(adapter.detectPermissionMode?.("auto mode on (shift+tab to cycle)")).toBe("auto mode on");
    expect(adapter.detectPermissionMode?.("⏸ manual mode on · ? for shortcuts · ← for agents")).toBe("manual mode on");
    expect(adapter.detectPermissionMode?.("⏵⏵ accept edits on (shift+tab to cycle) · ← for agents")).toBe("accept edits on");
    expect(adapter.detectPermissionMode?.("⏸ plan mode on (shift+tab to cycle) · ← for agents")).toBe("plan mode on");
    expect(adapter.detectPermissionMode?.("그냥 대화 내용일 뿐입니다.")).toBeNull();
  });

  it("/model 화면에서 선택 모델과 effort 현재값을 읽는다", () => {
    const screen = [
      "Choose model",
      "1. Opus 5 — Most capable model",
      "2. (selected) Sonnet 5 — Balanced coding model",
      "3. Haiku 5 — Fast model",
      "",
      "Choose thinking effort",
      "1. Low effort",
      "2. Medium effort",
      "3. High effort (selected)",
      "4. Max effort",
    ].join("\n");
    const options = new ClaudeAdapter("", {}).parseModelOptions!(screen);
    expect(options.models.find((item) => item.current)?.label).toBe("Sonnet 5");
    expect(options.currentEffort).toBe("high");
    expect(options.efforts.find((item) => item.current)?.id).toBe("high");
  });

  it("일반 TUI /model 화면의 정렬형 모델 목록과 effort 게이지를 읽는다", () => {
    const screen = [
      "Select model",
      "Switch between Claude models. Your pick becomes the default for new sessions.",
      "",
      "  1. Default (recommended)  Sonnet 5 · Efficient for routine tasks",
      "❯ 2. Sonnet ✔               Sonnet 5 · Efficient for routine tasks",
      "  3. Fable                  Fable 5 · Most capable for your hardest and longest-running tasks",
      "  4. Opus                   Opus 4.8 · Best for everyday, complex tasks · ~2× usage vs Sonnet",
      "  5. Haiku                  Haiku 4.5 · Fastest for quick answers",
      "",
      "○ Low effort ←/→ to adjust",
    ].join("\n");
    const adapter = new ClaudeAdapter("", {});
    const options = adapter.parseModelOptions!(screen);
    expect(adapter.isModelMenu?.(screen, "models")).toBe(true);
    expect(adapter.isModelMenu?.(screen, "efforts")).toBe(true);
    expect(options.models).toHaveLength(5);
    expect(options.models.find((item) => item.current)?.label).toBe("Sonnet");
    expect(options.currentEffort).toBe("low");
  });

  it("캐시 번호가 달라도 실제 메뉴에서 같은 모델 ID의 현재 번호를 찾아 선택한다", async () => {
    const sentTexts: string[] = [];
    const screen = [
      "Select model",
      "  1. Default (recommended)  Sonnet 5 · Efficient for routine tasks",
      "  2. Sonnet                 Sonnet 5 · Efficient for routine tasks",
      "  3. Fable                  Fable 5 · Most capable for hard tasks",
      "❯ 4. Opus ✔                 Opus 5 · Best for complex tasks",
      "  5. Haiku                  Haiku 4.5 · Fastest for quick answers",
    ].join("\n");
    const io: TmuxIO = {
      tmuxName: "fake",
      sendText: (value) => sentTexts.push(value),
      sendEnter: () => undefined,
      sendLeft: () => undefined,
      sendRight: () => undefined,
      wait: async () => undefined,
      snapshot: () => screen,
      waitForModelMenu: async () => true,
    };
    await new ClaudeAdapter("", {}).applyModelSelection(io, 2, "high", "opus-1m-context");
    expect(sentTexts).toEqual(["4"]);
  });

  it("기존 세션 재개 후 /model 메뉴에서 현재 모델명과 중간 effort 게이지를 읽는다", () => {
    const screen = [
      "Select model",
      "Switch between Claude models. Your pick becomes the default for new sessions.",
      "",
      "  1. Default (recommended)  Sonnet 5 · Efficient for routine tasks",
      "❯ 2. Sonnet ✔               Sonnet 5 · Efficient for routine tasks",
      "  3. Fable                  Fable 5 · Most capable for your hardest and longest-running tasks",
      "  4. Opus                   Opus 4.8 · Best for everyday, complex tasks · ~2× usage vs Sonnet",
      "  5. Haiku                  Haiku 4.5 · Fastest for quick answers",
      "",
      "◐ Medium effort ←/→ to adjust",
      "",
      "Enter to set as default · s to use this session only · Esc to cancel",
    ].join("\n");
    const adapter = new ClaudeAdapter("", {});
    const options = adapter.parseModelOptions!(screen);
    expect(adapter.isModelMenu?.(screen, "efforts")).toBe(true);
    expect(options.currentModel).toBe("Sonnet 5");
    expect(options.currentEffort).toBe("medium");
  });

  it("최신 CLI의 게이지형 /model 화면(번호·selected 표시 없이 현재 단계 한 줄만 표시)에서도 effort를 읽고, xHigh와 Max를 구분한다", () => {
    const screen = [
      "1. Default (recommended) — Sonnet 5 · Efficient for routine tasks",
      "2. (selected) Sonnet — Sonnet 5 · Efficient for routine tasks",
      "3. Fable — Fable 5 · Most capable for your hardest and longest-running tasks",
      "4. Opus — Opus 4.8 · Best for everyday, complex tasks",
      "5. Haiku — Haiku 4.5 · Fastest for quick answers",
      "Enter selection [1-5], or Escape to cancel:",
      "◉ xHigh effort ←/→ to adjust",
      "Enter to set as default · s to use this session only · Esc to cancel",
    ].join("\n");
    const options = new ClaudeAdapter("", {}).parseModelOptions!(screen);
    expect(options.currentEffort).toBe("xhigh");
    expect(options.currentEffort).not.toBe("max");
  });

  it("/effort 명령 확인 메시지에서 현재 effort를 읽고 변경 명령을 만든다", () => {
    const screen = [
      "❯ /effort",
      "  ⎿  Set effort level to low (saved as your default for new sessions): Quick, straightforward implementation",
      "",
      "❯ /effort high",
      "  ⎿  Set effort level to high (saved as your default for new sessions): Comprehensive implementation",
      "",
      "◐ high · /effort",
    ].join("\n");
    const adapter = new ClaudeAdapter("", {});
    const options = adapter.parseModelOptions!(screen);
    expect(options.currentEffort).toBe("high");
    expect(adapter.effortCommand?.("high")).toBe("/effort high");
    expect(adapter.effortCommand?.("invalid")).toBeNull();
  });
});
