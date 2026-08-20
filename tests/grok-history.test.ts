import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GrokAdapter } from "../src/server/providers/grok";

// 실제 grok 1.0.5 세션 디렉터리와 같은 구조를 만든다.
// (`<기록루트>/<URL인코딩 cwd>/<세션UUID>/{chat_history.jsonl,summary.json,events.jsonl,updates.jsonl}`)
function writeSession(records: unknown[], options: { summary?: Record<string, unknown>; events?: unknown[]; updates?: unknown[] } = {}): { directory: string; chatHistory: string; events: string; updates: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-history-"));
  const directory = path.join(root, "%2Fhome%2Fubuntu%2Fdemo", "01a01300-fb84-7a93-b983-32c76000c809");
  fs.mkdirSync(directory, { recursive: true });
  const chatHistory = path.join(directory, "chat_history.jsonl");
  fs.writeFileSync(chatHistory, records.map((record) => JSON.stringify(record)).join("\n"));
  fs.writeFileSync(path.join(directory, "summary.json"), JSON.stringify({
    info: { id: "01a01300-fb84-7a93-b983-32c76000c809", cwd: "/home/ubuntu/demo" },
    session_summary: "README에 한 줄 추가",
    created_at: "2026-08-18T03:53:46.646315994Z",
    updated_at: "2026-08-18T03:54:24.519383139Z",
    current_model_id: "grok-4.6",
    generated_title: "README.md 한 줄 추가",
    reasoning_effort: "high",
    ...options.summary,
  }));
  const events = path.join(directory, "events.jsonl");
  fs.writeFileSync(events, (options.events ?? []).map((event) => JSON.stringify(event)).join("\n"));
  const updates = path.join(directory, "updates.jsonl");
  fs.writeFileSync(updates, (options.updates ?? []).map((update) => JSON.stringify(update)).join("\n"));
  return { directory, chatHistory, events, updates };
}

// 실제 grok CLI가 남기는 turn_completed 한 줄.
function turnCompleted(usage: Record<string, unknown>): unknown {
  return {
    method: "_x.ai/session/update",
    params: {
      sessionId: "01a01300-fb84-7a93-b983-32c76000c809",
      update: { sessionUpdate: "turn_completed", stop_reason: "end_turn", usage },
    },
  };
}

// 실제 grok CLI가 남기는 레코드 모양 그대로. user 레코드에는 사람이 친 발화 말고도 CLI가 만든
// 컨텍스트 블록이 같은 타입으로 섞여 들어온다.
const SAMPLE_RECORDS = [
  { type: "system", content: "You are Grok 4.6 released by xAI." },
  { type: "user", content: [{ type: "text", text: "<user_info>\nOS Version: linux\nWorkspace Path: /home/ubuntu/demo\n</user_info>" }] },
  { type: "user", content: [{ type: "text", text: "<system-reminder>\nThe following skills are available for use:\n- build-with-ai\n</system-reminder>" }] },
  { type: "user", content: [{ type: "text", text: "<user_query>\nREADME.md에 한 줄 추가해줘\n</user_query>" }], prompt_index: 0 },
  { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "파일을 먼저 읽자" }], status: "completed" },
  { type: "assistant", content: "README.md의 현재 내용을 확인하겠습니다.", model_id: "grok-4.6-build" },
  { type: "tool_result", tool_call_id: "call-1", content: "1→probe\n" },
  { type: "assistant", content: "", model_id: "grok-4.6-build" },
  { type: "assistant", content: "README.md에 한 줄을 추가했습니다.", model_id: "grok-4.6-build" },
];

// 실제 tmux에서 캡처한 화면들. 정규식을 추측으로 쓰지 않기 위한 근거 fixture다.
const IDLE_SCREEN = [
  "     README.md에 grok probe ok 한 줄을 추가했습니다.                                    12:53 PM",
  "     Worked for 11s",
  "  ╭──────────────────────────────────────────────────────────────────╮",
  "  │ ❯                                                                │",
  "  ╰──────────────────────────────────────── Grok 4.6 (high) ─╯",
  "  Shift+Tab:mode  │  Ctrl+x:shortcuts",
].join("\n");

const BUSY_SCREEN = [
  "  ❙  ◈ Read 1 file",
  "    ⠙ Responding… 0.0s                                             4.4s ⇣16.8k [stop]",
  "  ╭──────────────────────────────────────────────────────────────────╮",
  "  │ ❯                                                                │",
  "  ╰──────────────────────────────────────── Grok 4.6 (high) ─╯",
  "  Shift+Tab:mode  │  Esc:cancel  │  Ctrl+x:shortcuts",
].join("\n");

const DRAFT_SCREEN = [
  "  ╭──────────────────────────────────────────────────────────────────╮",
  "  │ ❯ 아직 안 보낸 초안                                              │",
  "  ╰──────────────────────────────────────── Grok 4.6 (high) ─╯",
  "  Enter:send  │  Shift+Tab:mode  │  Ctrl+x:shortcuts",
].join("\n");

const APPROVAL_SCREEN = [
  "     ◆ Edit /home/ubuntu/demo/outside.txt",
  "  ┃",
  "  ┃  Allow Edit to /home/ubuntu/demo/outside.txt?",
  "  ┃",
  "  ┃  1 (●) Yes, and don't ask again for anything (always-approve mode)",
  "  ┃  2 (○) Yes, allow all edits during this session",
  "  ┃  3 (○) Yes",
  "  ┃  4 (○) No, reject (type to add feedback)",
  "  ┃",
  "  1/4:select  │  Tab:next option  │  Ctrl+o:always-approve  │  Ctrl+c:cancel  │  Esc:scrollback",
].join("\n");

const AUTO_MODE_SCREEN = [
  "  ╭──────────────────────────────────────────────────────────────────╮",
  "  │ ❯                                                                │",
  "  ╰─────────────────────────────────── Grok 4.6 (high) · auto ─╯",
  "  Shift+Tab:mode  │  Ctrl+x:shortcuts",
].join("\n");

describe("GrokAdapter 기록 파싱", () => {
  it("사람이 친 발화만 사용자 메시지로 남기고 CLI 주입 블록과 내부 사고는 제외한다", () => {
    const adapter = new GrokAdapter();
    const { chatHistory } = writeSession(SAMPLE_RECORDS);
    const session = adapter.parseHistoryFile(chatHistory);
    expect(session).not.toBeNull();
    expect(session!.provider).toBe("grok");
    expect(session!.cwd).toBe("/home/ubuntu/demo");
    expect(session!.sessionId).toBe("01a01300-fb84-7a93-b983-32c76000c809");
    const users = session!.messages.filter((message) => message.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0].content).toBe("README.md에 한 줄 추가해줘");
    // reasoning·system 레코드와 빈 assistant는 화면에 띄울 대화가 아니다.
    expect(session!.messages.some((message) => message.content.includes("파일을 먼저 읽자"))).toBe(false);
    expect(session!.messages.some((message) => message.content.includes("You are Grok"))).toBe(false);
    expect(session!.messages.filter((message) => message.role === "assistant")).toHaveLength(2);
    expect(session!.messages.filter((message) => message.role === "tool")).toHaveLength(1);
  });

  it("summary.json에서 모델과 표시 제목을 가져온다", () => {
    const adapter = new GrokAdapter();
    const { chatHistory } = writeSession(SAMPLE_RECORDS);
    const session = adapter.parseHistoryFile(chatHistory)!;
    expect(session.model).toBe("grok-4.6");
    expect(session.displayTitle).toBe("README.md 한 줄 추가");
    expect(session.title).toBe("README.md에 한 줄 추가해줘");
  });

  it("턴 종료 시각은 events.jsonl의 마지막 turn_ended에서 읽는다", () => {
    const adapter = new GrokAdapter();
    const { chatHistory } = writeSession(SAMPLE_RECORDS, {
      events: [
        { ts: "2026-08-18T03:54:00.000Z", type: "turn_started", turn_number: 1 },
        { ts: "2026-08-18T03:54:20.000Z", type: "turn_ended", outcome: "completed" },
        { ts: "2026-08-18T03:54:21.000Z", type: "phase_changed" },
      ],
    });
    expect(adapter.parseHistoryFile(chatHistory)!.turnEndedAt).toBe("2026-08-18T03:54:20.000Z");
  });

  it("turn_ended가 아직 없으면 턴 종료 시각도 비어 있다", () => {
    const adapter = new GrokAdapter();
    const { chatHistory } = writeSession(SAMPLE_RECORDS, { events: [{ ts: "2026-08-18T03:54:00.000Z", type: "turn_started" }] });
    expect(adapter.parseHistoryFile(chatHistory)!.turnEndedAt).toBeNull();
  });

  // 턴 종료가 events.jsonl에만 기록되므로, 그 파일이 갱신될 때도 같은 세션으로 다시 동기화되어야
  // "응답 생성 중" 표시가 확실히 풀린다.
  it("events.jsonl 경로로도 같은 세션을 돌려주되 기록 파일 경로는 chat_history.jsonl로 고정한다", () => {
    const adapter = new GrokAdapter();
    const { chatHistory, events } = writeSession(SAMPLE_RECORDS, { events: [{ ts: "2026-08-18T03:54:20.000Z", type: "turn_ended" }] });
    const fromEvents = adapter.parseHistoryFile(events)!;
    expect(fromEvents.sessionId).toBe(adapter.parseHistoryFile(chatHistory)!.sessionId);
    expect(fromEvents.historyFile).toBe(chatHistory);
    expect(fromEvents.turnEndedAt).toBe("2026-08-18T03:54:20.000Z");
  });

  it("대화·턴 종료·턴 토큰과 무관한 내부 기록 파일은 채팅 목록에 올리지 않는다", () => {
    const adapter = new GrokAdapter();
    const { chatHistory, events, updates } = writeSession(SAMPLE_RECORDS);
    expect(adapter.isHiddenHistoryFile(chatHistory)).toBe(false);
    expect(adapter.isHiddenHistoryFile(events)).toBe(false);
    expect(adapter.isHiddenHistoryFile(updates)).toBe(false);
    expect(adapter.isHiddenHistoryFile(path.join(path.dirname(chatHistory), "prompt_history.jsonl"))).toBe(true);
    expect(adapter.isHiddenHistoryFile(path.join(path.dirname(chatHistory), "rewind_points.jsonl"))).toBe(true);
  });

  // 사용량 조회 전용 PTY도 일반 세션 디렉터리를 만들지만 슬래시 명령만 오가서 사람 발화가 남지 않는다.
  // 이걸 걸러내지 않아 조회가 돌 때마다 "Grok 세션"이 채팅 목록에 쌓였다(실측 7개).
  it("사람 발화가 없는 조회 전용 기록은 채팅 목록에서 숨긴다", () => {
    const adapter = new GrokAdapter();
    const monitorRecords = [
      { type: "system", content: "You are Grok 4.6 released by xAI." },
      { type: "user", content: [{ type: "text", text: "<system-reminder>\n<user_query> 같은 안내 문구가 들어간 주입 블록\n</system-reminder>" }] },
    ];
    const { chatHistory } = writeSession(monitorRecords);
    expect(adapter.isHiddenHistoryFile(chatHistory)).toBe(true);
  });

  it("사람 발화가 한 번이라도 있으면 계속 노출한다", () => {
    const adapter = new GrokAdapter();
    const { chatHistory } = writeSession(SAMPLE_RECORDS);
    expect(adapter.isHiddenHistoryFile(chatHistory)).toBe(false);
    // 이후 판정은 캐시로 확정되어 파일을 다시 읽지 않아도 노출을 유지한다.
    expect(adapter.isHiddenHistoryFile(chatHistory)).toBe(false);
  });

  it("turn_completed 사용량을 그 턴의 마지막 assistant에만 붙인다", () => {
    const adapter = new GrokAdapter();
    const secondUser = { type: "user", content: [{ type: "text", text: "<user_query>\n이어서 확인해줘\n</user_query>" }], prompt_index: 1 };
    const secondAssistant = { type: "assistant", content: "확인했습니다.", model_id: "grok-4.6-build" };
    const { chatHistory, updates } = writeSession([...SAMPLE_RECORDS, secondUser, secondAssistant], {
      updates: [
        turnCompleted({
          inputTokens: 16980, outputTokens: 81, totalTokens: 17061,
          cachedReadTokens: 6144, cacheCreationTokens: 0, reasoningTokens: 69,
        }),
        { method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } } } },
        turnCompleted({
          inputTokens: 168095, outputTokens: 1984, totalTokens: 170079,
          cachedReadTokens: 131328, cacheCreationTokens: 0, reasoningTokens: 1256,
        }),
      ],
    });
    const fromHistory = adapter.parseHistoryFile(chatHistory)!;
    const assistants = fromHistory.messages.filter((message) => message.role === "assistant");
    expect(assistants).toHaveLength(3);
    expect(assistants[0].tokenUsage).toBeUndefined();
    expect(assistants[1].tokenUsage).toEqual({
      inputTokens: 16980, cachedInputTokens: 6144, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      outputTokens: 81, reasoningOutputTokens: 69, totalTokens: 17061,
    });
    expect(assistants[2].tokenUsage).toEqual({
      inputTokens: 168095, cachedInputTokens: 131328, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      outputTokens: 1984, reasoningOutputTokens: 1256, totalTokens: 170079,
    });
    expect(adapter.parseHistoryFile(updates)!.messages.at(-1)?.tokenUsage?.totalTokens).toBe(170079);
  });

  it("updates.jsonl이 없거나 turn_completed가 없으면 토큰을 붙이지 않는다", () => {
    const adapter = new GrokAdapter();
    const { directory, chatHistory } = writeSession(SAMPLE_RECORDS);
    fs.rmSync(path.join(directory, "updates.jsonl"));
    expect(adapter.parseHistoryFile(chatHistory)!.messages.some((message) => message.tokenUsage)).toBe(false);
  });

  it("GROK_HOME 계정 슬롯의 기록 루트를 계산한다", () => {
    const adapter = new GrokAdapter();
    expect(adapter.historyRootFor(null)).toBe(path.join(os.homedir(), ".grok", "sessions"));
    expect(adapter.historyRootFor("/data/agent-accounts/grok-second")).toBe("/data/agent-accounts/grok-second/sessions");
  });
});

describe("GrokAdapter 완료 판정", () => {
  const adapter = new GrokAdapter();
  const message = (role: "user" | "assistant" | "tool", content: string) => ({ id: content, role, kind: "text", content, createdAt: "2026-08-18T03:54:00.000Z" });

  // Grok은 도구를 부르기 직전에도 설명 문장을 assistant 메시지로 남긴다. 그걸 완료로 보면 턴 중간마다
  // 완료 알림이 나가므로, 실제 완료는 turn_ended뿐이다.
  it("내용 있는 assistant 메시지만으로는 완료로 보지 않는다", () => {
    const decision = adapter.evaluateHistorySync({
      session: {} as never,
      last: message("assistant", "먼저 파일을 읽겠습니다."),
      newMessages: [message("assistant", "먼저 파일을 읽겠습니다.")],
      isTurnEnd: false,
    });
    expect(decision.notifyCompletion).toBe(false);
    expect(decision.clearBusy).toBe(false);
  });

  it("turn_ended가 오면 완료로 보고 작업중 표시를 푼다", () => {
    const decision = adapter.evaluateHistorySync({ session: {} as never, last: undefined, newMessages: [], isTurnEnd: true });
    expect(decision.notifyCompletion).toBe(true);
    expect(decision.clearBusy).toBe(true);
    expect(decision.markBusy).toBe(false);
  });

  it("새 사용자 메시지·도구 결과는 작업중으로 올린다", () => {
    const decision = adapter.evaluateHistorySync({
      session: {} as never,
      last: message("user", "이거 해줘"),
      newMessages: [message("user", "이거 해줘")],
      isTurnEnd: false,
    });
    expect(decision.markBusy).toBe(true);
  });
});

describe("GrokAdapter 화면 판정", () => {
  const adapter = new GrokAdapter();

  it("상태줄로 입력 가능·응답 생성 중을 구분한다", () => {
    expect(adapter.isReady(IDLE_SCREEN)).toBe(true);
    expect(adapter.isBusy(IDLE_SCREEN)).toBe(false);
    expect(adapter.isReady(BUSY_SCREEN)).toBe(false);
    expect(adapter.isBusy(BUSY_SCREEN)).toBe(true);
  });

  it("입력창에 초안이 남아 있으면 준비 상태로 보지 않는다", () => {
    expect(adapter.readPromptDraft(DRAFT_SCREEN)).toBe("아직 안 보낸 초안");
    expect(adapter.readPromptDraft(IDLE_SCREEN)).toBe("");
    expect(adapter.isReady(DRAFT_SCREEN)).toBe(false);
  });

  it("승인 화면에서는 입력창이 없으므로 초안도 준비 상태도 아니다", () => {
    expect(adapter.readPromptDraft(APPROVAL_SCREEN)).toBeNull();
    expect(adapter.isReady(APPROVAL_SCREEN)).toBe(false);
  });

  it("도구 실행 승인 화면을 감지한다", () => {
    const hint = adapter.detectApproval(APPROVAL_SCREEN);
    expect(hint).not.toBeNull();
    expect(hint!.requestType).toBe("tool_permission_prompt");
    expect(hint!.summary).toContain("Allow Edit to");
  });

  it("승인 화면이 아닌 평범한 화면은 승인 요청으로 보지 않는다", () => {
    expect(adapter.detectApproval(IDLE_SCREEN)).toBeNull();
    expect(adapter.detectApproval(BUSY_SCREEN)).toBeNull();
    // 선택지 없이 푸터 문구만 지나간 출력(문서·로그 등)도 승인으로 오탐하면 안 된다.
    expect(adapter.detectApproval("여기서는 푸터가 이렇게 보입니다: 1/4:select · Tab:next option")).toBeNull();
  });

  it("승인 키는 화면에 실제로 뜬 선택지 문구에서 번호를 찾는다", () => {
    expect(adapter.resolveApprovalInput("accept", "tool_permission_prompt", APPROVAL_SCREEN)).toBe("3");
    expect(adapter.resolveApprovalInput("acceptForSession", "tool_permission_prompt", APPROVAL_SCREEN)).toBe("2");
    expect(adapter.resolveApprovalInput("decline", "tool_permission_prompt", APPROVAL_SCREEN)).toBe("4");
  });

  it("승인 화면이 아니면 아무 키도 정하지 않는다", () => {
    expect(adapter.resolveApprovalInput("accept", "tool_permission_prompt", IDLE_SCREEN)).toBeNull();
    // 고정 매핑으로 키를 추측해 보내면 그 숫자가 그대로 채팅 메시지가 되므로 빈 값이어야 한다.
    expect(adapter.approvalInput("accept", "tool_permission_prompt")).toBe("");
  });

  it("입력창 테두리에서 모델과 권한 모드를 읽는다", () => {
    expect(adapter.detectModel(IDLE_SCREEN)).toBe("Grok 4.6");
    expect(adapter.detectPermissionMode(IDLE_SCREEN)).toBe("default");
    expect(adapter.detectPermissionMode(AUTO_MODE_SCREEN)).toBe("auto");
  });

  it("모델 목록에는 현재 모델과 추론 강도가 표시된다", () => {
    const options = adapter.parseModelOptions(IDLE_SCREEN);
    expect(options.provider).toBe("grok");
    expect(options.currentModel).toBe("Grok 4.6");
    expect(options.currentEffort).toBe("high");
    expect(options.models.find((model) => model.current)?.id).toBe("grok-4.6");
    expect(options.efforts.find((effort) => effort.current)?.id).toBe("high");
  });

  // `/model`은 선택 메뉴가 아니라 인자 입력 대기로 들어가서, 목록 조회용으로 보내면 Esc 뒤에도 입력이
  // 남아 다음 사용량 조회가 "Unknown model: /usage show"로 실패했다(실측).
  it("모델 목록은 /model 명령을 보내지 않고 만든다", () => {
    expect(adapter.promptQuirks.modelOptionsWithoutMenu).toBe(true);
    // 사용량 모달이 떠 있어 현재 값을 못 읽는 화면에서도 선택 가능한 목록 자체는 비지 않아야 한다.
    expect(adapter.parseModelOptions("아무 화면").models.map((model) => model.id)).toEqual(["grok-4.6", "grok-4.5"]);
  });

  it("모델 변경은 메뉴 탐색 없이 /model 명령 한 줄로 보낸다", async () => {
    const sent: string[] = [];
    let entered = 0;
    await adapter.applyModelSelection({
      tmuxName: "fake",
      sendText: (value) => sent.push(value),
      sendEnter: () => { entered += 1; },
      sendLeft: () => undefined,
      sendRight: () => undefined,
      wait: async () => undefined,
      snapshot: () => IDLE_SCREEN,
      waitForModelMenu: async () => true,
    }, 0, "medium", "grok-4.5");
    expect(sent).toEqual(["/model grok-4.5 medium"]);
    expect(entered).toBe(1);
  });
});

// 실제 `/usage show` 화면(모달 테두리 포함) 그대로. 플랜 이름은 계정마다 달라 제목을 고정하지 않는다.
const USAGE_SCREEN = [
  "  ┌──────────────────────────────────────────── [✗] ─┐",
  "  │  Context usage  Usage limit  Session info        │",
  "  │──────────────────────────────────────────────────│",
  "  │  Weekly limit (SuperGrok)                        │",
  "  │                                                  │",
  "  │  █████░░░░░░░░░░░░░░░░░░░░░░░░░  16%             │",
  "  │  Resets: August 21, 13:23                        │",
  "  │                                                  │",
  "  │  Session usage (since start or last resume):     │",
  "  │    Input tokens:   16,316 (11,648 cached)        │",
  "  │    Output tokens:  140 (121 reasoning)           │",
  "  │    Total tokens:   16,456                        │",
  "  │    Model calls:    1 · API time: 2.7s            │",
  "  │    Cost:           $0.0027                       │",
  "  │                                                  │",
  "  │  Tab switch  |  ↑/↓ scroll  |  Esc close         │",
  "  └──────────────────────────────────────────────────┘",
].join("\n");

// 아직 모델을 부르지 않은 세션은 세션 사용량이 한 줄로만 나온다.
const USAGE_SCREEN_NO_CALLS = [
  "  │  Weekly limit (SuperGrok)                        │",
  "  │                                                  │",
  "  │  █████░░░░░░░░░░░░░░░░░░░░░░░░░  16%             │",
  "  │  Resets: August 21, 13:23                        │",
  "  │                                                  │",
  "  │  Session usage: no model calls yet in this session. │",
].join("\n");

describe("GrokAdapter 사용량", () => {
  const adapter = new GrokAdapter();

  // `/usage`만 보내면 show/manage 하위 선택에서 멈춘다. 인자까지 붙여야 Enter 한 번에 열린다.
  it("사용량은 `/usage show` 한 줄로 조회하고 모달이라 닫는 입력을 함께 정의한다", () => {
    expect(adapter.usageCommands).toEqual(["/usage show"]);
    expect(adapter.usageScreenCloseInput).toBe("\u001b");
    expect(adapter.usageWindowId).toBe("weekly");
  });

  it("주간 한도 창의 사용률과 초기화 시각을 읽는다", () => {
    const usage = adapter.parseUsage(USAGE_SCREEN);
    expect(usage.provider).toBe("grok");
    expect(usage.data_status).toBe("fresh");
    expect(usage.error_code).toBeNull();
    expect(usage.used_percent).toBe(16);
    expect(usage.remaining_percent).toBe(84);
    expect(usage.reset_at).toBe("August 21, 13:23");
    const windows = JSON.parse(String(usage.details_json)).windows as Array<Record<string, unknown>>;
    expect(windows).toHaveLength(1);
    expect(windows[0].id).toBe("weekly");
    expect(windows[0].label).toBe("Weekly limit (SuperGrok)");
  });

  it("세션 사용량 줄은 한도 창이 아니라 참고 활동으로 남긴다", () => {
    const activity = JSON.parse(String(adapter.parseUsage(USAGE_SCREEN).details_json)).activity as string[];
    expect(activity).toEqual([
      "Input tokens:   16,316 (11,648 cached)",
      "Output tokens:  140 (121 reasoning)",
      "Total tokens:   16,456",
      "Model calls:    1 · API time: 2.7s",
      "Cost:           $0.0027",
    ]);
    const noCalls = JSON.parse(String(adapter.parseUsage(USAGE_SCREEN_NO_CALLS).details_json)).activity as string[];
    expect(noCalls).toEqual(["Session usage: no model calls yet in this session."]);
  });

  // tmux 화면 캡처가 간헐적으로 글자를 흘리는 것이 실측됐다("Weekly limit" → "Weekly  imit").
  // 제목을 조건으로 걸면 그 주기의 사용량이 통째로 파싱 실패로 떨어지므로 숫자·Resets를 앵커로 쓴다.
  it("제목 글자가 일부 유실돼도 사용률과 초기화 시각은 읽어낸다", () => {
    const damaged = USAGE_SCREEN.replace("Weekly limit (SuperGrok)", "Weekly  imit (SuperGrok)");
    const usage = adapter.parseUsage(damaged);
    expect(usage.data_status).toBe("fresh");
    expect(usage.used_percent).toBe(16);
    expect(usage.reset_at).toBe("August 21, 13:23");
    const window = JSON.parse(String(usage.details_json)).windows[0];
    expect(window.id).toBe("weekly");
    // 깨진 제목을 그대로 내보내면 사용자에게 오타로 보이므로 표시명만 보정하고 플랜 이름은 유지한다.
    expect(window.label).toBe("Weekly limit (SuperGrok)");
  });

  it("사용량 화면이 아니면 수치를 지어내지 않는다", () => {
    const usage = adapter.parseUsage(IDLE_SCREEN);
    expect(usage.data_status).toBe("unavailable");
    expect(usage.error_code).toBe("parse_failed");
    expect(usage.used_percent).toBeNull();
  });

  it("로그인이 풀린 화면은 인증 필요로 구분한다", () => {
    const usage = adapter.parseUsage("You are not authenticated.");
    expect(usage.error_code).toBe("auth_required");
    expect(usage.data_status).toBe("unavailable");
  });
});
