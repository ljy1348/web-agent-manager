import type { Json } from "../types";

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
