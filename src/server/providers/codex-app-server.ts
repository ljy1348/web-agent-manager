import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

export type CodexAppServerRequestId = string | number;

interface JsonRpcResponse {
  id: CodexAppServerRequestId;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

interface JsonRpcServerMessage {
  id?: CodexAppServerRequestId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcResponse["error"];
}

export interface CodexAppServerNotification {
  method: string;
  params: unknown;
}

export interface CodexAppServerProcess extends Pick<ChildProcess, "once" | "kill"> {
  stdin: Writable;
  stdout: Readable;
}

export type CodexAppServerSpawn = (environment: Record<string, string>) => CodexAppServerProcess;

export interface CodexAppServerClientOptions {
  environment?: Record<string, string>;
  requestTimeoutMs?: number;
  clientVersion: string;
  spawnProcess?: CodexAppServerSpawn;
  onNotification?: (notification: CodexAppServerNotification) => void;
  onServerRequest?: (request: { id: CodexAppServerRequestId; method: string; params: unknown }) => Promise<unknown>;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class CodexAppServerRpcError extends Error {
  constructor(
    message: string,
    public readonly code: number | undefined,
    public readonly data: unknown,
  ) {
    super(message);
    this.name = "CodexAppServerRpcError";
  }
}

// 실행 루트 package.json의 버전을 app-server clientInfo에 사용한다.
export function codexAppServerClientVersion(rootDir = process.cwd()): string {
  const value = (JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8")) as { version?: unknown }).version;
  if (typeof value !== "string" || !value.trim()) throw new Error("package.json 버전을 확인할 수 없습니다.");
  return value;
}

function defaultSpawn(environment: Record<string, string>): CodexAppServerProcess {
  return spawn("codex", ["app-server"], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
    stdio: ["pipe", "pipe", "ignore"],
  });
}

// Codex app-server의 줄 단위 JSON-RPC를 한 연결에서 순서·timeout·프로세스 종료까지 추적한다.
// 대화형 shadow에서는 읽기 메서드만 호출하며, 서버 요청은 handler가 명시되지 않으면 실행하지 않는다.
export class CodexAppServerClient {
  private readonly process: CodexAppServerProcess;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly timeoutMs: number;
  private buffered = "";
  private nextId = 1;
  private closed = false;

  private constructor(private readonly options: CodexAppServerClientOptions) {
    this.timeoutMs = options.requestTimeoutMs ?? 5_000;
    this.process = (options.spawnProcess ?? defaultSpawn)(options.environment ?? {});
    this.process.stdout.on("data", (chunk: Buffer | string) => this.consume(chunk.toString()));
    this.process.once("error", (error) => this.failAll(error instanceof Error ? error : new Error(String(error))));
    this.process.once("exit", (code, signal) => this.failAll(new Error(`Codex app-server가 종료되었습니다. code=${code ?? "null"}, signal=${signal ?? "null"}`)));
    this.process.stdin.once("error", (error) => this.failAll(error instanceof Error ? error : new Error(String(error))));
  }

  static async connect(options: CodexAppServerClientOptions): Promise<CodexAppServerClient> {
    const client = new CodexAppServerClient(options);
    try {
      await client.request("initialize", {
        clientInfo: {
          name: "web_agent_manager",
          title: "web-agent-manager",
          version: options.clientVersion,
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      });
      client.notify("initialized");
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Codex app-server 연결이 닫혀 있습니다."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server ${method} 요청 시간이 초과되었습니다.`));
      }, this.timeoutMs);
      timer.unref();
      this.pending.set(id, { method, resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    if (this.closed) throw new Error("Codex app-server 연결이 닫혀 있습니다.");
    this.write(params === undefined ? { method } : { method, params });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(new Error("Codex app-server 연결을 닫았습니다."));
    this.process.kill();
  }

  private write(message: Record<string, unknown>): void {
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private consume(chunk: string): void {
    this.buffered += chunk;
    const lines = this.buffered.split("\n");
    this.buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.handle(JSON.parse(line) as JsonRpcServerMessage);
      } catch {
        // stdout의 비 JSON 진단 행은 구조화 메시지가 아니므로 무시한다.
      }
    }
  }

  private handle(message: JsonRpcServerMessage): void {
    if (typeof message.id === "number" && ("result" in message || "error" in message) && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new CodexAppServerRpcError(
          message.error.message || `Codex app-server ${pending.method} 요청이 실패했습니다.`,
          message.error.code,
          message.error.data,
        ));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== "string") return;
    if (typeof message.id === "number" || typeof message.id === "string") {
      void this.handleServerRequest(message.id, message.method, message.params);
      return;
    }
    this.options.onNotification?.({ method: message.method, params: message.params });
  }

  private async handleServerRequest(id: CodexAppServerRequestId, method: string, params: unknown): Promise<void> {
    if (!this.options.onServerRequest) {
      this.write({ id, error: { code: -32601, message: `WAM shadow는 서버 요청 ${method}을 실행하지 않습니다.` } });
      return;
    }
    try {
      const result = await this.options.onServerRequest({ id, method, params });
      if (!this.closed) this.write({ id, result });
    } catch (error) {
      if (!this.closed) this.write({ id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
    }
  }

  private failAll(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
