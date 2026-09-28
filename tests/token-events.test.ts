import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import { ClaudeAdapter } from "../src/server/providers/claude";
import { CodexAdapter } from "../src/server/providers/codex";
import { GrokAdapter } from "../src/server/providers/grok";
import type { HistorySession } from "../src/server/providers/provider";
import { TokenUsageLedger, tokenUsageSnapshotForChat } from "../src/server/services/token-usage-ledger";

// 토큰 기록이 화면 메시지가 아니라 공급자의 실제 과금 단위로 한 번씩 남는지 검증한다(#134).
const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

// 임시 디렉터리를 만들고 테스트 뒤에 지운다.
function tempDir(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const jsonl = (records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";

describe("Claude 과금 이벤트", () => {
  const usage = { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 50 };
  const base = { sessionId: "claude-s1", cwd: "/tmp/project" };
  const records = [
    { ...base, type: "user", uuid: "u1", timestamp: "2026-09-20T01:00:00.000Z", message: { role: "user", content: "질문" } },
    // CLI는 API 응답 하나(msg_A)를 블록마다 여러 줄로 나눠 같은 usage를 붙인다.
    { ...base, type: "assistant", uuid: "a1", timestamp: "2026-09-20T01:00:05.000Z", message: { id: "msg_A", model: "claude-opus-5", content: [{ type: "text", text: "설명" }], usage } },
    { ...base, type: "assistant", uuid: "a2", timestamp: "2026-09-20T01:00:06.000Z", message: { id: "msg_A", model: "claude-opus-5", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }], stop_reason: "tool_use", usage } },
    { ...base, type: "assistant", uuid: "a3", timestamp: "2026-09-20T01:00:09.000Z", message: { id: "msg_B", model: "claude-opus-5-5", content: [{ type: "text", text: "완료" }], stop_reason: "end_turn", usage: { ...usage, output_tokens: 70 } } },
    // 중단 뒤 CLI가 만든 가짜 메시지. 세션·토큰 모델로 쓰이면 안 된다.
    { ...base, type: "assistant", uuid: "a4", timestamp: "2026-09-20T01:00:10.000Z", message: { id: "synthetic-1", model: "<synthetic>", content: [{ type: "text", text: "No response requested." }], usage: { input_tokens: 0, output_tokens: 0 } } },
  ];

  it("분할 레코드는 API 응답 id로 한 번만 세고, 모델은 응답별로, 가짜 메시지는 세션 모델에서 뺀다", () => {
    const file = path.join(tempDir("claude-events-"), "claude-s1.jsonl");
    fs.writeFileSync(file, jsonl(records));
    const session = new ClaudeAdapter("", {}).parseHistoryFile(file)!;
    expect(session.tokenEvents?.map((event) => [event.key, event.occurredAt, event.model, event.totalTokens])).toEqual([
      ["claude:msg_A", "2026-09-20T01:00:05.000Z", "Opus 5", 1052],
      ["claude:msg_B", "2026-09-20T01:00:09.000Z", "Opus 5 5", 1072],
    ]);
    expect(session.model).toBe("Opus 5 5");
  });

  it("화면에는 분할 레코드를 한 번만 더한 턴 합계를 최종 답변에 표시한다", () => {
    const file = path.join(tempDir("claude-label-"), "claude-s1.jsonl");
    fs.writeFileSync(file, jsonl(records));
    const labeled = new ClaudeAdapter("", {}).parseHistoryFile(file)!.messages.filter((message) => message.tokenUsage);
    // msg_A(1052) + msg_B(1072). 0토큰인 가짜 메시지(a4)로는 합계를 옮기지 않아 실제 최종 답변(a3)에 남는다.
    expect(labeled.map((message) => [message.id, message.tokenUsage!.totalTokens])).toEqual([["a3", 2124]]);
  });

  it("증분 파싱도 이전 이벤트를 이어받아 전체 파싱과 같은 결과를 낸다", () => {
    const file = path.join(tempDir("claude-events-inc-"), "claude-s1.jsonl");
    fs.writeFileSync(file, jsonl(records.slice(0, 2)));
    const adapter = new ClaudeAdapter("", {});
    const first = adapter.parseHistoryFile(file)!;
    const rest = records.slice(2).map((record) => JSON.stringify(record));
    fs.appendFileSync(file, rest.join("\n") + "\n");
    const appended = adapter.appendHistoryLines(file, first, rest)!;
    expect(appended.tokenEvents).toEqual(adapter.parseHistoryFile(file)!.tokenEvents);
  });
});

describe("Codex 과금 이벤트", () => {
  const meta = { type: "session_meta", timestamp: "2026-09-20T02:00:00.000Z", payload: { id: "codex-s1", cwd: "/tmp/project" } };
  const tokenCount = (timestamp: string, last: number, cumulative: number) => ({
    type: "event_msg", timestamp,
    payload: { type: "token_count", info: { last_token_usage: { input_tokens: last - 10, output_tokens: 10, total_tokens: last }, total_token_usage: { total_tokens: cumulative } } },
  });
  const records = [
    meta,
    { type: "turn_context", timestamp: "2026-09-20T02:00:01.000Z", payload: { model: "gpt-6-sol", effort: "xhigh" } },
    { type: "response_item", timestamp: "2026-09-20T02:00:02.000Z", payload: { type: "message", role: "user", id: "u1", content: [{ type: "input_text", text: "작업해줘" }] } },
    { type: "response_item", timestamp: "2026-09-20T02:00:03.000Z", payload: { type: "message", role: "assistant", id: "m1", content: [{ type: "output_text", text: "진행합니다" }] } },
    // 한 메시지 뒤 도구 단계마다 모델 호출이 이어진다. 화면 메시지에는 마지막 것만 남지만 기록은 모두 세야 한다.
    tokenCount("2026-09-20T02:00:04.000Z", 1000, 1000),
    tokenCount("2026-09-20T02:00:08.000Z", 3000, 4000),
    // 모델 호출 없이 한도 정보만 갱신되며 같은 누적값이 반복된다.
    tokenCount("2026-09-20T02:00:09.000Z", 3000, 4000),
    tokenCount("2026-09-20T02:00:15.000Z", 5000, 9000),
  ];

  it("누적 총량이 늘어난 token_count마다 한 번씩 기록해 실제 누적과 합이 같다", () => {
    const file = path.join(tempDir("codex-events-"), "rollout.jsonl");
    fs.writeFileSync(file, jsonl(records));
    const session = new CodexAdapter().parseHistoryFile(file)!;
    expect(session.tokenEvents?.map((event) => [event.key, event.occurredAt, event.model, event.totalTokens])).toEqual([
      ["codex:1000", "2026-09-20T02:00:04.000Z", "gpt-6-sol xhigh", 1000],
      ["codex:4000", "2026-09-20T02:00:08.000Z", "gpt-6-sol xhigh", 3000],
      ["codex:9000", "2026-09-20T02:00:15.000Z", "gpt-6-sol xhigh", 5000],
    ]);
    expect(session.tokenEvents!.reduce((sum, event) => sum + event.totalTokens, 0)).toBe(9000);
  });

  it("화면에는 턴의 모든 호출 합계를 최신 답변 하나에만 표시한다", () => {
    const file = path.join(tempDir("codex-label-"), "rollout.jsonl");
    fs.writeFileSync(file, jsonl([...records, { type: "response_item", timestamp: "2026-09-20T02:00:16.000Z", payload: { type: "message", role: "assistant", id: "m2", content: [{ type: "output_text", text: "끝났습니다" }] } }, tokenCount("2026-09-20T02:00:17.000Z", 500, 9500)]));
    const labeled = new CodexAdapter().parseHistoryFile(file)!.messages.filter((message) => message.tokenUsage);
    expect(labeled.map((message) => [message.id, message.tokenUsage!.totalTokens])).toEqual([["m2", 9500]]);
  });

  it("증분 파싱은 이전 누적값을 이어받아 반복 token_count를 계속 거른다", () => {
    const file = path.join(tempDir("codex-events-inc-"), "rollout.jsonl");
    fs.writeFileSync(file, jsonl(records.slice(0, 6)));
    const adapter = new CodexAdapter();
    const first = adapter.parseHistoryFile(file)!;
    const rest = records.slice(6).map((record) => JSON.stringify(record));
    fs.appendFileSync(file, rest.join("\n") + "\n");
    expect(adapter.appendHistoryLines(file, first, rest)!.tokenEvents).toEqual(adapter.parseHistoryFile(file)!.tokenEvents);
  });
});

describe("Grok 과금 이벤트", () => {
  it("턴 ID와 실제 완료 시각으로 기록해 다시 읽어도 키·시각이 바뀌지 않는다", () => {
    const directory = path.join(tempDir("grok-events-"), "%2Ftmp%2Fproject", "grok-s1");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "summary.json"), JSON.stringify({ info: { id: "grok-s1", cwd: "/tmp/project" }, current_model_id: "grok-4.6" }));
    fs.writeFileSync(path.join(directory, "chat_history.jsonl"), jsonl([
      { type: "user", content: [{ type: "text", text: "<user_query>\n해줘\n</user_query>" }], prompt_index: 0 },
      { type: "assistant", content: "했습니다." },
    ]));
    fs.writeFileSync(path.join(directory, "updates.jsonl"), jsonl([{
      timestamp: 1788752223, method: "_x.ai/session/update",
      params: { update: { sessionUpdate: "turn_completed", prompt_id: "prompt-abc", usage: { inputTokens: 900, outputTokens: 100, totalTokens: 1000, cachedReadTokens: 800 } }, _meta: { agentTimestampMs: 1788752223346 } },
    }]));
    const adapter = new GrokAdapter();
    const first = adapter.parseHistoryFile(path.join(directory, "chat_history.jsonl"))!;
    expect(first.tokenEvents?.map((event) => [event.key, event.occurredAt, event.totalTokens])).toEqual([["grok:prompt-abc", new Date(1788752223346).toISOString(), 1000]]);
    expect(adapter.parseHistoryFile(path.join(directory, "chat_history.jsonl"))!.tokenEvents).toEqual(first.tokenEvents);
  });
});

// 실제 스키마·기본 계정이 있는 임시 DB와 Claude 채팅 하나를 만든다.
function ledgerHarness(): { database: AppDatabase; ledger: TokenUsageLedger; chatId: number } {
  const root = tempDir("token-events-ledger-");
  const config = { rootDir: root, dataDir: root, homeDir: root, host: "127.0.0.1", port: 0, publicUrl: "http://127.0.0.1", allowedRoots: [root], sessionTtlHours: 1, runtimeEnabled: false, slack: {}, ntfy: { serverUrl: "https://ntfy.sh" } } as AppConfig;
  const database = openDatabase(config);
  cleanup.push(() => database.close());
  database.prepare("INSERT INTO projects(name, path, source) VALUES ('p', ?, 'manual')").run(path.join(root, "project"));
  const project = database.prepare("SELECT id FROM projects").get() as { id: number };
  const account = database.prepare("SELECT id FROM agent_accounts WHERE provider = 'claude' AND is_default = 1").get() as { id: number };
  const result = database.prepare("INSERT INTO chats(project_id, provider, account_id, provider_session_id, tmux_name, status, title) VALUES (?, 'claude', ?, 'claude-s1', 'tmux-e', 'stopped', '채팅')").run(project.id, account.id);
  return { database, ledger: new TokenUsageLedger(database), chatId: Number(result.lastInsertRowid) };
}

const eventUsage = { inputTokens: 10, cachedInputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 15 };
// 과금 이벤트 두 개(또는 앞 하나만)를 가진 Claude 세션 fixture.
function eventSession(count: 1 | 2): HistorySession {
  const events = [
    { ...eventUsage, key: "claude:msg_A", occurredAt: "2026-09-20T01:00:05.000Z", model: "Opus 5" },
    { ...eventUsage, key: "claude:msg_B", occurredAt: "2026-09-20T01:00:09.000Z", model: "Opus 5 5" },
  ].slice(0, count);
  return { provider: "claude", sessionId: "claude-s1", cwd: "/tmp/project", title: "채팅", historyFile: "/tmp/x.jsonl", createdAt: "2026-09-20T01:00:00.000Z", updatedAt: "2026-09-27T00:00:00.000Z", messages: [], model: "Opus 5 5", tokenEvents: events };
}

describe("토큰 기록 저장", () => {
  it("예전 메시지 키 행은 정리하고, 이벤트 일부만 담은 오래된 백업을 기록해도 새 키 행은 지우지 않는다", () => {
    const { database, ledger, chatId } = ledgerHarness();
    const snapshot = tokenUsageSnapshotForChat(database, chatId)!;
    // 예전 방식(줄 uuid 키·세션 모델)으로 중복 저장된 행.
    database.prepare(`INSERT INTO token_usage_events(provider, session_id, message_id, occurred_at, model, input_tokens, output_tokens, total_tokens)
      VALUES ('claude', 'claude-s1', 'a1', '2026-09-26T17:15:00.000Z', '<synthetic>', 10, 5, 15), ('claude', 'claude-s1', 'a2', '2026-09-26T17:15:00.000Z', '<synthetic>', 10, 5, 15)`).run();
    ledger.recordSession(eventSession(2), snapshot);
    const rows = () => database.prepare("SELECT message_id, occurred_at, model FROM token_usage_events ORDER BY message_id").all();
    expect(rows()).toEqual([
      { message_id: "claude:msg_A", occurred_at: "2026-09-20T01:00:05.000Z", model: "Opus 5" },
      { message_id: "claude:msg_B", occurred_at: "2026-09-20T01:00:09.000Z", model: "Opus 5 5" },
    ]);
    ledger.recordSession(eventSession(1), snapshot);
    expect(rows()).toHaveLength(2);
  });
});

describe("Grok 화면 표시", () => {
  it("압축으로 앞 턴이 잘린 기록도 N번째 턴 사용량을 prompt_index N 답변에 붙인다", () => {
    const directory = path.join(tempDir("grok-label-"), "%2Ftmp%2Fproject", "grok-s2");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "summary.json"), JSON.stringify({ info: { id: "grok-s2", cwd: "/tmp/project" } }));
    // 0~1번 턴 기록은 잘리고 2번(자동 프롬프트)·3번(사람 질문)만 남은 상태.
    fs.writeFileSync(path.join(directory, "chat_history.jsonl"), jsonl([
      { type: "user", content: [{ type: "text", text: "자동 유지 프롬프트" }], synthetic_reason: "keepalive", prompt_index: 2 },
      { type: "assistant", content: "유지 응답" },
      { type: "user", content: [{ type: "text", text: "<user_query>\n실제 질문\n</user_query>" }], prompt_index: 3 },
      { type: "assistant", content: "실제 답변" },
    ]));
    const turn = (index: number, total: number) => ({ timestamp: 1788752223 + index, params: { update: { sessionUpdate: "turn_completed", prompt_id: `p${index}`, usage: { inputTokens: total - 1, outputTokens: 1, totalTokens: total } }, _meta: { agentTimestampMs: 1788752223000 + index } } });
    fs.writeFileSync(path.join(directory, "updates.jsonl"), jsonl([turn(0, 100), turn(1, 200), turn(2, 300), turn(3, 400)]));
    const session = new GrokAdapter().parseHistoryFile(path.join(directory, "chat_history.jsonl"))!;
    expect(session.messages.filter((message) => message.tokenUsage).map((message) => [message.content, message.tokenUsage!.totalTokens])).toEqual([["실제 답변", 400]]);
    expect(session.tokenEvents?.reduce((sum, event) => sum + event.totalTokens, 0)).toBe(1000);
  });
});
