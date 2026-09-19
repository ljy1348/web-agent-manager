import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase } from "../src/server/core/database";
import type { ProviderAdapter } from "../src/server/providers/provider";
import { capabilitiesForAdapter, ProviderCapabilityRegistry } from "../src/server/services/provider-capabilities";
import { ProviderEventJournal } from "../src/server/services/provider-event-journal";
import { normalizeHookEvent } from "../src/server/services/agent-hook-events";

const temporaryDirectories: string[] = [];

function adapter(id: "codex" | "claude" | "grok", queued = false): ProviderAdapter {
  return {
    id,
    displayLabel: id,
    isReady: () => true,
    isBusy: () => false,
    ...(queued ? { hasQueuedPrompt: () => true } : {}),
  } as unknown as ProviderAdapter;
}

afterEach(() => {
  while (temporaryDirectories.length) fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe("공급자 capability snapshot", () => {
  it("현재 TUI 런타임이 제공하지 않는 구조화 ACK를 과장하지 않고 폴백 이유를 선언한다", () => {
    const snapshot = capabilitiesForAdapter(adapter("codex"), "codex-cli 1.2.3", new Date("2026-09-12T00:00:00Z"));

    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      provider: "codex",
      cliVersion: "codex-cli 1.2.3",
      transport: "hook_jsonl_tui",
      structuredSession: false,
      deliveryAcknowledgement: false,
      queueAcknowledgement: false,
      checkedAt: "2026-09-12T00:00:00.000Z",
    });
    expect(snapshot.evidencePriority).toEqual(["hook", "jsonl", "tui"]);
    expect(snapshot.fallbackReasons).toContain("structured_interactive_transport_unavailable");
  });

  it("같은 공급자·CLI 버전 snapshot을 중복 행 없이 갱신한다", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wam-provider-capabilities-"));
    temporaryDirectories.push(dataDir);
    const database = openDatabase({ dataDir } as AppConfig);
    const registry = new ProviderCapabilityRegistry(database);

    registry.capture(adapter("claude", true), "claude 2.0", new Date("2026-09-12T01:00:00Z"));
    registry.capture(adapter("claude", true), "claude 2.0", new Date("2026-09-12T02:00:00Z"));

    expect((database.prepare("SELECT COUNT(*) AS count FROM provider_capability_snapshots").get() as { count: number }).count).toBe(1);
    expect(registry.listLatest()[0]).toMatchObject({ provider: "claude", queueAcknowledgement: true, checkedAt: "2026-09-12T02:00:00.000Z" });
    database.close();
  });

  it("정규화 공급자 이벤트를 sequence 기반 append-only 원장에 보존한다", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wam-provider-events-"));
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "wam-provider-events-project-"));
    temporaryDirectories.push(dataDir, projectPath);
    const database = openDatabase({ dataDir } as AppConfig);
    const projectId = Number(database.prepare("INSERT INTO projects(name, path) VALUES ('p', ?)").run(projectPath).lastInsertRowid);
    database.prepare("INSERT INTO chats(project_id, provider, tmux_name, title) VALUES (?, 'codex', 'event-chat', 'chat')").run(projectId);
    const chatId = Number((database.prepare("SELECT id FROM chats").get() as { id: number }).id);
    const journal = new ProviderEventJournal(database);
    const event = normalizeHookEvent("codex", chatId, { hook_event_name: "Stop", session_id: "s", turn_id: "t" }, new Date("2026-09-12T04:00:00Z"))!;

    expect(journal.record(event)).toBe(true);
    expect(journal.record(event)).toBe(false);
    expect(journal.list(chatId)).toEqual([expect.objectContaining({ sequence: 1, id: event.id, type: "turn.completed", source: "hook" })]);
    database.close();
  });
});
