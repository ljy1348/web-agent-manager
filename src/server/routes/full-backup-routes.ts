import { Router } from "express";
import type { AppDatabase } from "../core/database";
import { requireAdmin, type AuthenticatedRequest } from "../core/auth";
import { requireTrustedNetwork } from "../core/network";
import { writeAudit } from "../core/audit";
import type { FullBackupService } from "../services/full-backup";

export function createFullBackupRouter(database: AppDatabase, backups: FullBackupService): Router {
  const router = Router();
  router.get("/admin/full-backups", requireAdmin, (_request, response) => response.json({ backups: backups.list() }));
  router.post("/admin/full-backups", requireAdmin, requireTrustedNetwork, async (request: AuthenticatedRequest, response, next) => {
    try {
      const passphrase = typeof request.body?.passphrase === "string" ? request.body.passphrase : "";
      const backup = await backups.create(passphrase);
      writeAudit(database, request.authUser!.id, "full_backup.create", "full_backup", backup.id, {
        sizeBytes: backup.sizeBytes, counts: backup.counts, entries: backup.entries.map((entry) => entry.path),
      });
      response.status(201).json({ backup });
    } catch (error) { next(error); }
  });
  router.get("/admin/full-backups/:id/download", requireAdmin, requireTrustedNetwork, (request: AuthenticatedRequest, response, next) => {
    try {
      const id = String(request.params.id);
      const file = backups.file(id);
      writeAudit(database, request.authUser!.id, "full_backup.download", "full_backup", id);
      response.download(file, `${id}.wambackup`);
    } catch (error) { next(error); }
  });
  router.delete("/admin/full-backups/:id", requireAdmin, requireTrustedNetwork, (request: AuthenticatedRequest, response, next) => {
    try {
      const id = String(request.params.id);
      backups.delete(id);
      writeAudit(database, request.authUser!.id, "full_backup.delete", "full_backup", id);
      response.status(204).end();
    } catch (error) { next(error); }
  });
  return router;
}
