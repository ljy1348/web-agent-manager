import Database from "better-sqlite3";
import path from "node:path";
import type { AppConfig } from "./config";

export type AppDatabase = Database.Database;

const schema = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin' CHECK(role IN ('admin', 'user')),
  last_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  last_chat_id INTEGER REFERENCES chats(id) ON DELETE SET NULL,
  chat_view_mode TEXT NOT NULL DEFAULT 'chat' CHECK(chat_view_mode IN ('chat', 'terminal')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS web_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual', 'discovered')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider IN ('codex', 'claude')),
  provider_session_id TEXT,
  tmux_name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'stopped',
  title TEXT NOT NULL,
  history_file TEXT,
  model TEXT,
  git_branch TEXT,
  worktree_path TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider, provider_session_id)
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  request_type TEXT NOT NULL,
  request_payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  decision TEXT,
  decided_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS usage_status (
  provider TEXT PRIMARY KEY,
  monitor_status TEXT NOT NULL DEFAULT 'starting',
  data_status TEXT NOT NULL DEFAULT 'unavailable',
  error_code TEXT,
  summary TEXT,
  used_percent REAL,
  remaining_percent REAL,
  reset_at TEXT,
  details_json TEXT,
  last_checked_at TEXT,
  last_success_at TEXT
);

-- 대표 사용량 창의 예정 초기화와 발송 여부를 보존해 재시작 뒤에도 중복 없이 알린다.
CREATE TABLE IF NOT EXISTS usage_reset_schedules (
  provider TEXT NOT NULL CHECK(provider IN ('codex', 'claude')),
  window_id TEXT NOT NULL,
  scheduled_reset_at TEXT NOT NULL,
  used_percent REAL,
  notified_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(provider, window_id)
);

-- 한 번 정상 검증된 에이전트 연동은 재시작 뒤에도 무거운 CLI 상태 검사를 반복하지 않는다.
CREATE TABLE IF NOT EXISTS agent_integration_status (
  provider TEXT PRIMARY KEY CHECK(provider IN ('codex', 'claude')),
  cli_path TEXT NOT NULL,
  version TEXT,
  verified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  channel_id TEXT,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  slack_ts TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS slack_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  bot_token TEXT,
  channel_id TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ntfy_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  topic TEXT,
  server_url TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 오래 아무 활동이 없는 채팅 터미널의 자동 종료 정책. 되돌릴 수 없는 동작이라 관리자가 언제든
-- 끌 수 있도록 DB에 정책을 두고, 기준 시간도 운영 상황에 맞춰 늘릴 수 있게 한다.
CREATE TABLE IF NOT EXISTS idle_chat_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 1,
  timeout_hours INTEGER NOT NULL DEFAULT 24,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Slack과 별도 테이블로 둔다: ntfy는 채널 개념(channel_id) 없이 topic 하나뿐이고, 전송 성공/실패가
-- Slack과 독립적이라 같은 이벤트라도 각자 따로 재시도·기록해야 한다.
CREATE TABLE IF NOT EXISTS ntfy_deliveries (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- rate_limit_options 화면에서 "재설정까지 대기"를 자동 선택한 채팅을 기록해둔다.
-- 실제 리셋 시각이 되면 rate-limit-resume 서비스가 이 목록을 보고 "계속"을 보내 이어가게 한다.
CREATE TABLE IF NOT EXISTS rate_limit_waits (
  chat_id INTEGER PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  resume_after TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS context_snapshots (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS delegations (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  parent_delegation_id TEXT,
  depth INTEGER NOT NULL DEFAULT 0,
  source_chat_id INTEGER REFERENCES chats(id) ON DELETE SET NULL,
  target_chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'sent', 'failed')),
  error TEXT,
  baseline_message_count INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 공급자별 인증 계정 슬롯. 계정마다 CLI 설정 디렉터리를 따로 두고 실행 시 환경변수로 지정하는 방식이라
-- (Claude는 CLAUDE_CONFIG_DIR, Codex는 CODEX_HOME) 인증 파일을 백업·교체하지 않고도 계정을 나눠 쓸 수 있다.
-- config_dir가 NULL인 행은 CLI 기본 디렉터리(~/.claude, ~/.codex)를 그대로 쓰는 기본 계정으로,
-- 기존 인증을 건드리지 않기 위해 환경변수를 주입하지 않는다.
CREATE TABLE IF NOT EXISTS agent_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL CHECK(provider IN ('codex', 'claude')),
  label TEXT NOT NULL,
  slug TEXT NOT NULL,
  config_dir TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider, slug)
);

-- 상태 조회 PTY는 계정마다 하나씩 상시 실행되어 비용이 크므로, 기본은 기본 계정만 조회하고
-- 필요할 때만 등록된 전 계정으로 넓힌다.
CREATE TABLE IF NOT EXISTS usage_monitor_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  scope TEXT NOT NULL DEFAULT 'default' CHECK (scope IN ('default', 'all')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_chats_project ON chats(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_accounts_provider ON agent_accounts(provider, id);
CREATE INDEX IF NOT EXISTS idx_approvals_chat ON approvals(chat_id, status);
CREATE INDEX IF NOT EXISTS idx_context_snapshots_expiry ON context_snapshots(expires_at);
CREATE INDEX IF NOT EXISTS idx_delegations_target ON delegations(target_chat_id, updated_at DESC);
`;

// SQLite 연결을 열고 필요한 스키마를 생성한다.
export function openDatabase(config: AppConfig): AppDatabase {
  const database = new Database(path.join(config.dataDir, "web-agent-manager.sqlite"));
  database.pragma("busy_timeout = 5000");
  database.exec(schema);
  const usageColumns = database.prepare("PRAGMA table_info(usage_status)").all() as Array<{ name: string }>;
  const userColumns = database.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  if (!userColumns.some((column) => column.name === "last_project_id")) {
    database.exec("ALTER TABLE users ADD COLUMN last_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL");
  }
  if (!userColumns.some((column) => column.name === "last_chat_id")) {
    database.exec("ALTER TABLE users ADD COLUMN last_chat_id INTEGER REFERENCES chats(id) ON DELETE SET NULL");
  }
  if (!userColumns.some((column) => column.name === "chat_view_mode")) {
    database.exec("ALTER TABLE users ADD COLUMN chat_view_mode TEXT NOT NULL DEFAULT 'chat' CHECK(chat_view_mode IN ('chat', 'terminal'))");
  }
  if (!usageColumns.some((column) => column.name === "details_json")) {
    database.exec("ALTER TABLE usage_status ADD COLUMN details_json TEXT");
  }
  // 초기 구현은 공급자당 예약 하나만 저장해 Claude 세션과 주간 창을 동시에 추적할 수 없었다.
  // 기존 행을 보존하면서 provider+window_id 복합 키 테이블로 한 번만 재구성한다.
  const resetScheduleColumns = database.prepare("PRAGMA table_info(usage_reset_schedules)").all() as Array<{ name: string; pk: number }>;
  const resetSchedulePrimaryKey = resetScheduleColumns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);
  if (resetSchedulePrimaryKey.join(",") !== "provider,window_id") {
    database.transaction(() => {
      database.exec("ALTER TABLE usage_reset_schedules RENAME TO usage_reset_schedules_legacy");
      database.exec(`
        CREATE TABLE usage_reset_schedules (
          provider TEXT NOT NULL CHECK(provider IN ('codex', 'claude')),
          window_id TEXT NOT NULL,
          scheduled_reset_at TEXT NOT NULL,
          used_percent REAL,
          notified_at TEXT,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY(provider, window_id)
        )
      `);
      database.exec(`
        INSERT INTO usage_reset_schedules(provider, window_id, scheduled_reset_at, used_percent, notified_at, updated_at)
        SELECT provider, window_id, scheduled_reset_at, used_percent, notified_at, updated_at
        FROM usage_reset_schedules_legacy
      `);
      database.exec("DROP TABLE usage_reset_schedules_legacy");
    })();
  }
  const chatColumns = database.prepare("PRAGMA table_info(chats)").all() as Array<{ name: string }>;
  if (!chatColumns.some((column) => column.name === "model")) {
    database.exec("ALTER TABLE chats ADD COLUMN model TEXT");
  }
  // "작업중" 여부를 클라이언트가 웹소켓 이벤트만으로 추측(놓치면 영영 안 풀리거나, 다시 시작 전 상태를
  // 완료로 오판)하지 않도록 서버가 채팅별로 직접 관리해 /chats 목록에 실제 값을 내려준다.
  if (!chatColumns.some((column) => column.name === "busy")) {
    database.exec("ALTER TABLE chats ADD COLUMN busy INTEGER NOT NULL DEFAULT 0");
  }
  // Claude 하단 상태줄에서 감지한 현재 권한 모드 문구("auto mode on" 등)를 그대로 저장한다.
  if (!chatColumns.some((column) => column.name === "permission_mode")) {
    database.exec("ALTER TABLE chats ADD COLUMN permission_mode TEXT");
  }
  // 제목을 사람이 /rename 등으로 직접 바꿨는지(manual) 표시한다. NULL(기존 행 전부 포함)은 자동 파생을
  // 뜻해, history-sync가 공급자 쪽 더 나은 제목(CLI 표시 이름·aiTitle)이 생기면 계속 갱신해도 안전하다.
  // manual이면 history-sync가 절대 덮어쓰지 않는다.
  if (!chatColumns.some((column) => column.name === "title_source")) {
    database.exec("ALTER TABLE chats ADD COLUMN title_source TEXT");
  }
  // 채팅이 공유 checkout 또는 전용·외부 worktree 중 어디서 실행되는지 서버 재시작 뒤에도 복원한다.
  if (!chatColumns.some((column) => column.name === "git_branch")) {
    database.exec("ALTER TABLE chats ADD COLUMN git_branch TEXT");
  }
  if (!chatColumns.some((column) => column.name === "worktree_path")) {
    database.exec("ALTER TABLE chats ADD COLUMN worktree_path TEXT");
  }
  const waitColumns = database.prepare("PRAGMA table_info(rate_limit_waits)").all() as Array<{ name: string }>;
  if (!waitColumns.some((column) => column.name === "resume_after")) {
    database.exec("ALTER TABLE rate_limit_waits ADD COLUMN resume_after TEXT");
  }
  const delegationColumns = database.prepare("PRAGMA table_info(delegations)").all() as Array<{ name: string }>;
  if (!delegationColumns.some((column) => column.name === "parent_delegation_id")) {
    database.exec("ALTER TABLE delegations ADD COLUMN parent_delegation_id TEXT");
  }
  if (!delegationColumns.some((column) => column.name === "depth")) {
    database.exec("ALTER TABLE delegations ADD COLUMN depth INTEGER NOT NULL DEFAULT 0");
  }
  if (!delegationColumns.some((column) => column.name === "baseline_message_count")) {
    database.exec("ALTER TABLE delegations ADD COLUMN baseline_message_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!delegationColumns.some((column) => column.name === "result_json")) {
    database.exec("ALTER TABLE delegations ADD COLUMN result_json TEXT");
  }
  if (!delegationColumns.some((column) => column.name === "completed_at")) {
    database.exec("ALTER TABLE delegations ADD COLUMN completed_at TEXT");
  }
  migrateAgentAccounts(database);
  database.prepare("DELETE FROM web_sessions WHERE expires_at <= datetime('now')").run();
  return database;
}

// 공급자별 기본 계정을 보장하고, 계정 개념 도입 이전에 만들어진 채팅·사용량 행을 그 기본 계정에 귀속시킨다.
// 기본 계정은 config_dir가 NULL이라 환경변수를 주입하지 않으므로, 기존 ~/.claude·~/.codex 인증이 그대로 쓰인다.
function migrateAgentAccounts(database: AppDatabase): void {
  for (const provider of ["codex", "claude"] as const) {
    database.prepare(`
      INSERT INTO agent_accounts(provider, label, slug, config_dir, is_default)
      SELECT ?, ?, 'default', NULL, 1
      WHERE NOT EXISTS (SELECT 1 FROM agent_accounts WHERE provider = ? AND is_default = 1)
    `).run(provider, provider === "claude" ? "기본 Claude 계정" : "기본 Codex 계정", provider);
  }
  const chatColumns = database.prepare("PRAGMA table_info(chats)").all() as Array<{ name: string }>;
  if (!chatColumns.some((column) => column.name === "account_id")) {
    database.exec("ALTER TABLE chats ADD COLUMN account_id INTEGER REFERENCES agent_accounts(id) ON DELETE SET NULL");
  }
  // account_id가 비어 있는 채팅(기존 행 전부)은 자기 공급자의 기본 계정에서 만들어진 것이다.
  database.exec(`
    UPDATE chats SET account_id = (SELECT id FROM agent_accounts a WHERE a.provider = chats.provider AND a.is_default = 1)
    WHERE account_id IS NULL
  `);
  // 사용량은 공급자당 한 행이었지만 계정마다 한도가 따로라 (provider, account_id) 복합 키로 재구성한다.
  const usageColumns = database.prepare("PRAGMA table_info(usage_status)").all() as Array<{ name: string; pk: number }>;
  if (!usageColumns.some((column) => column.name === "account_id")) {
    database.transaction(() => {
      database.exec("ALTER TABLE usage_status RENAME TO usage_status_legacy");
      database.exec(`
        CREATE TABLE usage_status (
          provider TEXT NOT NULL,
          account_id INTEGER NOT NULL,
          monitor_status TEXT NOT NULL DEFAULT 'starting',
          data_status TEXT NOT NULL DEFAULT 'unavailable',
          error_code TEXT,
          summary TEXT,
          used_percent REAL,
          remaining_percent REAL,
          reset_at TEXT,
          details_json TEXT,
          last_checked_at TEXT,
          last_success_at TEXT,
          PRIMARY KEY(provider, account_id)
        )
      `);
      database.exec(`
        INSERT INTO usage_status(provider, account_id, monitor_status, data_status, error_code, summary,
          used_percent, remaining_percent, reset_at, details_json, last_checked_at, last_success_at)
        SELECT l.provider, (SELECT id FROM agent_accounts a WHERE a.provider = l.provider AND a.is_default = 1),
          l.monitor_status, l.data_status, l.error_code, l.summary,
          l.used_percent, l.remaining_percent, l.reset_at, l.details_json, l.last_checked_at, l.last_success_at
        FROM usage_status_legacy l
        WHERE EXISTS (SELECT 1 FROM agent_accounts a WHERE a.provider = l.provider AND a.is_default = 1)
      `);
      database.exec("DROP TABLE usage_status_legacy");
    })();
  }
  database.prepare("INSERT OR IGNORE INTO usage_monitor_settings(id, scope) VALUES (1, 'default')").run();
}
