export type Provider = "codex" | "claude";

export interface ProviderMeta {
  id: Provider;
  label: string;
  usageWindowId: string;
  supportsPermissionMode: boolean;
}

export type ChatStatus =
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "resuming"
  | "external"
  | "error";

export interface AuthUser {
  id: number;
  username: string;
  role: "admin" | "user";
  last_project_id?: number | null;
  last_chat_id?: number | null;
}

export interface ProjectRecord {
  id: number;
  name: string;
  path: string;
  source: "manual" | "discovered";
  active: number;
  created_at: string;
  updated_at: string;
}

export interface ChatRecord {
  id: number;
  project_id: number;
  provider: Provider;
  provider_session_id: string | null;
  tmux_name: string;
  status: ChatStatus;
  title: string;
  history_file: string | null;
  last_error: string | null;
  busy: number;
  created_at: string;
  updated_at: string;
}

export interface MessageRecord {
  id: number;
  chat_id: number;
  provider_message_id: string;
  role: "user" | "assistant" | "system" | "tool";
  kind: string;
  content: string;
  created_at: string;
}

export interface UsageWindow {
  id: string;
  label: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetAt: string | null;
}

export interface UsageRecord {
  provider: Provider;
  monitor_status: "starting" | "ready" | "refreshing" | "error" | "stopped";
  data_status: "fresh" | "stale" | "unavailable";
  error_code: "auth_required" | "timeout" | "parse_failed" | "cli_exited" | null;
  summary: string | null;
  used_percent: number | null;
  remaining_percent: number | null;
  reset_at: string | null;
  details_json: string | null;
  last_checked_at: string | null;
  last_success_at: string | null;
}
