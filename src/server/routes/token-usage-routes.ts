import { Router } from "express";
import { type TokenUsageGroup, type TokenUsageLedger } from "../services/token-usage-ledger";

const GROUPS = new Set<TokenUsageGroup>(["day", "project", "chat", "provider", "account", "model"]);
const PERIOD_DAYS = new Map<string, number | null>([["7", 7], ["30", 30], ["90", 90], ["365", 365], ["all", null]]);

// 삭제 채팅을 포함한 토큰 사용량 집계 조회 API를 구성한다.
export function createTokenUsageRouter(tokenUsage: TokenUsageLedger): Router {
  const router = Router();
  router.get("/token-usage", (request, response, next) => {
    try {
      const rawGroup = String(request.query.groupBy ?? "project") as TokenUsageGroup;
      if (!GROUPS.has(rawGroup)) throw new Error("지원하지 않는 사용량 분류입니다.");
      const period = String(request.query.period ?? "30");
      if (!PERIOD_DAYS.has(period)) throw new Error("지원하지 않는 사용량 기간입니다.");
      const rawOffset = Number(request.query.timezoneOffsetMinutes ?? 0);
      const timezoneOffsetMinutes = Number.isFinite(rawOffset) ? Math.trunc(rawOffset) : 0;
      response.json(tokenUsage.aggregate({
        groupBy: rawGroup,
        days: PERIOD_DAYS.get(period) ?? null,
        timezoneOffsetMinutes,
      }));
    } catch (error) {
      next(error);
    }
  });
  return router;
}
