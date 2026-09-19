import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { CodexAppServerClient, type CodexAppServerProcess } from "../src/server/providers/codex-app-server";
import { codexTurnListParamsForTest } from "../src/server/services/codex-structured-shadow";

interface FakeProcess {
  process: CodexAppServerProcess;
  input: PassThrough;
  output: PassThrough;
  writes: Array<Record<string, unknown>>;
  emitExit: () => void;
}

function fakeProcess(onWrite?: (message: Record<string, unknown>, fake: FakeProcess) => void): FakeProcess {
  const input = new PassThrough();
  const output = new PassThrough();
  const writes: Array<Record<string, unknown>> = [];
  let exitHandler: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  let errorHandler: ((error: Error) => void) | undefined;
  const process = {
    stdin: input,
    stdout: output,
    kill: () => true,
    once: ((event: string, handler: (...args: unknown[]) => void) => {
      if (event === "exit") exitHandler = handler as typeof exitHandler;
      if (event === "error") errorHandler = handler as typeof errorHandler;
      return process;
    }) as CodexAppServerProcess["once"],
  } as CodexAppServerProcess;
  const fake: FakeProcess = {
    process,
    input,
    output,
    writes,
    emitExit: () => exitHandler?.(1, null),
  };
  input.on("data", (chunk) => {
    for (const line of chunk.toString().trim().split("\n")) {
      const message = JSON.parse(line) as Record<string, unknown>;
      writes.push(message);
      onWrite?.(message, fake);
    }
  });
  void errorHandler;
  return fake;
}

function respond(fake: FakeProcess, id: unknown, result: unknown): void {
  fake.output.write(`${JSON.stringify({ id, result })}\n`);
}

describe("Codex app-server JSON-RPC client", () => {
  it("initialize 응답 뒤 initialized를 보내고 알림과 thread/read 응답을 분리한다", async () => {
    const notifications: string[] = [];
    const fake = fakeProcess((message, current) => {
      if (message.method === "initialize") {
        current.output.write(`${JSON.stringify({ method: "thread/status/changed", params: { threadId: "s" } })}\n`);
        respond(current, message.id, { userAgent: "codex" });
      }
      if (message.method === "thread/read") respond(current, message.id, { thread: { id: "s", status: { type: "idle" } } });
      if (message.method === "thread/turns/list") respond(current, message.id, { data: [{ id: "turn-1", status: "completed", startedAt: 1, completedAt: 2, items: [] }] });
    });

    const client = await CodexAppServerClient.connect({
      clientVersion: "0.5.2",
      spawnProcess: () => fake.process,
      onNotification: ({ method }) => notifications.push(method),
    });
    const result = await client.request("thread/read", { threadId: "s", includeTurns: false });
    const turns = await client.request("thread/turns/list", codexTurnListParamsForTest("s"));

    expect(fake.writes.slice(0, 4)).toEqual([
      expect.objectContaining({ id: 1, method: "initialize", params: expect.objectContaining({ capabilities: { experimentalApi: true, requestAttestation: false } }) }),
      { method: "initialized" },
      { id: 2, method: "thread/read", params: { threadId: "s", includeTurns: false } },
      { id: 3, method: "thread/turns/list", params: { threadId: "s", limit: 100, sortDirection: "desc", itemsView: "notLoaded" } },
    ]);
    expect(notifications).toEqual(["thread/status/changed"]);
    expect(result).toEqual({ thread: { id: "s", status: { type: "idle" } } });
    expect(turns).toEqual({ data: [{ id: "turn-1", status: "completed", startedAt: 1, completedAt: 2, items: [] }] });
    client.close();
  });

  it("동시에 보낸 요청 응답이 역순이어도 ID별 promise를 정확히 해결한다", async () => {
    const fake = fakeProcess((message, current) => {
      if (message.method === "initialize") respond(current, message.id, {});
      if (message.method === "second") {
        respond(current, message.id, "two");
        respond(current, Number(message.id) - 1, "one");
      }
    });
    const client = await CodexAppServerClient.connect({ clientVersion: "0.5.2", spawnProcess: () => fake.process });

    const first = client.request("first");
    const second = client.request("second");

    await expect(first).resolves.toBe("one");
    await expect(second).resolves.toBe("two");
    client.close();
  });

  it("handler 없는 서버 승인 요청을 실행하지 않고 JSON-RPC 오류로 거부한다", async () => {
    const fake = fakeProcess((message, current) => {
      if (message.method === "initialize") respond(current, message.id, {});
      if (message.method === "thread/read") {
        current.output.write(`${JSON.stringify({ id: "approval-77", method: "item/commandExecution/requestApproval", params: { command: "danger" } })}\n`);
        respond(current, message.id, { thread: { status: { type: "idle" } } });
      }
    });
    const client = await CodexAppServerClient.connect({ clientVersion: "0.5.2", spawnProcess: () => fake.process });

    await client.request("thread/read", { threadId: "s" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(fake.writes).toContainEqual({ id: "approval-77", error: { code: -32601, message: expect.stringContaining("실행하지 않습니다") } });
    client.close();
  });

  it("요청 timeout과 프로세스 종료를 성공으로 오인하지 않는다", async () => {
    const timeoutFake = fakeProcess((message, current) => {
      if (message.method === "initialize") respond(current, message.id, {});
    });
    const timed = await CodexAppServerClient.connect({ clientVersion: "0.5.2", requestTimeoutMs: 10, spawnProcess: () => timeoutFake.process });
    await expect(timed.request("thread/read", { threadId: "s" })).rejects.toThrow("시간이 초과");
    timed.close();

    const exitFake = fakeProcess((message, current) => {
      if (message.method === "initialize") respond(current, message.id, {});
    });
    const exited = await CodexAppServerClient.connect({ clientVersion: "0.5.2", spawnProcess: () => exitFake.process });
    const pending = exited.request("thread/read", { threadId: "s" });
    exitFake.emitExit();
    await expect(pending).rejects.toThrow("종료되었습니다");
  });
});
