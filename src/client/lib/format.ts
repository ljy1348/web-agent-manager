import type { Json } from "../types";

// 공급자 사용 구간 JSON을 안전하게 배열로 변환한다.
export function usageWindows(record: Json): Json[] {
  try {
    return JSON.parse(record.details_json || "{}").windows || [];
  } catch {
    return [];
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
