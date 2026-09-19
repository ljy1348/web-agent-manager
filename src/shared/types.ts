export type Provider = "codex" | "claude" | "grok";

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
  access_scope?: "standard" | "test_only";
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
  last_user_activity_at: string | null;
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
  error_code:
    | "auth_required"
    | "timeout"
    | "parse_failed"
    | "cli_exited"
    // 이전 배포본이 저장한 Claude usage 상세 조회 제한 코드. 새 기록에는 아래 세분 코드를 쓴다.
    | "rate_limited"
    // Claude /usage 상세 endpoint가 제한됐지만 최근 응답 헤더 값은 화면에 남아 있는 상태다.
    | "usage_seeded_headers_throttled"
    // Claude /usage 상세 endpoint가 제한돼 디스크의 마지막 값을 화면에 대신 표시한 상태다.
    | "usage_seeded_persisted_throttled"
    // 제한 응답은 아니지만 상세 갱신에 실패해 최근 응답 헤더 값을 표시한 상태다.
    | "usage_seeded_headers_refresh_failed"
    // 제한 응답은 아니지만 상세 갱신에 실패해 디스크의 마지막 값을 표시한 상태다.
    | "usage_seeded_persisted_refresh_failed"
    // 사용할 seed도 없이 Claude /usage 상세 endpoint 자체가 제한된 상태다.
    | "usage_endpoint_throttled"
    // Claude /usage가 아직 로딩 중이라 숫자의 출처가 확정되지 않은 상태다.
    | "usage_refreshing"
    | null;
  summary: string | null;
  used_percent: number | null;
  remaining_percent: number | null;
  reset_at: string | null;
  details_json: string | null;
  last_checked_at: string | null;
  last_success_at: string | null;
  keepalive_sent_at: string | null;
  keepalive_reason: "claude_session_missing" | "claude_session_zero" | "codex_reset_zero" | null;
}
