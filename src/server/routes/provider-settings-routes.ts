import express, { Router } from "express";
import type { AppDatabase } from "../core/database";
import { requireAdmin, requireNonTemporarySession, type AuthenticatedRequest } from "../core/auth";
import { writeAudit } from "../core/audit";
import { parseSettingsProviders, type ProviderSettingsService } from "../services/provider-settings";
import type { FederationService } from "../services/federation";

// 번들 수신 경로. 전역 2MB JSON 파서를 건너뛰고 인증 뒤에 큰 본문 파서로 읽는다(base64 번들 20MiB 기준).
export const PROVIDER_SETTINGS_APPLY_PATH = "/api/provider-settings/apply";
const bundleParser = express.json({ limit: "32mb" });

// 공급자 설정(전역 지침·스킬·훅) 요약·백업·복원, 원격 번들 적용, 연결 컴퓨터로의 동기화 API를 구성한다.
export function createProviderSettingsRouter(database: AppDatabase, settings: ProviderSettingsService, federation: FederationService): Router {
  const router = Router();
  router.get("/provider-settings/summary", requireAdmin, (_request, response) => response.json({ providers: settings.summary() }));
  router.get("/provider-settings/backups", requireAdmin, (_request, response) => response.json({ backups: settings.listBackups() }));
  router.post("/provider-settings/backups", requireAdmin, requireNonTemporarySession, (request: AuthenticatedRequest, response) => {
    const backup = settings.createBackup(parseSettingsProviders(request.body?.providers), "manual");
    writeAudit(database, request.authUser!.id, "provider_settings.backup", "provider_settings", backup.id, { providers: backup.providers, files: backup.fileCount });
    response.status(201).json({ backup });
  });
  router.post("/provider-settings/backups/:id/restore", requireAdmin, requireNonTemporarySession, (request: AuthenticatedRequest, response) => {
    const result = settings.restore(String(request.params.id));
    writeAudit(database, request.authUser!.id, "provider_settings.restore", "provider_settings", String(request.params.id), { written: result.written, removed: result.removed, safetyBackup: result.backup.id });
    response.json(result);
  });
  router.delete("/provider-settings/backups/:id", requireAdmin, requireNonTemporarySession, (request: AuthenticatedRequest, response) => {
    settings.deleteBackup(String(request.params.id));
    writeAudit(database, request.authUser!.id, "provider_settings.backup_delete", "provider_settings", String(request.params.id), {});
    response.status(204).end();
  });
  // 메인 WAM이 federation 연결 토큰으로 보내는 번들을 받아 적용한다(적용 전 자동 백업).
  router.post("/provider-settings/apply", requireAdmin, requireNonTemporarySession, bundleParser, (request: AuthenticatedRequest, response) => {
    const result = settings.apply(request.body?.bundle, "before-sync");
    writeAudit(database, request.authUser!.id, "provider_settings.apply", "provider_settings", result.backup.id, { federation: Boolean(request.federationAuthenticated), written: result.written, removed: result.removed });
    response.json(result);
  });
  // 컴퓨터 단위 설정 모드. follow는 메인 설정을 받는 컴퓨터, independent는 따로 구성하는 컴퓨터다.
  router.patch("/federation/nodes/:id", requireAdmin, requireNonTemporarySession, (request: AuthenticatedRequest, response) => {
    const mode = request.body?.settingsMode;
    if (mode !== "follow" && mode !== "independent") return response.status(400).json({ error: "설정 모드는 follow 또는 independent여야 합니다." });
    const changed = database.prepare("UPDATE federation_nodes SET settings_mode = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(mode, String(request.params.id)).changes;
    if (!changed) return response.status(404).json({ error: "연결된 컴퓨터를 찾을 수 없습니다." });
    writeAudit(database, request.authUser!.id, "federation.settings_mode", "federation_node", String(request.params.id), { mode });
    response.json({ settingsMode: mode });
  });
  // 이 WAM(메인)의 설정 번들을 만들어 '메인 따르기' 컴퓨터에 보낸다. 대상은 적용 전 자기 쪽에 자동 백업한다.
  router.post("/federation/nodes/:id/provider-settings/sync", requireAdmin, requireNonTemporarySession, (request: AuthenticatedRequest, response, next) => {
    const node = database.prepare("SELECT id, settings_mode FROM federation_nodes WHERE id = ?").get(String(request.params.id)) as { id: string; settings_mode: string } | undefined;
    if (!node) return response.status(404).json({ error: "연결된 컴퓨터를 찾을 수 없습니다." });
    if (node.settings_mode !== "follow") return response.status(409).json({ error: "독립 구성 컴퓨터에는 메인 설정을 보내지 않습니다. 먼저 '메인 따르기'로 바꾸세요." });
    const bundle = settings.exportBundle(parseSettingsProviders(request.body?.providers));
    void federation.request(node.id, "/provider-settings/apply", "POST", { bundle }).then((result) => {
      const text = Buffer.from(result.body).toString("utf8");
      let body: any = {};
      try { body = JSON.parse(text); } catch { /* 옛 버전 WAM의 HTML 응답 등 */ }
      if (result.status === 404) return response.status(502).json({ error: "대상 WAM이 설정 동기화를 지원하지 않는 버전입니다. 대상도 최신 버전으로 업데이트하세요." });
      if (result.status >= 400) return response.status(502).json({ error: `대상 WAM이 적용을 거부했습니다: ${body?.error ?? result.status}` });
      writeAudit(database, request.authUser!.id, "provider_settings.sync", "federation_node", node.id, { providers: bundle.providers, files: bundle.files.length, remoteBackup: body?.backup?.id });
      response.json({ ...body, sentFiles: bundle.files.length });
    }).catch(next);
  });
  return router;
}
