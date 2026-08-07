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
  chat_view_mode?: "chat" | "terminal";
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

// 공급자 인증 계정 슬롯. config_dir가 NULL이면 CLI 기본 설정 디렉터리를 쓰는 기본 계정이다.
export interface AgentAccountRecord {
  id: number;
  provider: Provider;
  label: string;
  slug: string;
  config_dir: string | null;
  is_default: number;
  created_at: string;
  updated_at: string;
}

// 목록 화면에서 계정마다 로그인 여부와 사용 중인 채팅 수까지 함께 보여준다.
export interface AgentAccountSummary extends AgentAccountRecord {
  authenticated: boolean;
  chatCount: number;
}

export type UsageMonitorScope = "default" | "all";

export interface ChatRecord {
  id: number;
  project_id: number;
  provider: Provider;
  account_id: number | null;
  provider_session_id: string | null;
  tmux_name: string;
  status: ChatStatus;
  title: string;
  history_file: string | null;
  git_branch: string | null;
  worktree_path: string | null;
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
  account_id: number;
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
