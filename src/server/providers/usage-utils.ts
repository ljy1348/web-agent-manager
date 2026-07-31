import { zonedTimeToUtc } from "../services/rate-limit-resume";

// 날짜 없이 시:분만 있는 리셋 문구를 "오늘 그 시:분"(과거든 미래든 그대로)의 실제 시각으로 환산한다.
// parseResetTime(rate-limit-resume.ts)과 달리 이미 지난 시각을 내일로 밀지 않는다 — 대기 재개용이
// 아니라 "그 리셋이 실제로 언제였는지"를 그대로 알아야 하는 용도(오래된 스냅샷 판정, 리셋 이후 경과
// 시간 계산 등)에 쓴다. 날짜가 붙은 문구("Jul 11, ...")나 형식을 못 읽으면 null.
export function todayResetTime(resetAt: string, now: Date): Date | null {
  if (/[A-Za-z]{3}\s+\d{1,2}|\d{1,2}\s+[A-Za-z]{3}/.test(resetAt)) return null;
  const match = resetAt.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
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
export function isExpiredResetTime(resetAt: string, now: Date): boolean {
  const today = todayResetTime(resetAt, now);
  if (!today) return false;
  return today.getTime() < now.getTime() - 60_000;
}
