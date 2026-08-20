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

-- 내부망에서 관리자가 등록한 Android Keystore 공개키만 저장한다. 개인키는 기기 밖으로 나오지 않는다.
CREATE TABLE IF NOT EXISTS mobile_trusted_devices (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  label TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TEXT,
  UNIQUE(user_id, key_fingerprint)
);

CREATE TABLE IF NOT EXISTS web_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  mobile_trusted_device_id TEXT REFERENCES mobile_trusted_devices(id) ON DELETE SET NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 외부망 앱 인증 challenge는 웹 세션당 하나만 두고 짧은 만료와 1회 사용을 강제한다.
CREATE TABLE IF NOT EXISTS mobile_trust_challenges (
  web_session_id INTEGER PRIMARY KEY REFERENCES web_sessions(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES mobile_trusted_devices(id) ON DELETE CASCADE,
  challenge_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 로그인 쿠키가 없는 새 외부 origin은 등록 기기 서명으로만 짧은 challenge를 소비해 세션을 만든다.
CREATE TABLE IF NOT EXISTS mobile_trust_login_challenges (
  device_id TEXT PRIMARY KEY REFERENCES mobile_trusted_devices(id) ON DELETE CASCADE,
  challenge_hash TEXT NOT NULL,
  origin TEXT NOT NULL,
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
  provider TEXT NOT NULL CHECK(provider IN ('codex', 'claude', 'grok')),
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
  provider TEXT NOT NULL CHECK(provider IN ('codex', 'claude', 'grok')),
  window_id TEXT NOT NULL,
  scheduled_reset_at TEXT NOT NULL,
  used_percent REAL,
  notified_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(provider, window_id)
);

-- 한 번 정상 검증된 에이전트 연동은 재시작 뒤에도 무거운 CLI 상태 검사를 반복하지 않는다.
CREATE TABLE IF NOT EXISTS agent_integration_status (
  provider TEXT PRIMARY KEY CHECK(provider IN ('codex', 'claude', 'grok')),
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

-- Android 앱이 로그인 세션으로 등록한 FCM 대상이다. 토큰은 API 응답·로그에 다시 노출하지 않고
-- Firebase 전송과 토큰 회전 시 교체에만 사용한다.
CREATE TABLE IF NOT EXISTS push_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL DEFAULT 'android' CHECK(platform IN ('android')),
  token TEXT NOT NULL UNIQUE,
  label TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Slack·ntfy와 마찬가지로 FCM도 이벤트·기기별 성공 여부를 독립적으로 기록한다.
CREATE TABLE IF NOT EXISTS fcm_deliveries (
  event_id TEXT NOT NULL,
  device_id INTEGER NOT NULL REFERENCES push_devices(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(event_id, device_id)
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
  history_prompt TEXT,
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
  provider TEXT NOT NULL CHECK(provider IN ('codex', 'claude', 'grok')),
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

-- 빈 사용량 창을 실제 최소 턴으로 활성화한 마지막 시각과 초기화 창을 계정별로 보존한다.
CREATE TABLE IF NOT EXISTS usage_keepalive_prompts (
  provider TEXT NOT NULL CHECK(provider IN ('codex', 'claude', 'grok')),
  account_id INTEGER NOT NULL REFERENCES agent_accounts(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  window_key TEXT,
  PRIMARY KEY(provider, account_id)
);

-- 공급자 JSONL이나 채팅 row가 삭제된 뒤에도 메시지별 토큰 사용량과 당시 분류 정보를 보존한다.
CREATE TABLE IF NOT EXISTS token_usage_events (
  provider TEXT NOT NULL CHECK(provider IN ('codex', 'claude', 'grok')),
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  account_id INTEGER,
  account_label TEXT,
  project_id INTEGER,
  project_name TEXT,
  project_path TEXT,
  chat_id INTEGER,
  chat_title TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  chat_deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(provider, session_id, message_id)
);

-- 하나의 명령과 평가 기준을 공유하는 에이전트 비교 실험이다.
CREATE TABLE IF NOT EXISTS experiment_suites (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS experiment_fixtures (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  pinned_commit TEXT NOT NULL,
  size_class TEXT NOT NULL CHECK(size_class IN ('small', 'medium', 'large')),
  language TEXT,
  license TEXT,
  lines_of_code INTEGER,
  setup_command_json TEXT NOT NULL DEFAULT '[]',
  test_command_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'ready', 'rejected')),
  gate_json TEXT NOT NULL DEFAULT '{}',
  mirror_path TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  command TEXT NOT NULL,
  design_json TEXT NOT NULL DEFAULT '{"schemaVersion":1,"hypothesis":null,"controlledVariables":[],"treatmentVariables":[],"repetitions":1,"randomizeOrder":true}',
  rubric_json TEXT NOT NULL DEFAULT '{}',
  suite_id TEXT REFERENCES experiment_suites(id) ON DELETE SET NULL,
  task_kind TEXT CHECK(task_kind IN ('maintenance', 'greenfield', 'feature', 'security')),
  fixture_id TEXT REFERENCES experiment_fixtures(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'active', 'archived')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 모델·스킬·하네스·예산 등 한 묶음의 비교 실행 조건을 버전 JSON으로 고정한다.
CREATE TABLE IF NOT EXISTS experiment_variants (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(experiment_id, name)
);

-- 변형을 실제로 한 번 수행한 기록과 실행 시점의 해석된 설정·사용량을 보존한다.
CREATE TABLE IF NOT EXISTS experiment_runs (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL REFERENCES experiment_variants(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'preparing', 'running', 'paused', 'evaluating', 'completed', 'failed', 'cancelled', 'budget_exceeded')),
  config_snapshot_json TEXT NOT NULL,
  environment_snapshot_json TEXT NOT NULL DEFAULT '{}',
  baseline_commit TEXT,
  working_directory TEXT,
  provider_run_id TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens_source TEXT CHECK(total_tokens_source IN ('reported', 'derived')),
  cost_usd REAL,
  termination_reason TEXT,
  error TEXT,
  waited_seconds REAL NOT NULL DEFAULT 0,
  wait_count INTEGER NOT NULL DEFAULT 0,
  check_status TEXT CHECK(check_status IN ('passed', 'failed', 'skipped', 'error')),
  check_exit_code INTEGER,
  check_duration_ms INTEGER,
  check_output TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(variant_id, attempt)
);

-- 하네스 그래프에서 한 에이전트 호출을 노드로 기록해 반복·부모 관계를 추적한다.
CREATE TABLE IF NOT EXISTS experiment_run_plans (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK(stage IN ('screening', 'grid', 'confirmation')),
  repetitions INTEGER NOT NULL,
  baseline_commit TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'running', 'completed', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS experiment_run_plan_items (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES experiment_run_plans(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL REFERENCES experiment_variants(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  repetition INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'running', 'completed', 'failed', 'skipped')),
  run_id TEXT REFERENCES experiment_runs(id) ON DELETE SET NULL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(plan_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_experiment_run_plan_items_plan ON experiment_run_plan_items(plan_id, ordinal);
CREATE TABLE IF NOT EXISTS experiment_nodes (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES experiment_runs(id) ON DELETE CASCADE,
  parent_node_id TEXT REFERENCES experiment_nodes(id) ON DELETE SET NULL,
  role TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  provider TEXT CHECK(provider IN ('codex', 'claude')),
  model TEXT,
  input_json TEXT NOT NULL DEFAULT '{}',
  output_json TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens_source TEXT CHECK(total_tokens_source IN ('reported', 'derived')),
  cost_usd REAL,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(run_id, ordinal, attempt)
);

-- 실행의 모든 관측과 상태 변화는 멱등 키를 가진 append-only 이벤트로 남긴다.
CREATE TABLE IF NOT EXISTS experiment_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES experiment_runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(run_id, sequence),
  UNIQUE(run_id, idempotency_key)
);

-- run마다 가장 최근의 확정 노드 경계만 저장하고 더 오래된 순번으로 되돌아가지 않는다.
CREATE TABLE IF NOT EXISTS experiment_checkpoints (
  run_id TEXT PRIMARY KEY REFERENCES experiment_runs(id) ON DELETE CASCADE,
  node_id TEXT REFERENCES experiment_nodes(id) ON DELETE SET NULL,
  event_sequence INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 파일·패치·보고서 등 실행 결과의 경로와 무결성 정보만 보존한다.
CREATE TABLE IF NOT EXISTS experiment_artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES experiment_runs(id) ON DELETE CASCADE,
  node_id TEXT REFERENCES experiment_nodes(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 한 실험의 복수 run을 블라인드 루브릭이나 쌍대 방식으로 평가한 라운드다.
CREATE TABLE IF NOT EXISTS experiment_evaluations (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK(method IN ('deterministic', 'rubric', 'pairwise')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'running', 'completed', 'partial', 'failed', 'cancelled')),
  rubric_json TEXT NOT NULL,
  blind_map_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT
);

-- 평가가 실행되기 전에도 대상 run과 블라인드 라벨·제시 순서를 조회할 수 있게 관계를 분리한다.
CREATE TABLE IF NOT EXISTS experiment_evaluation_subjects (
  evaluation_id TEXT NOT NULL REFERENCES experiment_evaluations(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES experiment_runs(id) ON DELETE CASCADE,
  blind_label TEXT NOT NULL,
  presentation_order INTEGER NOT NULL,
  PRIMARY KEY(evaluation_id, run_id),
  UNIQUE(evaluation_id, blind_label),
  UNIQUE(evaluation_id, presentation_order)
);

-- evaluator CLI 한 번의 상태·usage·비용을 판정 행과 분리해 pairwise 이중 계상을 막는다.
CREATE TABLE IF NOT EXISTS experiment_evaluation_calls (
  id TEXT PRIMARY KEY,
  evaluation_id TEXT NOT NULL REFERENCES experiment_evaluations(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  evaluator_label TEXT NOT NULL,
  evaluator_provider TEXT NOT NULL CHECK(evaluator_provider IN ('codex', 'claude')),
  evaluator_model TEXT,
  evaluator_family TEXT,
  evaluator_account_id INTEGER REFERENCES agent_accounts(id) ON DELETE SET NULL,
  evaluator_cli_version TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens_source TEXT CHECK(total_tokens_source IN ('reported', 'derived')),
  cost_usd REAL,
  duration_ms INTEGER,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  UNIQUE(evaluation_id, idempotency_key)
);

-- 심사 에이전트 한 명의 구조화 점수·근거·비용을 다른 심사와 분리해 저장한다.
CREATE TABLE IF NOT EXISTS experiment_judgments (
  id TEXT PRIMARY KEY,
  evaluation_id TEXT NOT NULL REFERENCES experiment_evaluations(id) ON DELETE CASCADE,
  call_id TEXT REFERENCES experiment_evaluation_calls(id) ON DELETE CASCADE,
  idempotency_key TEXT,
  run_id TEXT NOT NULL REFERENCES experiment_runs(id) ON DELETE CASCADE,
  evaluator_label TEXT NOT NULL,
  evaluator_kind TEXT NOT NULL DEFAULT 'agent' CHECK(evaluator_kind IN ('agent', 'human', 'deterministic')),
  evaluator_provider TEXT CHECK(evaluator_provider IN ('codex', 'claude')),
  evaluator_model TEXT,
  evaluator_family TEXT,
  subject_provider TEXT CHECK(subject_provider IN ('codex', 'claude')),
  subject_model TEXT,
  subject_family TEXT,
  same_family INTEGER NOT NULL DEFAULT 0,
  blind_label TEXT,
  presentation_order INTEGER,
  score REAL,
  confidence REAL,
  rank INTEGER,
  result_json TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens_source TEXT CHECK(total_tokens_source IN ('reported', 'derived')),
  cost_usd REAL,
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 자동 평가와 독립된 사용자의 최종 채택·기각·보류 판단을 이력으로 남긴다.
CREATE TABLE IF NOT EXISTS experiment_human_verdicts (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  selected_variant_id TEXT REFERENCES experiment_variants(id) ON DELETE SET NULL,
  verdict TEXT NOT NULL CHECK(verdict IN ('accepted', 'rejected', 'deferred')),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 실험에서 검증한 설정을 실제 프로젝트 작업에서 선택할 수 있는 이름 있는 preset이다.
CREATE TABLE IF NOT EXISTS agent_presets (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'active', 'archived')),
  active_version INTEGER,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id, name)
);

-- 승격한 run 설정과 당시 비교 지표·출처를 불변 버전으로 보존해 활성 전환과 롤백을 지원한다.
CREATE TABLE IF NOT EXISTS agent_preset_versions (
  id TEXT PRIMARY KEY,
  preset_id TEXT NOT NULL REFERENCES agent_presets(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  config_snapshot_json TEXT NOT NULL,
  source_experiment_id TEXT REFERENCES experiments(id) ON DELETE SET NULL,
  source_variant_id TEXT REFERENCES experiment_variants(id) ON DELETE SET NULL,
  source_run_id TEXT REFERENCES experiment_runs(id) ON DELETE SET NULL,
  promotion_metrics_json TEXT NOT NULL DEFAULT '{}',
  compatibility_json TEXT NOT NULL DEFAULT '{}',
  validated_at TEXT,
  note TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(preset_id, version)
);

CREATE INDEX IF NOT EXISTS idx_chats_project ON chats(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_accounts_provider ON agent_accounts(provider, id);
CREATE INDEX IF NOT EXISTS idx_approvals_chat ON approvals(chat_id, status);
CREATE INDEX IF NOT EXISTS idx_context_snapshots_expiry ON context_snapshots(expires_at);
CREATE INDEX IF NOT EXISTS idx_delegations_target ON delegations(target_chat_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_push_devices_user ON push_devices(user_id, active);
CREATE INDEX IF NOT EXISTS idx_mobile_trusted_devices_user ON mobile_trusted_devices(user_id, active);
CREATE INDEX IF NOT EXISTS idx_token_usage_events_occurred ON token_usage_events(occurred_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_events_project ON token_usage_events(project_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_events_chat ON token_usage_events(chat_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_experiments_project ON experiments(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_experiment_variants_experiment ON experiment_variants(experiment_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_experiment_runs_experiment ON experiment_runs(experiment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_experiment_runs_variant ON experiment_runs(variant_id, attempt DESC);
CREATE INDEX IF NOT EXISTS idx_experiment_nodes_run ON experiment_nodes(run_id, ordinal, attempt);
CREATE INDEX IF NOT EXISTS idx_experiment_events_run ON experiment_events(run_id, sequence);
CREATE INDEX IF NOT EXISTS idx_experiment_artifacts_run ON experiment_artifacts(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_experiment_evaluations_experiment ON experiment_evaluations(experiment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_experiment_evaluation_subjects_run ON experiment_evaluation_subjects(run_id, evaluation_id);
CREATE INDEX IF NOT EXISTS idx_experiment_evaluation_calls_evaluation ON experiment_evaluation_calls(evaluation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_experiment_judgments_evaluation ON experiment_judgments(evaluation_id, run_id);
CREATE INDEX IF NOT EXISTS idx_experiment_judgments_run ON experiment_judgments(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_presets_project ON agent_presets(project_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_preset_versions_preset ON agent_preset_versions(preset_id, version DESC);
`;

// SQLite 연결을 열고 필요한 스키마를 생성한다.
export function openDatabase(config: AppConfig): AppDatabase {
  const database = new Database(path.join(config.dataDir, "web-agent-manager.sqlite"));
  database.pragma("busy_timeout = 5000");
  database.exec(schema);
  const usageColumns = database.prepare("PRAGMA table_info(usage_status)").all() as Array<{ name: string }>;
  const evaluationColumns = database.prepare("PRAGMA table_info(experiment_evaluations)").all() as Array<{ name: string }>;
  const judgmentColumns = database.prepare("PRAGMA table_info(experiment_judgments)").all() as Array<{ name: string }>;
  const userColumns = database.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  const sessionColumns = database.prepare("PRAGMA table_info(web_sessions)").all() as Array<{ name: string }>;
  if (!sessionColumns.some((column) => column.name === "mobile_trusted_device_id")) {
    database.exec("ALTER TABLE web_sessions ADD COLUMN mobile_trusted_device_id TEXT REFERENCES mobile_trusted_devices(id) ON DELETE SET NULL");
  }
  const mobileLoginChallengeColumns = database.prepare("PRAGMA table_info(mobile_trust_login_challenges)").all() as Array<{ name: string }>;
  if (!mobileLoginChallengeColumns.some((column) => column.name === "origin")) {
    database.exec("ALTER TABLE mobile_trust_login_challenges ADD COLUMN origin TEXT NOT NULL DEFAULT ''");
  }
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
  if (!evaluationColumns.some((column) => column.name === "error")) {
    database.exec("ALTER TABLE experiment_evaluations ADD COLUMN error TEXT");
  }
  if (!judgmentColumns.some((column) => column.name === "call_id")) {
    database.exec("ALTER TABLE experiment_judgments ADD COLUMN call_id TEXT REFERENCES experiment_evaluation_calls(id) ON DELETE CASCADE");
  }
  if (!judgmentColumns.some((column) => column.name === "idempotency_key")) {
    database.exec("ALTER TABLE experiment_judgments ADD COLUMN idempotency_key TEXT");
  }
  const runColumns = database.prepare("PRAGMA table_info(experiment_runs)").all() as Array<{ name: string }>;
  if (!runColumns.some((column) => column.name === "waited_seconds")) {
    database.exec("ALTER TABLE experiment_runs ADD COLUMN waited_seconds REAL NOT NULL DEFAULT 0");
  }
  if (!runColumns.some((column) => column.name === "wait_count")) {
    database.exec("ALTER TABLE experiment_runs ADD COLUMN wait_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!runColumns.some((column) => column.name === "check_status")) {
    database.exec("ALTER TABLE experiment_runs ADD COLUMN check_status TEXT CHECK(check_status IN ('passed', 'failed', 'skipped', 'error'))");
    database.exec("ALTER TABLE experiment_runs ADD COLUMN check_exit_code INTEGER");
    database.exec("ALTER TABLE experiment_runs ADD COLUMN check_duration_ms INTEGER");
    database.exec("ALTER TABLE experiment_runs ADD COLUMN check_output TEXT");
  }
  const experimentColumns = database.prepare("PRAGMA table_info(experiments)").all() as Array<{ name: string }>;
  if (!experimentColumns.some((column) => column.name === "task_kind")) {
    database.exec("ALTER TABLE experiments ADD COLUMN task_kind TEXT CHECK(task_kind IN ('maintenance', 'greenfield', 'feature', 'security'))");
  }
  if (!experimentColumns.some((column) => column.name === "suite_id")) {
    database.exec("ALTER TABLE experiments ADD COLUMN suite_id TEXT REFERENCES experiment_suites(id) ON DELETE SET NULL");
  }
  if (!experimentColumns.some((column) => column.name === "fixture_id")) {
    database.exec("ALTER TABLE experiments ADD COLUMN fixture_id TEXT REFERENCES experiment_fixtures(id) ON DELETE SET NULL");
  }
  const planColumns = database.prepare("PRAGMA table_info(experiment_run_plans)").all() as Array<{ name: string }>;
  if (planColumns.length && !planColumns.some((column) => column.name === "baseline_commit")) {
    database.exec("ALTER TABLE experiment_run_plans ADD COLUMN baseline_commit TEXT");
  }
  const presetChatColumns = database.prepare("PRAGMA table_info(chats)").all() as Array<{ name: string }>;
  if (!presetChatColumns.some((column) => column.name === "preset_version_id")) {
    database.exec("ALTER TABLE chats ADD COLUMN preset_version_id TEXT REFERENCES agent_preset_versions(id) ON DELETE SET NULL");
    database.exec("ALTER TABLE chats ADD COLUMN preset_config_json TEXT");
  }
  database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_experiment_judgments_idempotency ON experiment_judgments(evaluation_id, idempotency_key) WHERE idempotency_key IS NOT NULL");
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
  // 초기 구현은 마지막 전송 시각만 저장해 실제 초기화 창보다 늦게 다음 단답을 보낼 수 있었다.
  const keepaliveColumns = database.prepare("PRAGMA table_info(usage_keepalive_prompts)").all() as Array<{ name: string }>;
  if (!keepaliveColumns.some((column) => column.name === "window_key")) {
    database.exec("ALTER TABLE usage_keepalive_prompts ADD COLUMN window_key TEXT");
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
  if (!delegationColumns.some((column) => column.name === "history_prompt")) {
    database.exec("ALTER TABLE delegations ADD COLUMN history_prompt TEXT");
  }
  // 실험 런타임은 Claude 캐시 생성·읽기와 합계의 보고/파생 provenance를 과거 원장과 호환되게 확장한다.
  const experimentRunColumns = database.prepare("PRAGMA table_info(experiment_runs)").all() as Array<{ name: string }>;
  if (!experimentRunColumns.some((column) => column.name === "cache_creation_input_tokens")) {
    database.exec("ALTER TABLE experiment_runs ADD COLUMN cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0");
  }
  if (!experimentRunColumns.some((column) => column.name === "cache_read_input_tokens")) {
    database.exec("ALTER TABLE experiment_runs ADD COLUMN cache_read_input_tokens INTEGER NOT NULL DEFAULT 0");
  }
  if (!experimentRunColumns.some((column) => column.name === "total_tokens_source")) {
    database.exec("ALTER TABLE experiment_runs ADD COLUMN total_tokens_source TEXT CHECK(total_tokens_source IN ('reported', 'derived'))");
  }
  if (!experimentRunColumns.some((column) => column.name === "cost_usd")) {
    database.exec("ALTER TABLE experiment_runs ADD COLUMN cost_usd REAL");
  }
  for (const table of ["experiment_nodes", "experiment_judgments"] as const) {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "cache_creation_input_tokens")) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0`);
    }
    if (!columns.some((column) => column.name === "cache_read_input_tokens")) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN cache_read_input_tokens INTEGER NOT NULL DEFAULT 0`);
    }
    if (!columns.some((column) => column.name === "total_tokens_source")) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN total_tokens_source TEXT CHECK(total_tokens_source IN ('reported', 'derived'))`);
    }
    if (!columns.some((column) => column.name === "cost_usd")) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN cost_usd REAL`);
    }
  }
  migrateProviderCheckConstraint(database);
  migrateAgentAccounts(database);
  database.prepare("DELETE FROM web_sessions WHERE expires_at <= datetime('now')").run();
  database.prepare("DELETE FROM mobile_trust_challenges WHERE expires_at <= datetime('now')").run();
  database.prepare("DELETE FROM mobile_trust_login_challenges WHERE expires_at <= datetime('now')").run();
  return database;
}

// 공급자 CHECK 제약에 나중에 추가된 공급자(grok)를 반영한다. SQLite는 제약만 바꾸는 ALTER를 지원하지
// 않아 테이블을 통째로 다시 만들어야 하는데, 스키마 상수를 그대로 쓰면 그동안 ADD COLUMN으로 늘어난
// 컬럼이 빠진다 — 그래서 현재 DB에 실제로 저장된 CREATE 문을 읽어 제약 문구만 치환한다.
// 실험실 테이블(experiment_*)은 아직 grok을 지원하지 않으므로 대상에서 뺀다.
const PROVIDER_CHECK_TABLES = ["chats", "usage_reset_schedules", "agent_integration_status", "agent_accounts", "usage_keepalive_prompts", "token_usage_events"];

function migrateProviderCheckConstraint(database: AppDatabase): void {
  const tableSql = (table: string): string | null => {
    const row = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string | null } | undefined;
    return row?.sql ?? null;
  };
  const pending = PROVIDER_CHECK_TABLES.filter((table) => {
    const sql = tableSql(table);
    return !!sql && sql.includes("'codex', 'claude'") && !sql.includes("'grok'");
  });
  if (!pending.length) return;
  // 재생성 중에는 외래키를 꺼야 한다. chats를 ON DELETE CASCADE로 참조하는 테이블이 여럿이라, 켜둔 채
  // DROP TABLE을 하면 승인·토큰 사용량 등 연결된 행이 통째로 지워진다.
  database.pragma("foreign_keys = OFF");
  // RENAME이 다른 테이블의 외래키 참조까지 임시 이름으로 고쳐 쓰지 않게 예전 동작으로 되돌린다.
  database.pragma("legacy_alter_table = ON");
  try {
    database.transaction(() => {
      for (const table of pending) {
        const sql = tableSql(table);
        if (!sql) continue;
        const indexes = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL").all(table) as Array<{ sql: string }>;
        const temporary = `${table}_provider_check_migration`;
        database.exec(sql
          .replace(/CREATE TABLE\s+"?[A-Za-z_][A-Za-z0-9_]*"?/, `CREATE TABLE ${temporary}`)
          .replace(/IN \('codex', 'claude'\)/g, "IN ('codex', 'claude', 'grok')"));
        // 원본 CREATE 문을 그대로 쓴 덕분에 컬럼 순서가 같아 위치 기반 복사가 안전하다.
        database.exec(`INSERT INTO ${temporary} SELECT * FROM ${table}`);
        database.exec(`DROP TABLE ${table}`);
        database.exec(`ALTER TABLE ${temporary} RENAME TO ${table}`);
        // DROP TABLE에서 같이 사라진 인덱스를 원래 정의 그대로 되살린다.
        for (const index of indexes) database.exec(index.sql);
      }
    })();
    const violations = database.pragma("foreign_key_check") as unknown[];
    if (violations.length) throw new Error(`공급자 제약 마이그레이션 후 외래키 위반이 ${violations.length}건 발견되었습니다.`);
  } finally {
    database.pragma("legacy_alter_table = OFF");
    database.pragma("foreign_keys = ON");
  }
}

// 공급자별 기본 계정을 보장하고, 계정 개념 도입 이전에 만들어진 채팅·사용량 행을 그 기본 계정에 귀속시킨다.
// 기본 계정은 config_dir가 NULL이라 환경변수를 주입하지 않으므로, 기존 ~/.claude·~/.codex·~/.grok 인증이 그대로 쓰인다.
function migrateAgentAccounts(database: AppDatabase): void {
  const defaultLabels = { codex: "기본 Codex 계정", claude: "기본 Claude 계정", grok: "기본 Grok 계정" } as const;
  for (const provider of ["codex", "claude", "grok"] as const) {
    database.prepare(`
      INSERT INTO agent_accounts(provider, label, slug, config_dir, is_default)
      SELECT ?, ?, 'default', NULL, 1
      WHERE NOT EXISTS (SELECT 1 FROM agent_accounts WHERE provider = ? AND is_default = 1)
    `).run(provider, defaultLabels[provider], provider);
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
