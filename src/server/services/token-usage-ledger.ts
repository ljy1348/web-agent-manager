import type { AppDatabase } from "../core/database";
import type { HistorySession } from "../providers/provider";

export type TokenUsageGroup = "day" | "project" | "chat" | "provider" | "account" | "model";

export interface TokenUsageSnapshot {
  accountId: number | null;
  accountLabel: string | null;
  projectId: number | null;
  projectName: string | null;
  projectPath: string | null;
  chatId: number | null;
  chatTitle: string | null;
  model: string | null;
  chatDeleted: boolean;
}

// 현재 채팅·프로젝트·계정 표시값을 삭제 후에도 남길 스냅샷 형태로 읽는다.
export function tokenUsageSnapshotForChat(database: AppDatabase, chatId: number, chatDeleted = false): TokenUsageSnapshot | null {
  const row = database.prepare(`
    SELECT c.id AS chatId, c.title AS chatTitle, c.model,
      p.id AS projectId, p.name AS projectName, p.path AS projectPath,
      a.id AS accountId, a.label AS accountLabel
    FROM chats c
    JOIN projects p ON p.id = c.project_id
    LEFT JOIN agent_accounts a ON a.id = c.account_id
    WHERE c.id = ?
  `).get(chatId) as Omit<TokenUsageSnapshot, "chatDeleted"> | undefined;
  return row ? { ...row, chatDeleted } : null;
}

interface AggregateOptions {
  groupBy: TokenUsageGroup;
  days: number | null;
  timezoneOffsetMinutes: number;
  now?: Date;
}

interface GroupDimension {
  key: string;
  label: string;
  detail: string;
  parameter?: string;
}

const SUM_COLUMNS = `
  SUM(input_tokens) AS inputTokens,
  SUM(cached_input_tokens) AS cachedInputTokens,
  SUM(cache_creation_input_tokens) AS cacheCreationInputTokens,
  SUM(cache_read_input_tokens) AS cacheReadInputTokens,
  SUM(output_tokens) AS outputTokens,
  SUM(reasoning_output_tokens) AS reasoningOutputTokens,
  SUM(total_tokens) AS totalTokens
`;

// 외부 기록의 토큰 값이 DB 정수 범위를 벗어나거나 음수가 되지 않게 정규화한다.
function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

// 허용된 그룹 키만 고정 SQL 식으로 변환해 동적 SQL 주입 가능성을 없앤다.
function groupDimension(groupBy: TokenUsageGroup, timezoneOffsetMinutes: number): GroupDimension {
  if (groupBy === "day") {
    const offset = Math.max(-840, Math.min(840, Math.trunc(timezoneOffsetMinutes)));
    return {
      key: "date(occurred_at, ?)",
      label: "date(occurred_at, ?)",
      detail: "''",
      parameter: `${offset >= 0 ? "+" : ""}${offset} minutes`,
    };
  }
  if (groupBy === "project") return {
    key: "COALESCE('path:' || project_path, 'id:' || project_id, 'unknown')",
    label: "COALESCE(project_name, project_path, '알 수 없는 프로젝트')",
    detail: "COALESCE(project_path, '')",
  };
  if (groupBy === "chat") return {
    key: "COALESCE('id:' || chat_id, provider || ':' || session_id)",
    label: "COALESCE(chat_title, '채팅 ' || session_id)",
    detail: "(CASE provider WHEN 'codex' THEN 'Codex' WHEN 'grok' THEN 'Grok' ELSE 'Claude' END) || CASE WHEN project_name IS NULL THEN '' ELSE ' · ' || project_name END",
  };
  if (groupBy === "provider") return {
    key: "provider",
    label: "CASE provider WHEN 'codex' THEN 'Codex' WHEN 'grok' THEN 'Grok' ELSE 'Claude' END",
    detail: "''",
  };
  if (groupBy === "account") return {
    key: "COALESCE('id:' || account_id, provider || ':' || account_label, provider || ':unknown')",
    label: "COALESCE(account_label, CASE provider WHEN 'codex' THEN 'Codex 계정 미상' WHEN 'grok' THEN 'Grok 계정 미상' ELSE 'Claude 계정 미상' END)",
    detail: "CASE provider WHEN 'codex' THEN 'Codex' WHEN 'grok' THEN 'Grok' ELSE 'Claude' END",
  };
  return {
    key: "COALESCE(model, 'unknown')",
    label: "COALESCE(model, '모델 미상')",
    detail: "''",
  };
}

// 메시지별 토큰 이벤트를 영구 보존하고 기간·차원별 통계를 만든다.
export class TokenUsageLedger {
  constructor(private readonly database: AppDatabase) {}

  // 파싱된 세션의 과금 단위 토큰 이벤트(없으면 메시지 usage)를 안정 키로 멱등 저장한다.
  recordSession(session: HistorySession, snapshot: TokenUsageSnapshot): number {
    const statement = this.database.prepare(`
      INSERT INTO token_usage_events(
        provider, session_id, message_id, occurred_at,
        account_id, account_label, project_id, project_name, project_path, chat_id, chat_title, model,
        input_tokens, cached_input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
        output_tokens, reasoning_output_tokens, total_tokens, chat_deleted, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(provider, session_id, message_id) DO UPDATE SET
        occurred_at = excluded.occurred_at,
        account_id = excluded.account_id,
        account_label = excluded.account_label,
        project_id = excluded.project_id,
        project_name = excluded.project_name,
        project_path = excluded.project_path,
        chat_id = excluded.chat_id,
        chat_title = excluded.chat_title,
        model = excluded.model,
        input_tokens = excluded.input_tokens,
        cached_input_tokens = excluded.cached_input_tokens,
        cache_creation_input_tokens = excluded.cache_creation_input_tokens,
        cache_read_input_tokens = excluded.cache_read_input_tokens,
        output_tokens = excluded.output_tokens,
        reasoning_output_tokens = excluded.reasoning_output_tokens,
        total_tokens = excluded.total_tokens,
        chat_deleted = excluded.chat_deleted,
        updated_at = CURRENT_TIMESTAMP
    `);
    // 공급자가 과금 단위 이벤트를 내면 그것을 기록한다. 화면 메시지에 붙은 usage는 단위가 달라
    // 중복(Claude 분할 레코드)·누락(Codex 도구 단계 호출)·시각 오류(Grok)가 생겼다(#134).
    const events = session.tokenEvents ?? session.messages.flatMap((message) => message.tokenUsage
      ? [{ ...message.tokenUsage, key: message.id, occurredAt: message.createdAt || session.updatedAt, model: null }]
      : []);
    let recorded = 0;
    this.database.transaction(() => {
      if (session.tokenEvents?.length) {
        // 새 키는 "{provider}:"로 시작한다. 예전 메시지 키 행만 지워, 이벤트 일부만 담은 오래된 백업을
        // 기록해도 이미 저장된 새 키 행은 지워지지 않는다.
        this.database.prepare(`
          DELETE FROM token_usage_events WHERE provider = ? AND session_id = ? AND substr(message_id, 1, ?) <> ?
        `).run(session.provider, session.sessionId, session.provider.length + 1, `${session.provider}:`);
      }
      for (const event of events) {
        if (tokenCount(event.totalTokens) < 1) continue;
        statement.run(
          session.provider, session.sessionId, event.key, event.occurredAt,
          snapshot.accountId, snapshot.accountLabel, snapshot.projectId, snapshot.projectName, snapshot.projectPath,
          snapshot.chatId, snapshot.chatTitle, event.model ?? session.model ?? snapshot.model ?? null,
          tokenCount(event.inputTokens), tokenCount(event.cachedInputTokens), tokenCount(event.cacheCreationInputTokens),
          tokenCount(event.cacheReadInputTokens), tokenCount(event.outputTokens), tokenCount(event.reasoningOutputTokens),
          tokenCount(event.totalTokens), snapshot.chatDeleted ? 1 : 0,
        );
        recorded += 1;
      }
    })();
    return recorded;
  }

  // 현재 채팅을 지우기 전에 이미 저장된 이벤트도 삭제된 채팅으로 표시한다.
  markChatDeleted(chatId: number): void {
    this.database.prepare("UPDATE token_usage_events SET chat_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE chat_id = ?").run(chatId);
  }

  // 선택 기간의 전체 합계와 그룹별 합계를 한 번에 반환한다.
  aggregate(options: AggregateOptions): Record<string, unknown> {
    const dimension = groupDimension(options.groupBy, options.timezoneOffsetMinutes);
    const since = options.days === null
      ? null
      : new Date((options.now ?? new Date()).getTime() - options.days * 86_400_000).toISOString();
    const where = since ? "WHERE occurred_at >= ?" : "";
    const summary = this.database.prepare(`
      SELECT COUNT(*) AS messageCount,
        COUNT(DISTINCT provider || ':' || session_id) AS chatCount,
        COUNT(DISTINCT COALESCE('path:' || project_path, 'id:' || project_id)) AS projectCount,
        ${SUM_COLUMNS}
      FROM token_usage_events ${where}
    `).get(...(since ? [since] : [])) as Record<string, unknown>;
    const parameters: string[] = [];
    if (dimension.parameter) parameters.push(dimension.parameter, dimension.parameter);
    if (since) parameters.push(since);
    const rows = this.database.prepare(`
      SELECT ${dimension.key} AS key, ${dimension.label} AS label, ${dimension.detail} AS detail,
        COUNT(*) AS messageCount,
        COUNT(DISTINCT provider || ':' || session_id) AS chatCount,
        MAX(chat_deleted) AS deleted,
        ${SUM_COLUMNS}
      FROM token_usage_events ${where}
      GROUP BY key
      ORDER BY ${options.groupBy === "day" ? "key DESC" : "totalTokens DESC, label ASC"}
      LIMIT 300
    `).all(...parameters) as Array<Record<string, unknown>>;
    return {
      groupBy: options.groupBy,
      days: options.days,
      summary: summary ?? {},
      rows: rows.map((row) => ({ ...row, deleted: Number(row.deleted) === 1 })),
    };
  }
}
