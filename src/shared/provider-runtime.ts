import type { Provider } from "./types";

export const NORMALIZED_AGENT_EVENT_TYPES = [
  "session.started",
  "session.bound",
  "session.ended",
  "prompt.accepted",
  "prompt.queued",
  "prompt.started",
  "turn.completed",
  "turn.failed",
  "turn.interrupted",
  "approval.requested",
  "approval.resolved",
  "rate_limit.entered",
  "rate_limit.reset",
  "tool.started",
  "tool.completed",
  "usage.observed",
] as const;

export type NormalizedAgentEventType = typeof NORMALIZED_AGENT_EVENT_TYPES[number];
export type ProviderSignalSource = "provider_api" | "stream_json" | "hook" | "jsonl" | "tui";
export type InteractiveTransport = "app_server" | "stream_json" | "hook_jsonl_tui" | "tui";

export interface NormalizedAgentEvent {
  schemaVersion: 1;
  id: string;
  provider: Provider;
  chatId: number;
  sessionId: string | null;
  turnId: string | null;
  type: NormalizedAgentEventType;
  source: ProviderSignalSource;
  observedAt: string;
  payload: Record<string, unknown>;
}

export interface ProviderCapabilities {
  schemaVersion: 1;
  provider: Provider;
  cliVersion: string | null;
  transport: InteractiveTransport;
  structuredSession: boolean;
  deliveryAcknowledgement: boolean;
  queueAcknowledgement: boolean;
  sessionEvents: boolean;
  turnEvents: boolean;
  approvalEvents: boolean;
  toolEvents: boolean;
  usageEvents: boolean;
  interrupt: boolean;
  resume: boolean;
  evidencePriority: ProviderSignalSource[];
  fallbackReasons: string[];
  checkedAt: string;
}
