import type { Json } from "../types";

// 예약의 실행 시점을 사람이 읽는 문구로 만든다. 1회 예약(run_date)은 날짜와 "1회"를, 매일 예약은 "매일"을 붙인다(#99).
export function scheduleTimingLabel(schedule: Json): string {
  return schedule.run_date ? `${schedule.run_date} ${schedule.daily_time} 1회` : `매일 ${schedule.daily_time}`;
}
