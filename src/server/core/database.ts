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

CREATE INDEX IF NOT EXISTS idx_chats_project ON chats(project_id, updated_at DESC);
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
  if (!usageColumns.some((column) => column.name === "details_json")) {
    database.exec("ALTER TABLE usage_status ADD COLUMN details_json TEXT");
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
  database.prepare("DELETE FROM web_sessions WHERE expires_at <= datetime('now')").run();
  return database;
}
