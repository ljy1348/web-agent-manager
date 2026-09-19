import { parseClockTime, parseResetTime, zonedTimeToUtc } from "../services/rate-limit-resume";

// 날짜 없이 시:분만 있는 리셋 문구를 "오늘 그 시:분"(과거든 미래든 그대로)의 실제 시각으로 환산한다.
// parseResetTime(rate-limit-resume.ts)과 달리 이미 지난 시각을 내일로 밀지 않는다 — 대기 재개용이
// 아니라 "그 리셋이 실제로 언제였는지"를 그대로 알아야 하는 용도(오래된 스냅샷 판정, 리셋 이후 경과
// 시간 계산 등)에 쓴다. 날짜가 붙은 문구("Jul 11, ...")나 형식을 못 읽으면 null.
export function todayResetTime(resetAt: string, now: Date): Date | null {
  if (/[A-Za-z]{3}\s+\d{1,2}|\d{1,2}\s+[A-Za-z]{3}/.test(resetAt)) return null;
  // 정각 표기("6pm")까지 읽어야 아래 isExpiredResetTime과 usage-monitor의 옛 스냅샷 판정이
  // 동작한다 — 예전에는 분이 없으면 null이라 그 검사들이 통째로 통과됐다(#53).
  const clock = parseClockTime(resetAt);
  if (!clock) return null;
  const { hour, minute } = clock;
  const timeZone = resetAt.match(/\(([A-Za-z]+\/[A-Za-z_]+)\)/)?.[1];
  if (timeZone) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? 0);
    return zonedTimeToUtc(get("year"), get("month"), get("day"), hour, minute, timeZone);
  }
  const today = new Date(now);
  today.setHours(hour, minute, 0, 0);
  return today;
}

// 날짜 없이 시:분만 있는 리셋 문구가 이미 지난 시각인지 확인해 오래된 사용량 스냅샷을 판정한다.
export function isExpiredResetTime(resetAt: string, now: Date, nextOccurrenceWindowMs = 0): boolean {
  const today = todayResetTime(resetAt, now);
  if (!today) return false;
  if (today.getTime() >= now.getTime() - 60_000) return false;
  // 날짜 없는 롤링 창의 시각이 오늘 이미 지났더라도, 다음 발생 시각이 창 길이 안이면 내일의
  // 리셋을 뜻한다. 예: 서울 22:50의 `Resets 1am`은 오늘 새벽의 낡은 값이 아니라 2시간 10분 뒤다.
  // 반대로 오전 10시의 `3:40am`은 다음 발생까지 17시간 이상이라 5시간 창의 미래 리셋일 수 없고,
  // 기존처럼 오래된 스냅샷으로 판정한다.
  if (nextOccurrenceWindowMs > 0) {
    const next = parseResetTime(resetAt, now);
    if (next && next.getTime() - now.getTime() <= nextOccurrenceWindowMs) return false;
  }
  return true;
}
