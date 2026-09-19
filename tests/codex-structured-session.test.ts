import { describe, expect, it } from "vitest";
import type { NormalizedAgentEvent } from "../src/shared/provider-runtime";
import { CodexStructuredSessionAdapter, type CodexStructuredConnector } from "../src/server/providers/codex-structured-session";
import type { CodexAppServerNotification, CodexAppServerRequestId } from "../src/server/providers/codex-app-server";

function harness(responses: Record<string, unknown>) {
  const calls: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];
  let notify: ((notification: CodexAppServerNotification) => void) | undefined;
  let requestServer: ((request: { id: CodexAppServerRequestId; method: string; params: unknown }) => Promise<unknown>) | undefined;
  let closed = false;
  const connector: CodexStructuredConnector = async (options) => {
    notify = options.onNotification;
    requestServer = options.onServerRequest;
    return {
      request: async (method, params) => {
        calls.push({ method, params });
        const response = responses[method];
        if (response instanceof Error) throw response;
        return response;
      },
      close: () => { closed = true; },
    };
  };
  return {
    connector,
    calls,
    notification: (value: CodexAppServerNotification) => notify?.(value),
    serverRequest: (value: { id: CodexAppServerRequestId; method: string; params: unknown }) => requestServer!(value),
    closed: () => closed,
  };
}

describe("Codex structured session adapter contract", () => {
  it("새 thread를 명시 정책으로 시작하고 command ID를 clientUserMessageId로 turn ACK에 결합한다", async () => {
    const fake = harness({
      "thread/start": { thread: { id: "thread-new" } },
      "turn/start": { turn: { id: "turn-1", status: "inProgress" } },
      "turn/interrupt": {},
    });
    const adapter = new CodexStructuredSessionAdapter(fake.connector, undefined, () => new Date("2026-09-12T08:00:00Z"));

    await expect(adapter.start({ chatId: 7, cwd: "/workspace", model: "gpt-5", approvalPolicy: "on-request", sandbox: "workspace-write" })).resolves.toEqual({ chatId: 7, threadId: "thread-new" });
    await expect(adapter.send("command-123", "hello")).resolves.toEqual({ commandId: "command-123", threadId: "thread-new", turnId: "turn-1", acceptedAt: "2026-09-12T08:00:00.000Z" });
    await adapter.interrupt("turn-1");

    expect(fake.calls).toEqual([
      { method: "thread/start", params: { cwd: "/workspace", model: "gpt-5", approvalPolicy: "on-request", sandbox: "workspace-write", ephemeral: false } },
      { method: "turn/start", params: { threadId: "thread-new", clientUserMessageId: "command-123", input: [{ type: "text", text: "hello", text_elements: [] }] } },
      { method: "turn/interrupt", params: { threadId: "thread-new", turnId: "turn-1" } },
    ]);
    adapter.close();
    expect(fake.closed()).toBe(true);
  });

  it("resume 응답의 thread ID가 요청과 다르면 연결을 폐기한다", async () => {
    const fake = harness({ "thread/resume": { thread: { id: "wrong" } } });
    const adapter = new CodexStructuredSessionAdapter(fake.connector);

    await expect(adapter.resume({ chatId: 8, cwd: "/workspace", threadId: "expected" })).rejects.toThrow("다른 thread ID");
    expect(fake.calls[0]).toEqual({ method: "thread/resume", params: { threadId: "expected", cwd: "/workspace", excludeTurns: true } });
    expect(fake.closed()).toBe(true);
    expect(adapter.currentHandle()).toBeNull();
  });

  it("구조화 notification을 본문 없이 공통 session/turn/tool 이벤트로 변환한다", async () => {
    const fake = harness({ "thread/start": { thread: { id: "thread-1" } } });
    const events: NormalizedAgentEvent[] = [];
    const adapter = new CodexStructuredSessionAdapter(fake.connector, (event) => events.push(event), () => new Date("2026-09-12T09:00:00Z"));
    await adapter.start({ chatId: 9, cwd: "/workspace" });

    fake.notification({ method: "thread/started", params: { thread: { id: "thread-1" } } });
    fake.notification({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } } });
    fake.notification({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "item-1", type: "commandExecution", command: "secret" } } });
    fake.notification({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "failed", error: { message: "secret" } } } });
    fake.notification({ method: "thread/closed", params: { threadId: "thread-1" } });

    expect(events.map((event) => event.type)).toEqual(["session.started", "prompt.started", "tool.started", "turn.failed", "session.ended"]);
    expect(events.every((event) => event.source === "provider_api" && event.chatId === 9 && event.sessionId === "thread-1")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("secret");
    expect(events[2].payload).toEqual({ method: "item/started", itemType: "commandExecution" });
  });

  it("thread/turn ID 없는 성공 응답을 delivery ACK로 받아들이지 않는다", async () => {
    const startMissing = harness({ "thread/start": { thread: {} } });
    await expect(new CodexStructuredSessionAdapter(startMissing.connector).start({ chatId: 1, cwd: "/workspace" })).rejects.toThrow("thread 응답에 ID");

    const turnMissing = harness({ "thread/start": { thread: { id: "thread-1" } }, "turn/start": { turn: {} } });
    const adapter = new CodexStructuredSessionAdapter(turnMissing.connector);
    await adapter.start({ chatId: 1, cwd: "/workspace" });
    await expect(adapter.send("command-1", "hello")).rejects.toThrow("turn 응답에 ID");
  });

  it("command/file 승인 요청을 허용 목록과 식별자만 남겨 한 번 결정한다", async () => {
    const fake = harness({ "thread/start": { thread: { id: "thread-1" } } });
    const events: NormalizedAgentEvent[] = [];
    const seen: unknown[] = [];
    const adapter = new CodexStructuredSessionAdapter(
      fake.connector,
      (event) => events.push(event),
      () => new Date("2026-09-12T10:00:00Z"),
      async (request) => { seen.push(request); return "accept"; },
    );
    await adapter.start({ chatId: 11, cwd: "/workspace" });

    await expect(fake.serverRequest({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        command: "top secret",
        cwd: "/secret/path",
        reason: "secret reason",
        availableDecisions: ["accept", "decline", { acceptWithExecpolicyAmendment: {} }],
      },
    })).resolves.toEqual({ decision: "accept" });

    expect(seen).toEqual([{
      requestId: "approval-1",
      chatId: 11,
      requestType: "command_execution",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      availableDecisions: ["accept", "decline"],
    }]);
    expect(events.map((event) => event.type)).toEqual(["approval.requested", "approval.resolved"]);
    expect(JSON.stringify(events)).not.toContain("secret");
    expect(events[1].payload).toMatchObject({ requestId: "approval-1", decision: "accept" });
  });

  it("광고되지 않은 결정·다른 thread·지원하지 않는 server request를 거부한다", async () => {
    const fake = harness({ "thread/start": { thread: { id: "thread-1" } } });
    const adapter = new CodexStructuredSessionAdapter(fake.connector, undefined, undefined, async () => "acceptForSession");
    await adapter.start({ chatId: 12, cwd: "/workspace" });

    await expect(fake.serverRequest({
      id: 1,
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", availableDecisions: ["accept", "decline"] },
    })).rejects.toThrow("허용되지 않은");
    await expect(fake.serverRequest({
      id: 2,
      method: "item/fileChange/requestApproval",
      params: { threadId: "other", turnId: "turn-1", itemId: "item-1" },
    })).rejects.toThrow("다른 Codex thread");
    await expect(fake.serverRequest({ id: 3, method: "item/tool/requestUserInput", params: {} })).rejects.toThrow("지원하지 않는");
  });
});
