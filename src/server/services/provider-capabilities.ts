import crypto from "node:crypto";
import type { AppDatabase } from "../core/database";
import type { ProviderAdapter } from "../providers/provider";
import type { ProviderCapabilities, ProviderSignalSource } from "../../shared/provider-runtime";

function evidencePriority(_adapter: ProviderAdapter): ProviderSignalSource[] {
  const sources: ProviderSignalSource[] = ["hook", "jsonl", "tui"];
  return sources;
}

// 현재 대화형 런타임의 실제 기능만 선언한다. 구조화 session transport가 연결되기 전에는 세 공급자
// 모두 hook+JSONL 관찰과 TUI 제어의 hybrid이며, 없는 ACK를 true로 과장하지 않는다.
export function capabilitiesForAdapter(adapter: ProviderAdapter, cliVersion: string | null, now = new Date()): ProviderCapabilities {
  return {
    schemaVersion: 1,
    provider: adapter.id,
    cliVersion,
    transport: "hook_jsonl_tui",
    structuredSession: false,
    deliveryAcknowledgement: false,
    queueAcknowledgement: typeof adapter.hasQueuedPrompt === "function",
    sessionEvents: true,
    turnEvents: true,
    approvalEvents: true,
    toolEvents: false,
    usageEvents: false,
    interrupt: true,
    resume: true,
    evidencePriority: evidencePriority(adapter),
    fallbackReasons: ["structured_interactive_transport_unavailable", "tui_required_for_input_and_control"],
    checkedAt: now.toISOString(),
  };
}

export class ProviderCapabilityRegistry {
  constructor(private readonly database: AppDatabase) {}

  capture(adapter: ProviderAdapter, cliVersion: string | null, now = new Date()): ProviderCapabilities {
    const snapshot = capabilitiesForAdapter(adapter, cliVersion, now);
    const versionKey = cliVersion?.trim() || "unknown";
    this.database.prepare(`
      INSERT INTO provider_capability_snapshots(
        id, provider, cli_version, cli_version_key, transport, capabilities_json, fallback_reasons_json, checked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, cli_version_key, transport) DO UPDATE SET
        capabilities_json = excluded.capabilities_json,
        fallback_reasons_json = excluded.fallback_reasons_json,
        checked_at = excluded.checked_at
    `).run(
      crypto.randomUUID(),
      adapter.id,
      cliVersion,
      versionKey,
      snapshot.transport,
      JSON.stringify(snapshot),
      JSON.stringify(snapshot.fallbackReasons),
      snapshot.checkedAt,
    );
    return snapshot;
  }

  listLatest(): ProviderCapabilities[] {
    const rows = this.database.prepare(`
      SELECT capabilities_json FROM provider_capability_snapshots s
      WHERE checked_at = (
        SELECT MAX(newer.checked_at) FROM provider_capability_snapshots newer WHERE newer.provider = s.provider
      )
      ORDER BY provider
    `).all() as Array<{ capabilities_json: string }>;
    return rows.map((row) => JSON.parse(row.capabilities_json) as ProviderCapabilities);
  }
}
