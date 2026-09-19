import { Router } from "express";
import type { AppDatabase } from "../core/database";
import { requireAdmin, type AuthenticatedRequest } from "../core/auth";
import { writeAudit } from "../core/audit";
import type { UsageMonitor } from "../services/usage-monitor";
import type { SystemMetricsService } from "../services/system-metrics";
import type { FcmNotifier } from "../services/fcm";
import type { UsageRecord } from "../../shared/types";
import type { ProviderAdapter } from "../providers/provider";

type UsageWindowMetadata = Pick<ProviderAdapter, "id" | "usageWindowId" | "usageWindowLabels">;

function mobileUsageWindowLabel(row: UsageRecord, adapter: UsageWindowMetadata | undefined): string | null {
  let windowId = adapter?.usageWindowId;
  try {
    const windows = row.details_json ? (JSON.parse(row.details_json) as { windows?: Array<{ id: string }> }).windows ?? [] : [];
    windowId = windows.find((window) => window.id === adapter?.usageWindowId)?.id
      ?? windows.find((window) => window.id === "weekly" || window.id.startsWith("weekly_"))?.id
      ?? windows[0]?.id
      ?? windowId;
  } catch {
    // 손상된 상세 JSON이어도 대표 창 계약으로 위젯 표시를 유지한다.
  }
  return windowId ? adapter?.usageWindowLabels?.[windowId] ?? null : null;
}

// 홈 화면 위젯이 필요한 사용량·CPU·메모리만 작은 응답으로 구성한다.
export function buildMobileWidgetSnapshot(database: AppDatabase, usageRows: UsageRecord[], system: ReturnType<SystemMetricsService["snapshot"]>, adapters: UsageWindowMetadata[] = []) {
  const accountLabels = new Map((database.prepare("SELECT id, label FROM agent_accounts").all() as Array<{ id: number; label: string }>).map((row) => [row.id, row.label]));
  const adapterById = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  const latest = system.latest;
  return {
    capturedAt: new Date().toISOString(),
    usage: usageRows.map((row) => ({
      provider: row.provider,
      accountLabel: accountLabels.get(row.account_id) ?? null,
      windowLabel: mobileUsageWindowLabel(row, adapterById.get(row.provider)),
      usedPercent: row.used_percent,
      remainingPercent: row.remaining_percent,
      resetAt: row.reset_at,
      dataStatus: row.data_status,
    })),
    system: latest ? {
      timestamp: latest.timestamp,
      cpuPercent: latest.cpuPercent,
      memoryUsedPercent: latest.memory.total > 0 ? latest.memory.used / latest.memory.total * 100 : null,
    } : null,
  };
}

// Android WebView 앱의 위젯 스냅샷과 FCM 기기 등록 API를 구성한다.
export function createMobileRouter(database: AppDatabase, usage: UsageMonitor, metrics: SystemMetricsService, fcm: FcmNotifier, adapters: ProviderAdapter[] = []): Router {
  const router = Router();
  router.get("/mobile/widget", (_request, response) => {
    response.json(buildMobileWidgetSnapshot(database, usage.list(), metrics.snapshot(), adapters));
  });
  router.get("/mobile/push", requireAdmin, (_request, response) => response.json(fcm.status()));
  router.post("/mobile/push-token", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      const token = typeof request.body?.token === "string" ? request.body.token : "";
      const label = typeof request.body?.label === "string" ? request.body.label : undefined;
      fcm.registerDevice(request.authUser!.id, token, label);
      writeAudit(database, request.authUser!.id, "mobile.push.register", "push_device", null, { platform: "android" });
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });
  router.delete("/mobile/push-token", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      const token = typeof request.body?.token === "string" ? request.body.token : "";
      fcm.unregisterDevice(request.authUser!.id, token);
      writeAudit(database, request.authUser!.id, "mobile.push.unregister", "push_device", null, { platform: "android" });
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });
  router.post("/mobile/push/test", requireAdmin, async (request: AuthenticatedRequest, response) => {
    await fcm.notify(`fcm-test:${Date.now()}:${request.authUser!.id}`, "test", "Android 앱 FCM 알림 테스트입니다.");
    response.json({ requested: true });
  });
  return router;
}
