import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../core/config";
import type { AppDatabase } from "../core/database";
import { assertAllowedPath } from "../core/security";
import { writeAudit } from "../core/audit";
import type { Provider } from "../../shared/types";
import type { ProviderAdapter, HistorySession } from "../providers/provider";
import type { HistoryCache } from "./history-cache";

interface ChatBackupMetadata {
  version: 1;
  id: string;
  provider: Provider;
  providerSessionId: string;
  title: string;
  projectPath: string;
  historyRelativePath: string;
  model: string | null;
  originalChatId: number;
  backedUpAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionBackupSummary extends ChatBackupMetadata {
  chatExists: boolean;
}

interface ChatWithProject {
  id: number;
  project_id: number;
  provider: Provider;
  provider_session_id: string | null;
  tmux_name: string;
  status: string;
  title: string;
  history_file: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
  project_path: string;
}

// 파일명이 경로 구분자로 해석되지 않도록 백업 ID 형식을 제한한다.
function assertBackupId(id: string): string {
  if (!/^[a-z0-9_-]+$/i.test(id)) throw new Error("백업 ID 형식이 올바르지 않습니다.");
  return id;
}

// 대상 경로가 루트 내부에 있는지 확인한다.
function assertInside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("세션 기록 경로가 허용 범위를 벗어났습니다.");
}

// 파일이 이미 있으면 기존 기록을 덮어쓰지 않는 복원 경로를 만든다.
function availableRestorePath(target: string, backupId: string): string {
  if (!fs.existsSync(target)) return target;
  const parsed = path.parse(target);
  for (let index = 1; index < 100; index += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}.restored-${backupId}-${index}${parsed.ext || ".jsonl"}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error("복원 파일명을 만들 수 없습니다.");
}

// 세션 JSONL과 채팅 메타데이터를 앱 데이터 디렉터리에 백업·복원한다.
export class SessionBackupService {
  private readonly adapters: Map<Provider, ProviderAdapter>;
  private readonly root: string;

  constructor(
    private readonly config: AppConfig,
    private readonly database: AppDatabase,
    adapters: ProviderAdapter[],
    private readonly historyCache: HistoryCache,
  ) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
    this.root = path.join(config.dataDir, "session-backups");
  }

  // 선택 채팅의 공급자 JSONL과 메타데이터를 백업한다.
  backupChat(chatId: number, userId: number): SessionBackupSummary {
    const chat = this.getChat(chatId);
    if (!chat.provider_session_id || !chat.history_file) throw new Error("백업할 세션 기록이 아직 없습니다.");
    const adapter = this.getAdapter(chat.provider);
    const root = fs.realpathSync(adapter.historyRoot);
    const historyFile = fs.realpathSync(chat.history_file);
    assertInside(root, historyFile);
    const stat = fs.statSync(historyFile);
    const hash = crypto.createHash("sha256").update(`${chat.provider}:${chat.provider_session_id}:${Date.now()}:${stat.size}`).digest("hex").slice(0, 16);
    const timestamp = new Date().toISOString();
    const id = `${chat.provider}-${timestamp.replace(/[-:.TZ]/g, "").slice(0, 14)}-${hash}`;
    const directory = this.backupDir(id);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const metadata: ChatBackupMetadata = {
      version: 1,
      id,
      provider: chat.provider,
      providerSessionId: chat.provider_session_id,
      title: chat.title,
      projectPath: chat.project_path,
      historyRelativePath: path.relative(root, historyFile),
      model: chat.model,
      originalChatId: chat.id,
      backedUpAt: timestamp,
      createdAt: chat.created_at,
      updatedAt: chat.updated_at,
    };
    fs.copyFileSync(historyFile, path.join(directory, "session.jsonl"));
    fs.writeFileSync(path.join(directory, "metadata.json"), JSON.stringify(metadata, null, 2), { mode: 0o600 });
    writeAudit(this.database, userId, "chat.backup", "chat", chatId, { backupId: id, provider: chat.provider });
    return { ...metadata, chatExists: true };
  }

  // 프로젝트 경로에 속한 세션 백업 목록을 최신순으로 반환한다.
  listProjectBackups(projectId: number): SessionBackupSummary[] {
    const project = this.database.prepare("SELECT path FROM projects WHERE id = ?").get(projectId) as { path: string } | undefined;
    if (!project) throw new Error("프로젝트를 찾을 수 없습니다.");
    if (!fs.existsSync(this.root)) return [];
    return fs.readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.readMetadata(entry.name))
      .filter((metadata): metadata is ChatBackupMetadata => !!metadata && metadata.projectPath === project.path)
      .map((metadata) => ({ ...metadata, chatExists: this.chatExists(metadata.provider, metadata.providerSessionId) }))
      .sort((a, b) => b.backedUpAt.localeCompare(a.backedUpAt));
  }

  // 백업 JSONL을 공급자 기록 저장소에 되돌리고 채팅 메타데이터를 복원한다.
  restoreBackup(backupId: string, userId: number): { chat: Record<string, unknown>; backup: SessionBackupSummary } {
    const id = assertBackupId(backupId);
    const metadata = this.requireMetadata(id);
    const adapter = this.getAdapter(metadata.provider);
    const backupFile = path.join(this.backupDir(id), "session.jsonl");
    if (!fs.existsSync(backupFile)) throw new Error("백업 세션 파일을 찾을 수 없습니다.");
    const projectPath = assertAllowedPath(metadata.projectPath, this.config.allowedRoots);
    if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) throw new Error("복원할 프로젝트 경로가 없습니다.");
    fs.mkdirSync(adapter.historyRoot, { recursive: true, mode: 0o700 });
    const root = fs.realpathSync(adapter.historyRoot);
    const relative = metadata.historyRelativePath || `${metadata.provider}/restored-${id}.jsonl`;
    const wanted = path.resolve(root, relative);
    assertInside(root, wanted);
    const target = availableRestorePath(wanted, id);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(backupFile, target);
    this.historyCache.invalidate(target);
    const session = adapter.parseHistoryFile(target);
    if (!session || session.provider !== metadata.provider || session.sessionId !== metadata.providerSessionId) {
      fs.rmSync(target, { force: true });
      throw new Error("백업 세션 기록을 해석할 수 없습니다.");
    }
    const chat = this.upsertRestoredChat(session, metadata, target, projectPath);
    writeAudit(this.database, userId, "chat.restore", "chat", Number(chat.id), { backupId: id, provider: metadata.provider });
    return { chat: chat as Record<string, unknown>, backup: { ...metadata, chatExists: true } };
  }

  // 백업 디렉터리(JSONL 사본·메타데이터)를 삭제한다. 원본 채팅·공급자 기록은 건드리지 않는다.
  deleteBackup(backupId: string, userId: number): void {
    const id = assertBackupId(backupId);
    const metadata = this.requireMetadata(id);
    fs.rmSync(this.backupDir(id), { recursive: true, force: true });
    writeAudit(this.database, userId, "chat.backup_delete", "chat", metadata.originalChatId, { backupId: id, provider: metadata.provider });
  }

  // 채팅 메타데이터와 원본 공급자 JSONL을 삭제한다.
  deleteChat(chatId: number, userId: number): void {
    const chat = this.getChat(chatId);
    const adapter = this.getAdapter(chat.provider);
    if (chat.history_file && fs.existsSync(chat.history_file)) {
      const root = fs.realpathSync(adapter.historyRoot);
      const historyFile = fs.realpathSync(chat.history_file);
      assertInside(root, historyFile);
      fs.rmSync(historyFile, { force: true });
      this.historyCache.invalidate(historyFile);
    }
    this.database.prepare("DELETE FROM chats WHERE id = ?").run(chatId);
    writeAudit(this.database, userId, "chat.delete", "chat", chatId, { provider: chat.provider, providerSessionId: chat.provider_session_id });
  }

  private getChat(chatId: number): ChatWithProject {
    const chat = this.database.prepare(`
      SELECT c.*, p.path AS project_path FROM chats c JOIN projects p ON p.id = c.project_id WHERE c.id = ?
    `).get(chatId) as ChatWithProject | undefined;
    if (!chat) throw new Error("채팅을 찾을 수 없습니다.");
    return chat;
  }

  private getAdapter(provider: Provider): ProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new Error("지원하지 않는 공급자입니다.");
    return adapter;
  }

  private backupDir(id: string): string {
    return path.join(this.root, assertBackupId(id));
  }

  private readMetadata(id: string): ChatBackupMetadata | null {
    try {
      const metadata = JSON.parse(fs.readFileSync(path.join(this.backupDir(id), "metadata.json"), "utf8")) as ChatBackupMetadata;
      return metadata.version === 1 && metadata.id === id ? metadata : null;
    } catch {
      return null;
    }
  }

  private requireMetadata(id: string): ChatBackupMetadata {
    const metadata = this.readMetadata(id);
    if (!metadata) throw new Error("세션 백업을 찾을 수 없습니다.");
    return metadata;
  }

  private chatExists(provider: Provider, sessionId: string): boolean {
    const row = this.database.prepare("SELECT id FROM chats WHERE provider = ? AND provider_session_id = ?").get(provider, sessionId);
    return !!row;
  }

  private upsertRestoredChat(session: HistorySession, metadata: ChatBackupMetadata, historyFile: string, projectPath: string): Record<string, unknown> {
    this.database.prepare(`
      INSERT INTO projects(name, path, source, updated_at)
      VALUES (?, ?, 'discovered', CURRENT_TIMESTAMP)
      ON CONFLICT(path) DO UPDATE SET active = 1, updated_at = CURRENT_TIMESTAMP
    `).run(path.basename(projectPath), projectPath);
    const project = this.database.prepare("SELECT id FROM projects WHERE path = ?").get(projectPath) as { id: number };
    const existing = this.database.prepare("SELECT id FROM chats WHERE provider = ? AND provider_session_id = ?").get(session.provider, session.sessionId) as { id: number } | undefined;
    const title = session.title || metadata.title;
    const model = session.model ?? metadata.model;
    const updatedAt = session.updatedAt || metadata.updatedAt;
    if (existing) {
      this.database.prepare(`
        UPDATE chats SET project_id = ?, title = ?, history_file = ?, model = ?, status = 'stopped', last_error = NULL, updated_at = ?
        WHERE id = ?
      `).run(project.id, title, historyFile, model, updatedAt, existing.id);
      return this.database.prepare("SELECT * FROM chats WHERE id = ?").get(existing.id) as Record<string, unknown>;
    }
    const tmuxName = this.nextTmuxName(`web_agent_manager_restored_${crypto.createHash("sha256").update(`${session.provider}:${session.sessionId}`).digest("hex").slice(0, 16)}`);
    const result = this.database.prepare(`
      INSERT INTO chats(project_id, provider, provider_session_id, tmux_name, status, title, history_file, model, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'stopped', ?, ?, ?, ?, ?)
    `).run(project.id, session.provider, session.sessionId, tmuxName, title, historyFile, model, session.createdAt || metadata.createdAt, updatedAt);
    return this.database.prepare("SELECT * FROM chats WHERE id = ?").get(Number(result.lastInsertRowid)) as Record<string, unknown>;
  }

  private nextTmuxName(base: string): string {
    let name = base;
    let index = 1;
    while (this.database.prepare("SELECT id FROM chats WHERE tmux_name = ?").get(name)) {
      name = `${base}_${index}`;
      index += 1;
    }
    return name;
  }
}
