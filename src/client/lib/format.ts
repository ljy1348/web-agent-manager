import type { Json } from "../types";

const KST_OFFSET_MS = 9 * 60 * 60_000;
const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
};

function kstDate(year: number, month: number, day: number, hour: number, minute: number): Date {
  return new Date(Date.UTC(year, month, day, hour, minute) - KST_OFFSET_MS);
}

function nearestYearDate(month: number, day: number, hour: number, minute: number, now: Date): Date {
  const currentKstYear = new Date(now.getTime() + KST_OFFSET_MS).getUTCFullYear();
  return [-1, 0, 1]
    .map((offset) => kstDate(currentKstYear + offset, month, day, hour, minute))
    .sort((a, b) => Math.abs(a.getTime() - now.getTime()) - Math.abs(b.getTime() - now.getTime()))[0];
}

function resetMoment(value: string, now: Date): Date | null {
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text)) {
    const explicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
    const normalized = explicitZone ? text.replace(" ", "T") : `${text.replace(" ", "T")}Z`;
    const date = new Date(normalized);
    if (!Number.isNaN(date.getTime())) return date;
  }

  const codexDated = text.match(/^(\d{1,2}):(\d{2})\s+on\s+(\d{1,2})\s+([A-Za-z]+)$/i);
  if (codexDated) {
    const month = MONTHS[codexDated[4].toLowerCase()];
    if (month !== undefined) return nearestYearDate(month, Number(codexDated[3]), Number(codexDated[1]), Number(codexDated[2]), now);
  }

  const providerDated = text.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(Asia\/Seoul\))?$/i);
  if (providerDated) {
    const month = MONTHS[providerDated[1].toLowerCase()];
    if (month !== undefined) {
      let hour = Number(providerDated[3]);
      const meridiem = providerDated[5]?.toLowerCase();
      if (meridiem === "pm" && hour < 12) hour += 12;
      if (meridiem === "am" && hour === 12) hour = 0;
      return nearestYearDate(month, Number(providerDated[2]), hour, Number(providerDated[4] ?? 0), now);
    }
  }

  const clock = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(Asia\/Seoul\))?$/i);
  if (!clock) return null;
  let hour = Number(clock[1]);
  const minute = Number(clock[2] ?? 0);
  const meridiem = clock[3]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  const kstNow = new Date(now.getTime() + KST_OFFSET_MS);
  let candidate = kstDate(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate(), hour, minute);
  if (candidate.getTime() < now.getTime() - 60_000) candidate = new Date(candidate.getTime() + 24 * 60 * 60_000);
  return candidate;
}

// 공급자별 ISO·TUI 초기화 문구를 같은 한국 시간 날짜·시·분 표기로 보여 준다.
export function formatUsageResetAt(value: unknown, now: Date = new Date()): string {
  if (typeof value !== "string" || !value.trim()) return "-";
  const date = resetMoment(value, now);
  if (!date) return value;
  const kst = new Date(date.getTime() + KST_OFFSET_MS);
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `${pad(kst.getUTCMonth() + 1)}월 ${pad(kst.getUTCDate())}일 ${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}`;
}

// 공급자 사용 구간 JSON을 안전하게 배열로 변환한다.
export function usageWindows(record: Json): Json[] {
  try {
    return JSON.parse(record.details_json || "{}").windows || [];
  } catch {
    return [];
  }
}

// Codex 사용량 상세에서 초기화권 요약을 안전하게 꺼낸다.
export function usageResetCredits(record: Json): Json | null {
  try {
    return JSON.parse(record.details_json || "{}").rateLimitResetCredits || null;
  } catch {
    return null;
  }
}

// 바이트 값을 사람이 읽을 수 있는 단위로 표시한다.
export function bytes(value: number): string {
  if (!Number.isFinite(value)) return "-";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index ? 1 : 0)} ${units[index]}`;
}

// 사용량 상태 코드를 화면에 그대로 노출하지 않고 사람이 읽을 문구로 바꾼다.
export function usageErrorLabel(code: string | null | undefined): string {
  if (!code) return "조회 중";
  const labels: Record<string, string> = {
    auth_required: "로그인이 필요합니다",
    timeout: "조회 시간이 초과되었습니다",
    parse_failed: "사용량 화면을 해석하지 못했습니다",
    cli_exited: "조회용 CLI가 종료되었습니다",
    rate_limited: "상세 조회가 제한되어 마지막 직접 확인값을 유지합니다",
    usage_seeded_headers_throttled: "상세 조회가 제한되어 마지막 직접 확인값을 유지합니다",
    usage_seeded_persisted_throttled: "상세 조회가 제한되어 마지막 직접 확인값을 유지합니다",
    usage_seeded_headers_refresh_failed: "상세 갱신에 실패해 마지막 직접 확인값을 유지합니다",
    usage_seeded_persisted_refresh_failed: "상세 갱신에 실패해 마지막 직접 확인값을 유지합니다",
    usage_endpoint_throttled: "사용량 상세 조회 응답을 기다리는 중입니다",
    usage_refreshing: "사용량 상세 정보를 갱신하는 중입니다",
  };
  return labels[code] ?? code;
}

// 최근 직접 확인값을 안전하게 보존한 Claude fallback은 사용자 quota 초과나 계정 장애가 아니다.
export function isUsageFallbackNotice(code: string | null | undefined): boolean {
  return !!code && [
    "rate_limited",
    "usage_seeded_headers_throttled",
    "usage_seeded_persisted_throttled",
    "usage_seeded_headers_refresh_failed",
    "usage_seeded_persisted_refresh_failed",
    "usage_endpoint_throttled",
    "usage_refreshing",
  ].includes(code);
}
