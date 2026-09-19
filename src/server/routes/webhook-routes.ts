import crypto from "node:crypto";
import { Router } from "express";
import type { AppDatabase } from "../core/database";
import { requireAdmin, type AuthenticatedRequest } from "../core/auth";
import { requireTrustedNetwork } from "../core/network";
import { writeAudit } from "../core/audit";
import type { WebhookNotifier } from "../services/webhook";

export function createWebhookRouter(database: AppDatabase, webhook: WebhookNotifier): Router {
  const router = Router();
  router.get("/admin/webhook-settings", requireAdmin, (_request, response) => response.json(webhook.settingsForAdmin()));
  router.put("/admin/webhook-settings", requireAdmin, requireTrustedNetwork, (request: AuthenticatedRequest, response, next) => {
    try {
      if (typeof request.body?.endpointUrl !== "string" || typeof request.body?.signingSecret !== "string" || typeof request.body?.enabled !== "boolean") {
        throw new Error("Webhook 설정 형식이 올바르지 않습니다.");
      }
      const endpointChanged = request.body.endpointUrl.trim().length > 0;
      const signingSecretChanged = request.body.signingSecret.trim().length > 0;
      const settings = webhook.updateSettings(request.body.endpointUrl, request.body.signingSecret, request.body.enabled);
      writeAudit(database, request.authUser!.id, "webhook.settings.update", "webhook_settings", "1", {
        enabled: settings.enabled, endpointHost: settings.endpointHost, endpointChanged, signingSecretChanged,
      });
      response.json(settings);
    } catch (error) { next(error); }
  });
  router.post("/webhook/test", requireAdmin, requireTrustedNetwork, async (request: AuthenticatedRequest, response, next) => {
    try {
      const eventId = `webhook-test:${crypto.randomUUID()}`;
      await webhook.sendTest(eventId);
      writeAudit(database, request.authUser!.id, "webhook.test", "webhook_delivery", eventId, { status: "sent" });
      response.json({ sent: true });
    } catch (error) { next(error); }
  });
  return router;
}
