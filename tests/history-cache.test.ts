import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CodexAdapter } from "../src/server/providers/codex";
import { ClaudeAdapter } from "../src/server/providers/claude";
import { GrokAdapter } from "../src/server/providers/grok";
import { HistoryCache } from "../src/server/services/history-cache";

// 임시 JSONL 파일에 레코드를 줄 단위로 저장한다.
function writeJsonl(prefix: string, records: Array<Record<string, unknown>>): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const file = path.join(directory, "session.jsonl");
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return file;
}

describe("세션 기록 증분 캐시", () => {
  it("Codex JSONL이 늘어나면 전체 파일 대신 추가된 줄만 파싱한다", () => {
    const file = writeJsonl("web-agent-manager-codex-cache-", [
      { type: "session_meta", payload: { id: "s1", cwd: "/tmp" }, timestamp: "2026-07-31T00:00:00.000Z" },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "질문" }] } },
    ]);
    const adapter = new CodexAdapter();
    const fullParse = vi.spyOn(adapter, "parseHistoryFile");
    const cache = new HistoryCache();

    expect(cache.get(adapter, file)?.messages).toHaveLength(1);
    fs.appendFileSync(file, `${JSON.stringify({ type: "response_item", payload: { type: "message", id: "a1", role: "assistant", content: [{ type: "output_text", text: "답변" }] } })}\n`);
    expect(cache.get(adapter, file)?.messages.map((message) => message.content)).toEqual(["질문", "답변"]);
    expect(fullParse).toHaveBeenCalledTimes(1);
  });

  it("Claude JSONL의 모델·제목·메시지를 추가된 줄에서 갱신한다", () => {
    const file = writeJsonl("web-agent-manager-claude-cache-", [
      { type: "user", sessionId: "s1", cwd: "/tmp", message: { content: "질문" }, timestamp: "2026-07-31T00:00:00.000Z" },
    ]);
    const adapter = new ClaudeAdapter("", {});
    const fullParse = vi.spyOn(adapter, "parseHistoryFile");
    const cache = new HistoryCache();

    cache.get(adapter, file);
    fs.appendFileSync(file, `${JSON.stringify({ type: "assistant", sessionId: "s1", cwd: "/tmp", aiTitle: "증분 응답", message: { model: "claude-opus-5", stop_reason: "end_turn", content: [{ type: "text", text: "완료" }] }, timestamp: "2026-07-31T00:00:01.000Z" })}\n`);
    const session = cache.get(adapter, file);
    expect(session?.messages.at(-1)?.content).toBe("완료");
    expect(session?.model).toBe("Opus 5");
    expect(session?.displayTitle).toBe("증분 응답");
    expect(fullParse).toHaveBeenCalledTimes(1);
  });

  it("쓰는 중인 불완전 레코드는 전체 파싱으로 폴백한 뒤 완성되면 복구한다", () => {
    const file = writeJsonl("web-agent-manager-partial-cache-", [
      { type: "session_meta", payload: { id: "s1", cwd: "/tmp" }, timestamp: "2026-07-31T00:00:00.000Z" },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "질문" }] } },
    ]);
    const adapter = new CodexAdapter();
    const cache = new HistoryCache();
    cache.get(adapter, file);

    const complete = JSON.stringify({ type: "response_item", payload: { type: "message", id: "a1", role: "assistant", content: [{ type: "output_text", text: "복구" }] } });
    const split = Math.floor(complete.length / 2);
    fs.appendFileSync(file, complete.slice(0, split));
    expect(cache.get(adapter, file)?.messages).toHaveLength(1);
    fs.appendFileSync(file, `${complete.slice(split)}\n`);
    expect(cache.get(adapter, file)?.messages.at(-1)?.content).toBe("복구");
  });

  it("Grok chat_history.jsonl 캐시는 updates.jsonl만 바뀌면 무효화 후에야 토큰을 다시 읽는다", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-grok-cache-"));
    const directory = path.join(root, "%2Ftmp", "01a01300-aaaaaaaa-bbbb-cccc-ddddeeee0001");
    fs.mkdirSync(directory, { recursive: true });
    const chatHistory = path.join(directory, "chat_history.jsonl");
    fs.writeFileSync(path.join(directory, "summary.json"), JSON.stringify({
      info: { id: "01a01300-aaaaaaaa-bbbb-cccc-ddddeeee0001", cwd: "/tmp" },
      current_model_id: "grok-4.6",
    }));
    fs.writeFileSync(chatHistory, `${JSON.stringify({ type: "user", content: [{ type: "text", text: "<user_query>\n안녕\n</user_query>" }], prompt_index: 0 })}\n${JSON.stringify({ type: "assistant", content: "안녕하세요", model_id: "grok-4.6-build" })}\n`);
    const adapter = new GrokAdapter();
    const cache = new HistoryCache();
    expect(cache.get(adapter, chatHistory)?.messages.at(-1)?.tokenUsage).toBeUndefined();

    fs.writeFileSync(path.join(directory, "updates.jsonl"), `${JSON.stringify({
      method: "_x.ai/session/update",
      params: { update: { sessionUpdate: "turn_completed", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cachedReadTokens: 4, cacheCreationTokens: 0, reasoningTokens: 1 } } },
    })}\n`);
    expect(cache.get(adapter, chatHistory)?.messages.at(-1)?.tokenUsage).toBeUndefined();
    cache.invalidate(chatHistory);
    expect(cache.get(adapter, chatHistory)?.messages.at(-1)?.tokenUsage).toEqual({
      inputTokens: 10, cachedInputTokens: 4, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      outputTokens: 2, reasoningOutputTokens: 1, totalTokens: 12,
    });
  });
});
