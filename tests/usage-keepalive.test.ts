import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import type { ProviderAdapter } from "../src/server/providers/provider";
import { CODEX_USAGE_KEEPALIVE_MAX_ATTEMPTS, CODEX_USAGE_KEEPALIVE_MAX_RESPONSE_CHARS, CODEX_USAGE_KEEPALIVE_MIN_RESPONSE_CHARS, CODEX_USAGE_KEEPALIVE_PROMPT, CODEX_USAGE_KEEPALIVE_RETRY_MIN_RESPONSE_CHARS, CODEX_USAGE_KEEPALIVE_RETRY_PROMPT, USAGE_KEEPALIVE_PROMPT, usageKeepaliveHasRemainingAttempts, usageKeepaliveMinimumResponseChars, usageKeepalivePrompt } from "../src/shared/usage-keepalive";
import { openDatabase } from "../src/server/core/database";
import { codexKeepaliveExecArgs, evaluateCodexKeepaliveConfirmation, parseCodexKeepaliveExecOutput, pinnedCodexKeepaliveTrigger, UsageMonitor } from "../src/server/services/usage-monitor";

const temporaryDirectories: string[] = [];

// 실제 계정 테이블과 중복 기록을 쓰는 테스트용 UsageMonitor를 만든다.
function buildMonitor(provider: "claude" | "codex" = "claude") {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-usage-keepalive-"));
  temporaryDirectories.push(dataDir);
  const database = openDatabase({ dataDir } as unknown as AppConfig);
  const accountId = (database.prepare("SELECT id FROM agent_accounts WHERE provider = ? AND is_default = 1").get(provider) as { id: number }).id;
  const adapter = { id: provider, isReady: () => true, isBusy: () => false, createLaunch: () => ({ command: provider, args: [] }), displayLabel: provider === "codex" ? "Codex" : "Claude" } as unknown as ProviderAdapter;
  const notifications = { notify: vi.fn(async () => undefined) };
  const realtime = { broadcast: vi.fn() };
  const monitor = new UsageMonitor(database, [adapter], realtime as never, { environment: vi.fn(() => ({})) } as never, undefined, undefined, notifications as never);
  const state = { adapter, account: { id: accountId }, screen: { reset: vi.fn(), text: vi.fn(() => "ready") }, terminal: { write: vi.fn() } };
  return { database, monitor, state, accountId, notifications, realtime };
}

afterEach(() => {
  vi.useRealTimers();
  while (temporaryDirectories.length) fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe("사용량 창 최소 턴 전송", () => {
  it("Codex에만 조금 긴 문구를 쓰고 다른 공급자는 기존 문구를 유지한다", () => {
    expect(usageKeepalivePrompt("codex")).toBe(CODEX_USAGE_KEEPALIVE_PROMPT);
    expect(usageKeepalivePrompt("claude")).toBe(USAGE_KEEPALIVE_PROMPT);
    expect(usageKeepalivePrompt("grok")).toBe(USAGE_KEEPALIVE_PROMPT);
    expect(usageKeepalivePrompt("codex", true)).toBe(CODEX_USAGE_KEEPALIVE_RETRY_PROMPT);
    expect(CODEX_USAGE_KEEPALIVE_PROMPT.length).toBeGreaterThan(USAGE_KEEPALIVE_PROMPT.length);
    expect(CODEX_USAGE_KEEPALIVE_RETRY_PROMPT.length).toBeGreaterThan(CODEX_USAGE_KEEPALIVE_PROMPT.length);
    expect(CODEX_USAGE_KEEPALIVE_MIN_RESPONSE_CHARS).toBe(1500);
    expect(CODEX_USAGE_KEEPALIVE_RETRY_MIN_RESPONSE_CHARS).toBe(2444);
    expect(CODEX_USAGE_KEEPALIVE_MAX_ATTEMPTS).toBe(10);
    expect(CODEX_USAGE_KEEPALIVE_PROMPT).toContain("총 1500자 이상");
    expect(CODEX_USAGE_KEEPALIVE_RETRY_PROMPT).toContain("총 2444자 이상");
    expect(usageKeepaliveMinimumResponseChars("codex", 0)).toBe(1500);
    expect(usageKeepaliveMinimumResponseChars("codex", 1)).toBe(2444);
    expect(usageKeepaliveMinimumResponseChars("codex", 2)).toBe(3389);
    expect(usageKeepaliveMinimumResponseChars("codex", 9)).toBe(CODEX_USAGE_KEEPALIVE_MAX_RESPONSE_CHARS);
    expect(usageKeepaliveMinimumResponseChars("codex", 20)).toBe(CODEX_USAGE_KEEPALIVE_MAX_RESPONSE_CHARS);
    expect(CODEX_USAGE_KEEPALIVE_MAX_RESPONSE_CHARS).toBe(10000);
    expect(usageKeepaliveHasRemainingAttempts("codex", 8)).toBe(true);
    expect(usageKeepaliveHasRemainingAttempts("codex", 9)).toBe(false);
    expect(usageKeepalivePrompt("codex", 2)).toContain("총 3389자 이상");
    expect(usageKeepalivePrompt("codex", 9)).toContain("총 10000자 이상");
  });

  it("Codex exec는 프로젝트 밖 read-only JSON 실행만 허용한다", () => {
    const args = codexKeepaliveExecArgs("/tmp/wam-codex-keepalive-test", CODEX_USAGE_KEEPALIVE_PROMPT);

    expect(args).toEqual([
      "exec",
      "-C", "/tmp/wam-codex-keepalive-test",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox", "read-only",
      "--color", "never",
      "--json",
      CODEX_USAGE_KEEPALIVE_PROMPT,
    ]);
    expect(args).not.toContain("danger-full-access");
    expect(args).not.toContain("/home/ubuntu/myagent");
  });

  it("Codex exec는 완결된 충분한 길이의 agent_message와 turn.completed를 모두 요구한다", () => {
    const response = "가".repeat(CODEX_USAGE_KEEPALIVE_MIN_RESPONSE_CHARS);
    const output = [
      JSON.stringify({ type: "thread.started", thread_id: "test" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: response } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 50 } }),
    ].join("\n");

    expect(parseCodexKeepaliveExecOutput(output, CODEX_USAGE_KEEPALIVE_MIN_RESPONSE_CHARS)).toEqual({
      responseChars: CODEX_USAGE_KEEPALIVE_MIN_RESPONSE_CHARS,
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    expect(() => parseCodexKeepaliveExecOutput(output.replace(/\n\{"type":"turn.completed".*$/, ""), CODEX_USAGE_KEEPALIVE_MIN_RESPONSE_CHARS))
      .toThrow("완료 이벤트");
    expect(() => parseCodexKeepaliveExecOutput(output.replace(response, "짧음"), CODEX_USAGE_KEEPALIVE_MIN_RESPONSE_CHARS))
      .toThrow("너무 짧습니다");
  });

  it("Codex exec가 도구를 실행하거나 turn.failed를 내면 keepalive 성공으로 보지 않는다", () => {
    const toolOutput = [
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "pwd" } }),
      JSON.stringify({ type: "turn.completed" }),
    ].join("\n");
    expect(() => parseCodexKeepaliveExecOutput(toolOutput, 1)).toThrow("도구를 실행했습니다");
    expect(() => parseCodexKeepaliveExecOutput(JSON.stringify({ type: "turn.failed" }), 1)).toThrow("턴이 실패했습니다");
  });

  it("Codex keepalive는 대화형 TUI 대신 격리 exec를 쓴다", async () => {
    const { database, monitor, state } = buildMonitor("codex");
    const run = vi.fn(async () => ({ responseChars: CODEX_USAGE_KEEPALIVE_MIN_RESPONSE_CHARS, usage: null }));
    const spawnTui = vi.fn();
    (monitor as any).runCodexKeepalive = run;
    (monitor as any).spawnCodexKeepaliveTerminal = spawnTui;
    (state.adapter as any).createLaunch = vi.fn(() => ({ command: "codex", args: [] }));

    await (monitor as any).sendUsageKeepalivePrompt(state, 0);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      command: "codex",
      prompt: CODEX_USAGE_KEEPALIVE_PROMPT,
      minimumResponseChars: CODEX_USAGE_KEEPALIVE_MIN_RESPONSE_CHARS,
    }));
    expect(spawnTui).not.toHaveBeenCalled();
    database.close();
  });

  it("Codex는 응답 도착만으로 성공 기록하지 않고 사용량 1% 확인 뒤 확정한다", async () => {
    const { database, monitor, state, accountId } = buildMonitor("codex");
    const zeroDetails = JSON.stringify({ windows: [{ id: "five_hour", label: "5h limit", usedPercent: 0, remainingPercent: 100, resetAt: "03:27 on 29 Aug" }] });
    database.prepare("INSERT INTO usage_status(provider, account_id, monitor_status, data_status, details_json) VALUES ('codex', ?, 'ready', 'fresh', ?)")
      .run(accountId, zeroDetails);
    (monitor as any).sendUsageKeepalivePrompt = vi.fn(async () => undefined);
    const trigger = { reason: "codex_reset_zero", windowKey: null };

    expect(await (monitor as any).maybeSendUsageKeepalive(state, trigger)).toBe("awaiting_confirmation");
    expect(database.prepare("SELECT sent_at FROM usage_keepalive_prompts WHERE provider = 'codex' AND account_id = ?").get(accountId)).toBeUndefined();

    const onePercentDetails = JSON.stringify({ windows: [{ id: "five_hour", label: "5h limit", usedPercent: 1, remainingPercent: 99, resetAt: "03:27 on 29 Aug" }] });
    database.prepare("UPDATE usage_status SET details_json = ? WHERE provider = 'codex' AND account_id = ?").run(onePercentDetails, accountId);
    await (monitor as any).reconcileKeepaliveAfterUsage(state, null);

    expect(database.prepare("SELECT reason, sent_at FROM usage_keepalive_prompts WHERE provider = 'codex' AND account_id = ?").get(accountId)).toMatchObject({
      reason: "codex_reset_zero",
      sent_at: expect.any(String),
    });
    expect((state as any).keepaliveConfirmation).toBeUndefined();
    expect((state as any).pendingKeepalive).toBeUndefined();
    database.close();
  });

  it("Codex 5시간·주간이 모두 0%면 한 번 실행하고 두 창을 함께 확인한다", async () => {
    const { database, monitor, state, accountId } = buildMonitor("codex");
    const zeroDetails = JSON.stringify({ windows: [
      { id: "five_hour", label: "5h limit", usedPercent: 0, remainingPercent: 100, resetAt: "03:27 on 29 Aug" },
      { id: "weekly", label: "Weekly limit", usedPercent: 0, remainingPercent: 100, resetAt: "09:00 on 4 Sep" },
    ] });
    database.prepare("INSERT INTO usage_status(provider, account_id, monitor_status, data_status, details_json) VALUES ('codex', ?, 'ready', 'fresh', ?)")
      .run(accountId, zeroDetails);
    (monitor as any).sendUsageKeepalivePrompt = vi.fn(async () => undefined);

    expect(await (monitor as any).maybeSendUsageKeepalive(state, { reason: "codex_reset_zero", windowKey: null })).toBe("awaiting_confirmation");
    expect((state as any).keepaliveConfirmation.targetWindowIds).toEqual(["five_hour", "weekly"]);
    database.close();
  });

  it("Codex 5시간 창이 이미 1% 이상이면 고정 성공 대상으로 본다", () => {
    expect(pinnedCodexKeepaliveTrigger(JSON.stringify({ windows: [{ id: "five_hour", usedPercent: 0, resetAt: "14:21" }] }))).toBeNull();
    expect(pinnedCodexKeepaliveTrigger(JSON.stringify({ windows: [{ id: "five_hour", usedPercent: 12, resetAt: "14:21" }] }))).toMatchObject({
      reason: "codex_reset_zero",
    });
    expect(pinnedCodexKeepaliveTrigger(JSON.stringify({ windows: [{ id: "five_hour", usedPercent: 12, resetAt: "14:21" }] }))?.windowKey).toContain("five_hour");
  });

  it("Codex 확인은 정확히 1%부터 성공이고 0% reset 이동은 재시도로 판정한다", () => {
    const sentAt = "2026-08-28T11:08:59.000Z";
    const trigger = { reason: "codex_reset_zero" as const, windowKey: null };
    const confirmation = { trigger, sentAt, targetWindowIds: ["five_hour"] };
    const details = (usedPercent: number, resetAt: string) => JSON.stringify({ windows: [
      { id: "five_hour", label: "5h limit", usedPercent, remainingPercent: 100 - usedPercent, resetAt },
    ] });

    expect(evaluateCodexKeepaliveConfirmation(confirmation, details(1, "03:27 on 29 Aug"), new Date("2026-08-28T11:09:10.000Z"))).toEqual({ status: "confirmed" });
    const first = evaluateCodexKeepaliveConfirmation(confirmation, details(0, "03:27 on 29 Aug"), new Date("2026-08-28T11:09:10.000Z"));
    expect(first.status).toBe("pending");
    if (first.status !== "pending") throw new Error("첫 0% 관측은 pending이어야 합니다.");
    expect(evaluateCodexKeepaliveConfirmation(first.confirmation, details(0, "03:28 on 29 Aug"), new Date("2026-08-28T11:10:30.000Z"))).toEqual({ status: "retry" });
    expect(evaluateCodexKeepaliveConfirmation(first.confirmation, details(0, "03:27 on 29 Aug"), new Date("2026-08-28T11:10:30.000Z"))).toEqual({ status: "confirmed" });
  });

  it("Codex 동시 초기화는 5시간만 1%가 돼도 주간 확인을 조기 성공시키지 않는다", () => {
    const confirmation = {
      trigger: { reason: "codex_reset_zero" as const, windowKey: null },
      sentAt: "2026-08-30T01:00:00.000Z",
      targetWindowIds: ["five_hour", "weekly"],
    };
    const details = JSON.stringify({ windows: [
      { id: "five_hour", label: "5h limit", usedPercent: 1, remainingPercent: 99, resetAt: "06:00 on 30 Aug" },
      { id: "weekly", label: "Weekly limit", usedPercent: 0, remainingPercent: 100, resetAt: "01:00 on 6 Sep" },
    ] });

    const first = evaluateCodexKeepaliveConfirmation(confirmation, details, new Date("2026-08-30T01:00:10.000Z"));
    expect(first.status).toBe("pending");
    if (first.status !== "pending") throw new Error("주간 0% 확인이 남아 있어야 합니다.");
    expect(evaluateCodexKeepaliveConfirmation(first.confirmation, details, new Date("2026-08-30T01:01:30.000Z"))).toEqual({ status: "confirmed" });
  });

  it("같은 계정의 같은 초기화 창 중복 전송을 DB 기록으로 막는다", async () => {
    const { database, monitor, state, accountId } = buildMonitor();
    const send = vi.fn(async () => undefined);
    (monitor as unknown as { sendUsageKeepalivePrompt: typeof send }).sendUsageKeepalivePrompt = send;
    database.prepare("INSERT INTO usage_status(provider, account_id, monitor_status, data_status) VALUES ('claude', ?, 'ready', 'fresh')").run(accountId);

    const trigger = { reason: "claude_session_zero", windowKey: JSON.stringify([{ id: "session", resetAt: "2026-08-11T13:40:00.000Z" }]) };
    await (monitor as any).maybeSendUsageKeepalive(state, trigger);
    await (monitor as any).maybeSendUsageKeepalive(state, trigger);

    expect(send).toHaveBeenCalledTimes(1);
    expect(database.prepare("SELECT reason FROM usage_keepalive_prompts WHERE provider = 'claude' AND account_id = ?").get(accountId)).toEqual({ reason: "claude_session_zero" });
    expect(monitor.list().find((row) => row.provider === "claude")).toMatchObject({
      keepalive_reason: "claude_session_zero",
      keepalive_sent_at: expect.any(String),
    });
    database.close();
  });

  it("초기화 창이 바뀌면 직전 전송 후 5시간 전이라도 즉시 전송한다", async () => {
    const { database, monitor, state } = buildMonitor();
    const send = vi.fn(async () => undefined);
    (monitor as unknown as { sendUsageKeepalivePrompt: typeof send }).sendUsageKeepalivePrompt = send;
    const first = { reason: "claude_session_zero", windowKey: JSON.stringify([{ id: "session", resetAt: "2026-08-11T13:40:00.000Z" }]) };
    const next = { reason: "claude_session_zero", windowKey: JSON.stringify([{ id: "session", resetAt: "2026-08-11T18:40:00.000Z" }]) };

    await (monitor as any).maybeSendUsageKeepalive(state, first);
    await (monitor as any).maybeSendUsageKeepalive(state, next);

    expect(send).toHaveBeenCalledTimes(2);
    expect(database.prepare("SELECT window_key FROM usage_keepalive_prompts WHERE provider = 'claude'").get()).toEqual({ window_key: next.windowKey });
    database.close();
  });

  it("기존 전송 시각이 현재 Claude 창 안이면 창 키만 승계한다", async () => {
    const { database, monitor, state, accountId } = buildMonitor();
    const send = vi.fn(async () => undefined);
    (monitor as unknown as { sendUsageKeepalivePrompt: typeof send }).sendUsageKeepalivePrompt = send;
    database.prepare("INSERT INTO usage_keepalive_prompts(provider, account_id, reason, sent_at) VALUES ('claude', ?, 'claude_session_zero', ?)")
      .run(accountId, "2026-08-11T08:43:00.981Z");
    const trigger = { reason: "claude_session_zero", windowKey: JSON.stringify([{ id: "session", resetAt: "2026-08-11T13:40:00.000Z" }]) };

    await (monitor as any).maybeSendUsageKeepalive(state, trigger);

    expect(send).not.toHaveBeenCalled();
    expect(database.prepare("SELECT window_key FROM usage_keepalive_prompts WHERE provider = 'claude'").get()).toEqual({ window_key: trigger.windowKey });
    database.close();
  });

  it("새 창 전송이 실패하면 직전 창 기록을 복원한다", async () => {
    const { database, monitor, state, accountId } = buildMonitor();
    const previousKey = JSON.stringify([{ id: "session", resetAt: "2026-08-11T13:40:00.000Z" }]);
    const nextKey = JSON.stringify([{ id: "session", resetAt: "2026-08-11T18:40:00.000Z" }]);
    database.prepare("INSERT INTO usage_keepalive_prompts(provider, account_id, reason, sent_at, window_key) VALUES ('claude', ?, 'claude_session_zero', ?, ?)")
      .run(accountId, "2026-08-11T08:43:00.981Z", previousKey);
    (monitor as unknown as { sendUsageKeepalivePrompt: () => Promise<void> }).sendUsageKeepalivePrompt = vi.fn(async () => { throw new Error("전송 실패"); });

    await (monitor as any).maybeSendUsageKeepalive(state, { reason: "claude_session_missing", windowKey: nextKey });

    expect(database.prepare("SELECT reason, sent_at, window_key FROM usage_keepalive_prompts WHERE provider = 'claude'").get()).toEqual({
      reason: "claude_session_zero",
      sent_at: "2026-08-11T08:43:00.981Z",
      window_key: previousKey,
    });
    database.close();
  });

  it("기존 DB의 최소 단답 행을 보존하며 창 키 컬럼을 추가한다", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-usage-keepalive-migration-"));
    temporaryDirectories.push(dataDir);
    const config = { dataDir } as unknown as AppConfig;
    const initial = openDatabase(config);
    const accountId = (initial.prepare("SELECT id FROM agent_accounts WHERE provider = 'claude' AND is_default = 1").get() as { id: number }).id;
    initial.prepare("INSERT INTO usage_keepalive_prompts(provider, account_id, reason, sent_at) VALUES ('claude', ?, 'claude_session_zero', ?)")
      .run(accountId, "2026-08-11T08:43:00.981Z");
    initial.close();
    const legacy = new Database(path.join(dataDir, "web-agent-manager.sqlite"));
    legacy.exec(`
      ALTER TABLE usage_keepalive_prompts RENAME TO usage_keepalive_prompts_new;
      CREATE TABLE usage_keepalive_prompts (
        provider TEXT NOT NULL,
        account_id INTEGER NOT NULL REFERENCES agent_accounts(id) ON DELETE CASCADE,
        reason TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        PRIMARY KEY(provider, account_id)
      );
      INSERT INTO usage_keepalive_prompts(provider, account_id, reason, sent_at)
      SELECT provider, account_id, reason, sent_at FROM usage_keepalive_prompts_new;
      DROP TABLE usage_keepalive_prompts_new;
    `);
    legacy.close();

    const migrated = openDatabase(config);

    expect(migrated.prepare("PRAGMA table_info(usage_keepalive_prompts)").all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "window_key" })]));
    expect(migrated.prepare("SELECT reason, sent_at, window_key FROM usage_keepalive_prompts WHERE provider = 'claude'").get()).toEqual({
      reason: "claude_session_zero",
      sent_at: "2026-08-11T08:43:00.981Z",
      window_key: null,
    });
    migrated.close();
  });

  it("Claude는 누적 조회 세션 대신 새 PTY에 고정 프롬프트를 보내고 응답 뒤 폐기한다", async () => {
    vi.useFakeTimers();
    const { database, monitor, state } = buildMonitor();
    let receiveData: ((data: string) => void) | undefined;
    const freshTerminal = {
      write: vi.fn((value: string) => { if (value === "\r") receiveData?.("1\n$"); }),
      onData: vi.fn((callback: (data: string) => void) => { receiveData = callback; }),
      onExit: vi.fn(),
      kill: vi.fn(),
    };
    const spawn = vi.fn(() => freshTerminal);
    (monitor as any).spawnProviderTerminal = spawn;
    const sending = (monitor as any).sendUsageKeepalivePrompt(state);

    await vi.advanceTimersByTimeAsync(1_000);
    await sending;

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(state.terminal.write).not.toHaveBeenCalled();
    expect(freshTerminal.write.mock.calls.map((call) => call[0])).toEqual([USAGE_KEEPALIVE_PROMPT, "\r"]);
    expect(freshTerminal.kill).toHaveBeenCalledTimes(1);
    database.close();
  });
  // 사용자 요청(#57): 초기화 감지 즉시 보내지 말고, 1분 뒤 조회 PTY를 재시작한 뒤에 보낸다.
  // 감지 즉시 보내면 CLI가 아직 옛 창을 들고 있는 경계 구간에 걸릴 수 있다(#52·#56에서 실측).
  it("초기화 감지 후 1분 뒤에 조회 PTY를 재시작하고 그 다음 고정 메시지를 보낸다", async () => {
    vi.useFakeTimers();
    const { monitor, state } = buildMonitor();
    const order: string[] = [];
    const killed = vi.fn(() => { order.push("restart"); });
    (state as any).terminal.kill = killed;
    (state as any).terminalStartedAt = Date.now();
    (monitor as any).maybeSendUsageKeepalive = vi.fn(async () => { order.push("send"); return true; });

    const trigger = { reason: "claude_session_zero", windowKey: null };
    (monitor as any).scheduleKeepaliveAfterRestart(state, trigger);

    // 1분이 되기 전에는 아무 일도 없어야 한다.
    await vi.advanceTimersByTimeAsync(59_000);
    expect(order).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_000 + 5_000);
    expect(order).toEqual(["restart", "send"]);
    expect((state as any).recycling).toBe(true);
    expect((state as any).pendingKeepalive).toBeUndefined();
  });

  it("Codex 새 초기화 창 키는 1분 대기 뒤 최신 0% 재검사에서도 보존한다", async () => {
    vi.useFakeTimers();
    const { database, monitor, state, accountId } = buildMonitor("codex");
    const zeroDetails = JSON.stringify({ windows: [
      { id: "five_hour", label: "5h limit", usedPercent: 0, remainingPercent: 100, resetAt: "11:24" },
      { id: "weekly", label: "Weekly limit", usedPercent: 0, remainingPercent: 100, resetAt: "06:24 on 6 Sep" },
    ] });
    database.prepare("INSERT INTO usage_status(provider, account_id, monitor_status, data_status, details_json) VALUES ('codex', ?, 'ready', 'fresh', ?)")
      .run(accountId, zeroDetails);
    (state as any).terminal.kill = vi.fn();
    const send = vi.fn(async () => true);
    (monitor as any).maybeSendUsageKeepalive = send;
    const trigger = {
      reason: "codex_reset_zero" as const,
      windowKey: JSON.stringify([{ id: "five_hour", resetAt: "2026-08-30T02:23:00.000Z" }]),
    };

    (monitor as any).scheduleKeepaliveAfterRestart(state, trigger);
    await vi.advanceTimersByTimeAsync(66_000);

    expect(send).toHaveBeenCalledWith(state, trigger);
    database.close();
  });

  it("Codex 새 초기화 예약은 같은 60초의 연속 0% 폴링보다 우선한다", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T06:30:37.000Z"));
    const { database, monitor, state, accountId } = buildMonitor("codex");
    const zeroDetails = JSON.stringify({ windows: [
      { id: "weekly", label: "Weekly limit", usedPercent: 8, remainingPercent: 92, resetAt: "10:29 on 6 Sep" },
      { id: "five_hour", label: "5h limit", usedPercent: 0, remainingPercent: 100, resetAt: "20:29" },
    ] });
    database.prepare("INSERT INTO usage_status(provider, account_id, monitor_status, data_status, details_json) VALUES ('codex', ?, 'ready', 'fresh', ?)")
      .run(accountId, zeroDetails);
    // 실운영과 같이 직전 성공은 아직 5시간 쿨다운 안에 있고 창 키가 없는 상태다.
    database.prepare("INSERT INTO usage_keepalive_prompts(provider, account_id, reason, sent_at, window_key) VALUES ('codex', ?, 'codex_reset_zero', ?, NULL)")
      .run(accountId, "2026-08-30T01:53:22.000Z");
    (state as any).terminal.kill = vi.fn();
    const send = vi.fn(async () => true);
    (monitor as any).maybeSendUsageKeepalive = send;
    const newReset = {
      reason: "codex_reset_zero" as const,
      windowKey: JSON.stringify([{ id: "five_hour", resetAt: "2026-08-30T11:29:00.000Z" }]),
    };
    const continuingZero = { reason: "codex_reset_zero" as const, windowKey: null };

    // 정기 폴링은 서버 시작 때 등록되므로, 새 초기화가 만든 1분 타이머와 같은 시각이면 먼저 돈다.
    let poll: Promise<void> | undefined;
    setTimeout(() => {
      poll = (monitor as any).reconcileKeepaliveAfterUsage(state, continuingZero);
    }, 60_000);
    await (monitor as any).reconcileKeepaliveAfterUsage(state, newReset);
    await vi.advanceTimersByTimeAsync(65_000);
    await poll;

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(state, newReset);
    expect((state as any).pendingKeepalive).toBeUndefined();
    database.close();
  });

  it("Codex 새 초기화의 1분 기한은 중간의 반복 0% 폴링으로 밀리지 않는다", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T06:30:37.000Z"));
    const { database, monitor, state, accountId } = buildMonitor("codex");
    const zeroDetails = JSON.stringify({ windows: [
      { id: "five_hour", label: "5h limit", usedPercent: 0, remainingPercent: 100, resetAt: "20:29" },
    ] });
    database.prepare("INSERT INTO usage_status(provider, account_id, monitor_status, data_status, details_json) VALUES ('codex', ?, 'ready', 'fresh', ?)")
      .run(accountId, zeroDetails);
    (state as any).terminal.kill = vi.fn();
    const send = vi.fn(async () => true);
    (monitor as any).maybeSendUsageKeepalive = send;
    const newReset = {
      reason: "codex_reset_zero" as const,
      windowKey: JSON.stringify([{ id: "five_hour", resetAt: "2026-08-30T11:29:00.000Z" }]),
    };
    const continuingZero = { reason: "codex_reset_zero" as const, windowKey: null };

    await (monitor as any).reconcileKeepaliveAfterUsage(state, newReset);
    await vi.advanceTimersByTimeAsync(30_000);
    await (monitor as any).reconcileKeepaliveAfterUsage(state, continuingZero);
    await vi.advanceTimersByTimeAsync(29_000);
    await (monitor as any).reconcileKeepaliveAfterUsage(state, continuingZero);
    await vi.advanceTimersByTimeAsync(6_000);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(state, newReset);
    database.close();
  });

  it("Codex 새 초기화 타이머가 busy와 겹치면 조회 완료 직후 keyed 작업을 우선 실행한다", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T06:30:37.000Z"));
    const { database, monitor, state, accountId } = buildMonitor("codex");
    const zeroDetails = JSON.stringify({ windows: [
      { id: "five_hour", label: "5h limit", usedPercent: 0, remainingPercent: 100, resetAt: "20:29" },
    ] });
    database.prepare("INSERT INTO usage_status(provider, account_id, monitor_status, data_status, details_json) VALUES ('codex', ?, 'ready', 'fresh', ?)")
      .run(accountId, zeroDetails);
    (state as any).terminal.kill = vi.fn();
    (state as any).busy = true;
    const send = vi.fn(async () => true);
    (monitor as any).maybeSendUsageKeepalive = send;
    const newReset = {
      reason: "codex_reset_zero" as const,
      windowKey: JSON.stringify([{ id: "five_hour", resetAt: "2026-08-30T11:29:00.000Z" }]),
    };

    await (monitor as any).reconcileKeepaliveAfterUsage(state, newReset);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).not.toHaveBeenCalled();
    expect((state as any).pendingKeepalive).toEqual(newReset);

    (state as any).busy = false;
    const resumed = (monitor as any).reconcileKeepaliveAfterUsage(
      state,
      { reason: "codex_reset_zero" as const, windowKey: null },
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await resumed;

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(state, newReset);
    database.close();
  });

  it("Codex 조회 PTY 수명 교체가 같은 시각에 먼저 시작돼도 새 초기화 exec를 막지 않는다", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T06:30:37.000Z"));
    const { database, monitor, state, accountId } = buildMonitor("codex");
    const zeroDetails = JSON.stringify({ windows: [
      { id: "five_hour", label: "5h limit", usedPercent: 0, remainingPercent: 100, resetAt: "20:29" },
    ] });
    database.prepare("INSERT INTO usage_status(provider, account_id, monitor_status, data_status, details_json) VALUES ('codex', ?, 'ready', 'fresh', ?)")
      .run(accountId, zeroDetails);
    const killed = vi.fn();
    (state as any).terminal.kill = killed;
    (state as any).terminalStartedAt = Date.now() - 3 * 60 * 60_000;
    const send = vi.fn(async () => true);
    (monitor as any).maybeSendUsageKeepalive = send;
    const newReset = {
      reason: "codex_reset_zero" as const,
      windowKey: JSON.stringify([{ id: "five_hour", resetAt: "2026-08-30T11:29:00.000Z" }]),
    };

    // 정기 조회의 PTY 수명 교체가 keepalive 타이머보다 먼저 등록된 실제 서버 순서를 재현한다.
    setTimeout(() => (monitor as any).requestUsage(state), 60_000);
    await (monitor as any).reconcileKeepaliveAfterUsage(state, newReset);
    await vi.advanceTimersByTimeAsync(65_000);

    expect(killed).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(state, newReset);
    database.close();
  });

  it("예약이 이미 있으면 같은 창에 대해 두 번 예약하지 않는다", async () => {
    vi.useFakeTimers();
    const { monitor, state } = buildMonitor();
    const send = vi.fn(async () => true);
    (monitor as any).maybeSendUsageKeepalive = send;
    (state as any).terminal.kill = vi.fn();

    const trigger = { reason: "claude_session_zero", windowKey: null };
    (monitor as any).scheduleKeepaliveAfterRestart(state, trigger);
    (monitor as any).scheduleKeepaliveAfterRestart(state, trigger);
    await vi.advanceTimersByTimeAsync(70_000);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("Codex 응답을 확인 중일 때는 1분 타이머가 새 exec를 보내지 않는다", async () => {
    vi.useFakeTimers();
    const { database, monitor, state } = buildMonitor("codex");
    (state as any).terminal.kill = vi.fn();
    (monitor as any).requestUsage = vi.fn();
    const trigger = { reason: "codex_reset_zero" as const, windowKey: null };
    const send = vi.fn(async () => {
      (state as any).keepaliveConfirmation = {
        trigger,
        sentAt: new Date().toISOString(),
        targetWindowIds: ["five_hour"],
      };
      return "awaiting_confirmation" as const;
    });
    (monitor as any).maybeSendUsageKeepalive = send;

    (monitor as any).scheduleKeepaliveAfterRestart(state, trigger);
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(send).toHaveBeenCalledTimes(1);
    database.close();
  });

  it("Codex 확인이 실패해도 10회 전이면 1분 뒤 재시도한다", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T02:00:00.000Z"));
    const { database, monitor, state, accountId } = buildMonitor("codex");
    const trigger = { reason: "codex_reset_zero" as const, windowKey: null };
    const details = JSON.stringify({ windows: [
      { id: "five_hour", label: "5h limit", usedPercent: 0, remainingPercent: 100, resetAt: "07:01 on 30 Aug" },
      { id: "weekly", label: "Weekly limit", usedPercent: 0, remainingPercent: 100, resetAt: "02:00 on 6 Sep" },
    ] });
    database.prepare("INSERT INTO usage_status(provider, account_id, monitor_status, data_status, details_json) VALUES ('codex', ?, 'ready', 'fresh', ?)")
      .run(accountId, details);
    (state as any).terminal.kill = vi.fn();
    const send = vi.fn(async () => true);
    (monitor as any).maybeSendUsageKeepalive = send;
    (state as any).pendingKeepalive = trigger;
    (state as any).keepalivePromptAttempt = 1;
    (state as any).keepaliveConfirmation = {
      trigger,
      sentAt: "2026-08-30T01:58:00.000Z",
      targetWindowIds: ["five_hour"],
      resetSignature: JSON.stringify([{ id: "five_hour", resetAt: "07:00 on 30 Aug" }]),
      resetObservedAt: Date.now() - 76_000,
    };

    await (monitor as any).reconcileKeepaliveAfterUsage(state, trigger);

    expect((state as any).pendingKeepalive).toEqual(trigger);
    expect((state as any).keepaliveConfirmation).toBeUndefined();
    expect((state as any).keepalivePromptAttempt).toBe(2);
    expect(database.prepare("SELECT sent_at FROM usage_keepalive_prompts WHERE provider = 'codex' AND account_id = ?").get(accountId)).toBeUndefined();

    await vi.advanceTimersByTimeAsync(59_000);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(send).toHaveBeenCalledTimes(1);
    database.close();
  });

  it("Codex 확인이 10회째에도 실패하면 현재 창을 기록하고 멈춘다", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T02:00:00.000Z"));
    const { database, monitor, state, accountId, notifications, realtime } = buildMonitor("codex");
    const trigger = { reason: "codex_reset_zero" as const, windowKey: JSON.stringify([{ id: "five_hour", resetAt: "2026-08-30T07:00:00.000Z" }]) };
    const details = JSON.stringify({ windows: [
      { id: "five_hour", label: "5h limit", usedPercent: 0, remainingPercent: 100, resetAt: "07:01 on 30 Aug" },
    ] });
    database.prepare("INSERT INTO usage_status(provider, account_id, monitor_status, data_status, details_json) VALUES ('codex', ?, 'ready', 'fresh', ?)")
      .run(accountId, details);
    (state as any).terminal.kill = vi.fn();
    const send = vi.fn(async () => true);
    (monitor as any).maybeSendUsageKeepalive = send;
    (state as any).pendingKeepalive = trigger;
    (state as any).keepalivePromptAttempt = 9;
    (state as any).lastKeepaliveAttemptAt = Date.parse("2026-08-30T01:58:00.000Z");
    (state as any).keepaliveConfirmation = {
      trigger,
      sentAt: "2026-08-30T01:58:00.000Z",
      targetWindowIds: ["five_hour"],
      resetSignature: JSON.stringify([{ id: "five_hour", resetAt: "07:00 on 30 Aug" }]),
      resetObservedAt: Date.now() - 76_000,
    };

    await (monitor as any).reconcileKeepaliveAfterUsage(state, trigger);

    expect(send).not.toHaveBeenCalled();
    expect((state as any).keepaliveConfirmation).toBeUndefined();
    expect((state as any).pendingKeepalive).toBeUndefined();
    expect(database.prepare("SELECT sent_at, window_key FROM usage_keepalive_prompts WHERE provider = 'codex' AND account_id = ?").get(accountId)).toEqual({
      sent_at: "2026-08-30T01:58:00.000Z",
      window_key: trigger.windowKey,
    });
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.stringContaining("usage-keepalive-exhausted:codex:"),
      "usage_keepalive_exhausted",
      "Codex keepalive를 10회 보냈지만 5시간 창이 확정되지 않았습니다.",
      { title: "Codex 세션 유지 실패" },
    );
    expect(realtime.broadcast).toHaveBeenCalledWith("usage_keepalive_exhausted", expect.objectContaining({
      title: "Codex 세션 유지 실패",
    }));

    await vi.advanceTimersByTimeAsync(70_000);
    expect(send).not.toHaveBeenCalled();
    database.close();
  });

  // Codex 트리거는 "양수 → 0%" 전환 순간에만 잡혀서, 실패한 창은 재시도 경로가 없으면 영영
  // 고정되지 못한다(실측 #57: 준비 시간 초과로 두 번 실패한 뒤 그 창이 끝내 고정 안 됨).
  it("전송에 실패하면 요청을 남겨 다음 주기에 다시 시도한다", async () => {
    vi.useFakeTimers();
    const { monitor, state } = buildMonitor();
    (state as any).terminal.kill = vi.fn();
    const send = vi.fn(async () => false);
    (monitor as any).maybeSendUsageKeepalive = send;

    const trigger = { reason: "codex_reset_zero", windowKey: null };
    (monitor as any).scheduleKeepaliveAfterRestart(state, trigger);
    await vi.advanceTimersByTimeAsync(70_000);

    expect(send).toHaveBeenCalledTimes(1);
    // 실패했으므로 요청이 남아 있어야 한다.
    expect((state as any).pendingKeepalive).toEqual(trigger);

    // 다음 시도에서 성공하면 요청이 비워진다.
    (monitor as any).maybeSendUsageKeepalive = vi.fn(async () => true);
    (state as any).recycling = false;
    // 내부에 새 PTY 준비 대기가 있으므로 타이머를 함께 진행시켜야 한다.
    const retry = (monitor as any).restartThenSendKeepalive(state);
    await vi.advanceTimersByTimeAsync(6_000);
    await retry;
    expect((state as any).pendingKeepalive).toBeUndefined();
  });

  it("조회가 진행 중이면 PTY를 끊지 않고 다음 주기로 미룬다", async () => {
    vi.useFakeTimers();
    const { monitor, state } = buildMonitor();
    const killed = vi.fn();
    (state as any).terminal.kill = killed;
    (state as any).busy = true;
    const send = vi.fn(async () => true);
    (monitor as any).maybeSendUsageKeepalive = send;

    (monitor as any).scheduleKeepaliveAfterRestart(state, { reason: "codex_reset_zero", windowKey: null });
    await vi.advanceTimersByTimeAsync(70_000);

    expect(killed).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect((state as any).pendingKeepalive).toBeTruthy();

    // 같은 조회가 끝난 직후에는 다시 1분을 잡지 않고 이미 기한이 지난 작업을 이어서 처리한다.
    (state as any).busy = false;
    const resumed = (monitor as any).reconcileKeepaliveAfterUsage(state, { reason: "codex_reset_zero", windowKey: null });
    await vi.advanceTimersByTimeAsync(5_000);
    await resumed;
    expect(killed).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("가장 최근 사용량 관측이 fallback이면 pending keepalive를 보내지 않고 보류한다", async () => {
    const { monitor, state } = buildMonitor();
    const killed = vi.fn();
    const send = vi.fn(async () => true);
    (state as any).terminal.kill = killed;
    (state as any).usageObservationFresh = false;
    (state as any).pendingKeepalive = { reason: "claude_session_zero", windowKey: "new-window" };
    (monitor as any).maybeSendUsageKeepalive = send;

    await (monitor as any).restartThenSendKeepalive(state);

    expect(killed).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect((state as any).pendingKeepalive).toEqual({ reason: "claude_session_zero", windowKey: "new-window" });
  });

  it("세션 0%·Resets 없음 관측은 fresh가 아니어도 keepalive를 보낸다", async () => {
    vi.useFakeTimers();
    const { monitor, state } = buildMonitor();
    const killed = vi.fn();
    const send = vi.fn(async () => true);
    (state as any).terminal.kill = killed;
    (state as any).usageObservationFresh = false;
    (state as any).usageKeepaliveTrusted = true;
    (state as any).pendingKeepalive = { reason: "claude_session_zero", windowKey: "new-window" };
    (monitor as any).maybeSendUsageKeepalive = send;

    const sending = (monitor as any).restartThenSendKeepalive(state);
    await vi.advanceTimersByTimeAsync(6_000);
    await sending;

    expect(killed).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("대기 중 실제 사용량이 양수가 되면 늦은 keepalive를 취소한다", async () => {
    vi.useFakeTimers();
    const { monitor, state } = buildMonitor();
    const send = vi.fn(async () => true);
    (monitor as any).maybeSendUsageKeepalive = send;
    (state as any).terminal.kill = vi.fn();

    (monitor as any).scheduleKeepaliveAfterRestart(state, {
      reason: "codex_reset_zero",
      windowKey: JSON.stringify([{ id: "five_hour", resetAt: "2026-08-30T11:29:00.000Z" }]),
    });
    await (monitor as any).reconcileKeepaliveAfterUsage(state, null);
    await vi.advanceTimersByTimeAsync(70_000);

    expect(send).not.toHaveBeenCalled();
    expect((state as any).pendingKeepalive).toBeUndefined();
  });
  it("실패한 Codex keepalive는 1분 뒤 다시 시도한다", async () => {
    vi.useFakeTimers();
    const { monitor, state } = buildMonitor();
    (state as any).terminal.kill = vi.fn();
    const send = vi.fn(async () => false);
    (monitor as any).maybeSendUsageKeepalive = send;

    const trigger = { reason: "codex_reset_zero", windowKey: null };
    (monitor as any).scheduleKeepaliveAfterRestart(state, trigger);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(send).toHaveBeenCalledTimes(1);

    // 첫 실패가 끝난 뒤 1분이 되기 전에는 재시도하지 않는다.
    (state as any).recycling = false;
    await vi.advanceTimersByTimeAsync(59_000);
    expect(send).toHaveBeenCalledTimes(1);

    // 1분 경계 뒤 PTY 준비 시간까지 지나면 별도 조회 이벤트가 없어도 다시 시도한다.
    await vi.advanceTimersByTimeAsync(6_000);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
