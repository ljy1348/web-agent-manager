import type { UsageRecord } from "../../shared/types";

export interface UsageCollection {
  record: Partial<UsageRecord>;
  // 대시보드의 기존 "터미널 보기" 자리를 진단 가능한 비밀정보 없는 구조화 응답으로 재사용한다.
  snapshot: string;
}

export interface UsageCollectorContext {
  environment: Record<string, string>;
  signal?: AbortSignal;
  now?: Date;
}

export type ProviderUsageCollector = (context: UsageCollectorContext) => Promise<UsageCollection>;

export function normalizedPercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

export function normalizedResetAt(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function directSnapshot(source: string, record: Partial<UsageRecord>): string {
  let details: unknown = null;
  try {
    details = record.details_json ? JSON.parse(record.details_json) : null;
  } catch {
    details = null;
  }
  return JSON.stringify({ source, dataStatus: record.data_status, details }, null, 2);
}
