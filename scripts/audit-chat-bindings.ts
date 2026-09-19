import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { ClaudeAdapter } from "../src/server/providers/claude";
import { CodexAdapter } from "../src/server/providers/codex";
import { GrokAdapter } from "../src/server/providers/grok";
import type { HistorySession, ProviderAdapter } from "../src/server/providers/provider";

interface ChatRow {
  id: number;
  provider: "codex" | "claude" | "grok";
  providerSessionId: string | null;
  tmuxName: string;
  status: string;
  origin: string;
  createdAt: string;
  historyFile: string | null;
  accountId: number | null;
  accountConfigDir: string | null;
  accountProvider: string | null;
  projectPath: string;
  worktreePath: string | null;
}

interface AuditIssue {
  chatId: number;
  provider: string;
  kind: string;
  detail?: string;
}

interface TmuxPane {
  name: string;
  pid: number;
  command: string;
}

function realpathOrResolved(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function readTmuxPanes(): Map<string, TmuxPane> {
  try {
    const output = execFileSync("tmux", ["list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}\t#{pane_start_command}"], { encoding: "utf8" });
    return new Map(output.trim().split("\n").filter(Boolean).map((line) => {
      const [name, pid, ...command] = line.split("\t");
      return [name, { name, pid: Number(pid), command: command.join("\t") }];
    }));
  } catch {
    return new Map();
  }
}

function processStartedAt(pid: number): number | null {
  try {
    const output = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
    const value = Date.parse(output);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function explicitSessionId(command: string): string | null {
  return command.match(/(?:^|\s)(?:resume|--resume|--session-id)(?:=|\s)+([0-9a-z-]{8,})(?:\s|$)/i)?.[1] ?? null;
}

const dataDir = path.resolve(process.argv[2] ?? path.join(process.cwd(), "data"));
const database = new Database(path.join(dataDir, "web-agent-manager.sqlite"), { readonly: true, fileMustExist: true });
const adapters = new Map<string, ProviderAdapter>([
  ["codex", new CodexAdapter()],
  ["claude", new ClaudeAdapter("", {})],
  ["grok", new GrokAdapter()],
]);
const chats = database.prepare(`
  SELECT c.id, c.provider, c.provider_session_id AS providerSessionId, c.tmux_name AS tmuxName,
    c.status, c.origin, c.created_at AS createdAt, c.history_file AS historyFile, c.account_id AS accountId,
    a.config_dir AS accountConfigDir, a.provider AS accountProvider,
    p.path AS projectPath, c.worktree_path AS worktreePath
  FROM chats c JOIN projects p ON p.id = c.project_id
  LEFT JOIN agent_accounts a ON a.id = c.account_id
  ORDER BY c.id
`).all() as ChatRow[];
const panes = readTmuxPanes();
const serverPidFile = path.join(dataDir, "supervisor", "server.pid");
let serverHome = process.env.HOME ?? "";
try {
  const serverPid = fs.readFileSync(serverPidFile, "utf8").trim();
  const environment = fs.readFileSync(`/proc/${serverPid}/environ`, "utf8").split("\0");
  serverHome = environment.find((entry) => entry.startsWith("HOME="))?.slice(5) || serverHome;
} catch {
  // 개발 DB처럼 운영 PID가 없으면 현재 프로세스 HOME을 사용한다.
}
const installHome = process.cwd().match(/^(\/home\/[^/]+)/)?.[1] ?? serverHome;
const issues: AuditIssue[] = [];
const empty: AuditIssue[] = [];
const parsedByChat = new Map<number, HistorySession>();
const historyOwners = new Map<string, number[]>();
const restoredChatIds = new Set((database.prepare("SELECT target_id AS id FROM audit_logs WHERE action = 'chat.restore' AND target_type = 'chat'").all() as Array<{ id: string }>).map((row) => Number(row.id)));
const startedAtByChat = new Map<number, number[]>();
for (const row of database.prepare("SELECT target_id AS id, created_at AS createdAt FROM audit_logs WHERE action = 'chat.start' AND target_type = 'chat'").all() as Array<{ id: string; createdAt: string }>) {
  const chatId = Number(row.id);
  const createdAt = Date.parse(row.createdAt.includes("T") ? row.createdAt : `${row.createdAt.replace(" ", "T")}Z`);
  if (Number.isFinite(chatId) && Number.isFinite(createdAt)) startedAtByChat.set(chatId, [...(startedAtByChat.get(chatId) ?? []), createdAt]);
}

for (const chat of chats) {
  const adapter = adapters.get(chat.provider)!;
  const pane = panes.get(chat.tmuxName);
  if (!chat.providerSessionId && !chat.historyFile) {
    empty.push({ chatId: chat.id, provider: chat.provider, kind: `empty_${chat.status}` });
  } else if (chat.providerSessionId && !chat.historyFile) {
    const item = { chatId: chat.id, provider: chat.provider, kind: pane ? "empty_live_reserved" : "reserved_id_without_history", detail: chat.providerSessionId };
    if (pane) empty.push(item);
    else issues.push(item);
  } else if (!chat.providerSessionId && chat.historyFile) {
    issues.push({ chatId: chat.id, provider: chat.provider, kind: "history_without_session_id", detail: chat.historyFile });
  }

  if (chat.historyFile) {
    const owners = historyOwners.get(chat.historyFile) ?? [];
    owners.push(chat.id);
    historyOwners.set(chat.historyFile, owners);
    if (!fs.existsSync(chat.historyFile)) {
      issues.push({ chatId: chat.id, provider: chat.provider, kind: "missing_history_file", detail: chat.historyFile });
    } else {
      if (!chat.accountId || chat.accountProvider !== chat.provider) {
        issues.push({ chatId: chat.id, provider: chat.provider, kind: "invalid_account_binding", detail: String(chat.accountId) });
      } else {
        const configDir = chat.accountConfigDir
          ?? (chat.provider === "codex" ? path.join(installHome, ".codex") : path.join(serverHome, `.${chat.provider}`));
        const accountRoot = path.resolve(adapter.historyRootFor(configDir));
        const historyPath = path.resolve(chat.historyFile);
        if (historyPath !== accountRoot && !historyPath.startsWith(`${accountRoot}${path.sep}`)) {
          issues.push({ chatId: chat.id, provider: chat.provider, kind: "account_history_root_mismatch", detail: `${accountRoot} != ${historyPath}` });
        }
      }
      try {
        const session = adapter.parseHistoryFile(chat.historyFile);
        if (!session) {
          issues.push({ chatId: chat.id, provider: chat.provider, kind: "unparseable_history", detail: chat.historyFile });
        } else {
          parsedByChat.set(chat.id, session);
          if (session.sessionId !== chat.providerSessionId) {
            issues.push({ chatId: chat.id, provider: chat.provider, kind: "session_id_mismatch", detail: `${chat.providerSessionId ?? "null"} != ${session.sessionId}` });
          }
          if (session.provider !== chat.provider) {
            issues.push({ chatId: chat.id, provider: chat.provider, kind: "provider_mismatch", detail: session.provider });
          }
          const chatCreatedAt = Date.parse(chat.createdAt.includes("T") ? chat.createdAt : `${chat.createdAt.replace(" ", "T")}Z`);
          const sessionCreatedAt = Date.parse(session.createdAt);
          const explicitlyStartedNearSession = (startedAtByChat.get(chat.id) ?? [])
            .some((startedAt) => Math.abs(startedAt - sessionCreatedAt) <= 5 * 60_000);
          if (!restoredChatIds.has(chat.id) && !explicitlyStartedNearSession && Number.isFinite(chatCreatedAt) && Number.isFinite(sessionCreatedAt)
            && Math.abs(chatCreatedAt - sessionCreatedAt) > 5 * 60_000) {
            issues.push({
              chatId: chat.id,
              provider: chat.provider,
              kind: "chat_session_created_mismatch",
              detail: `chat=${new Date(chatCreatedAt).toISOString()} history=${new Date(sessionCreatedAt).toISOString()}`,
            });
          }
          const expectedWorkspace = realpathOrResolved(chat.worktreePath ?? chat.projectPath);
          const actualWorkspace = realpathOrResolved(session.cwd);
          const workspaceMatches = chat.worktreePath
            ? expectedWorkspace === actualWorkspace
            : expectedWorkspace === actualWorkspace || actualWorkspace.startsWith(`${expectedWorkspace}${path.sep}`);
          if (!workspaceMatches) {
            issues.push({ chatId: chat.id, provider: chat.provider, kind: "workspace_mismatch", detail: `${expectedWorkspace} != ${actualWorkspace}` });
          }
        }
      } catch (error) {
        issues.push({ chatId: chat.id, provider: chat.provider, kind: "history_parse_error", detail: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  if (pane && chat.status === "stopped") {
    issues.push({ chatId: chat.id, provider: chat.provider, kind: "stopped_with_live_tmux", detail: String(pane.pid) });
  } else if (!pane && ["starting", "running", "resuming", "stopping"].includes(chat.status)) {
    issues.push({ chatId: chat.id, provider: chat.provider, kind: "active_without_tmux" });
  }
}

for (const [file, owners] of historyOwners) {
  if (owners.length > 1) {
    for (const chatId of owners) issues.push({ chatId, provider: "unknown", kind: "duplicate_history_owner", detail: `${file}: ${owners.join(",")}` });
  }
}

for (const chat of chats) {
  const pane = panes.get(chat.tmuxName);
  if (!pane) continue;
  const explicit = explicitSessionId(pane.command);
  if (explicit && chat.providerSessionId !== explicit) {
    issues.push({ chatId: chat.id, provider: chat.provider, kind: "live_explicit_session_mismatch", detail: `${chat.providerSessionId ?? "null"} != ${explicit}` });
    continue;
  }
  // 새 Codex는 session ID 인자를 받지 못한다. 프로세스 시작과 session_meta 생성 시각이 같은지로
  // 현재 tmux가 DB의 history_file을 실제로 만든 프로세스인지 확인한다.
  if (chat.provider === "codex" && !explicit) {
    const session = parsedByChat.get(chat.id);
    const processAt = processStartedAt(pane.pid);
    const sessionAt = session ? Date.parse(session.createdAt) : Number.NaN;
    if (processAt !== null && Number.isFinite(sessionAt) && Math.abs(processAt - sessionAt) > 30_000) {
      issues.push({
        chatId: chat.id,
        provider: chat.provider,
        kind: "live_fresh_session_start_mismatch",
        detail: `process=${new Date(processAt).toISOString()} history=${new Date(sessionAt).toISOString()}`,
      });
    }
  }
}

const issueCounts = Object.fromEntries([...new Set(issues.map((issue) => issue.kind))].sort().map((kind) => [kind, issues.filter((issue) => issue.kind === kind).length]));
const emptyCounts = Object.fromEntries([...new Set(empty.map((issue) => issue.kind))].sort().map((kind) => [kind, empty.filter((issue) => issue.kind === kind).length]));
console.log(JSON.stringify({
  scannedChats: chats.length,
  referencedHistoryFiles: historyOwners.size,
  liveManagedTmux: chats.filter((chat) => panes.has(chat.tmuxName)).length,
  issueCounts,
  emptyCounts,
  issues,
  empty,
}, null, 2));
