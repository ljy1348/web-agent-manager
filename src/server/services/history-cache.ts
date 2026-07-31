import fs from "node:fs";
import type { ProviderAdapter, HistorySession } from "../providers/provider";

interface CacheEntry {
  mtimeMs: number;
  size: number;
  session: HistorySession | null;
}

// 파일 mtime이 그대로면 다시 파싱하지 않고 마지막 결과를 재사용한다.
// 메시지를 DB에 미러링하지 않고 매 요청 JSONL을 신뢰 가능한 단일 소스로 쓰기 위한 캐시다.
export class HistoryCache {
  private readonly entries = new Map<string, CacheEntry>();

  get(adapter: ProviderAdapter, file: string): HistorySession | null {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      this.entries.delete(file);
      return null;
    }
    const cached = this.entries.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.session;
    if (cached?.session && adapter.appendHistoryLines && stat.size > cached.size) {
      const descriptor = fs.openSync(file, "r");
      try {
        const appended = Buffer.allocUnsafe(stat.size - cached.size);
        fs.readSync(descriptor, appended, 0, appended.length, cached.size);
        const lines = appended.toString("utf8").split("\n").filter(Boolean);
        const session = adapter.appendHistoryLines(file, cached.session, lines);
        if (session) {
          this.entries.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, session });
          return session;
        }
      } finally {
        fs.closeSync(descriptor);
      }
    }
    const session = adapter.parseHistoryFile(file);
    this.entries.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, session });
    return session;
  }

  // 기록 파일이 삭제·복원되면 다음 조회에서 반드시 다시 파싱하게 한다.
  invalidate(file: string): void {
    this.entries.delete(file);
  }
}
