import { Router } from "express";
import type { AppDatabase } from "../core/database";
import { requireAdmin, requireNonTemporarySession, type AuthenticatedRequest } from "../core/auth";
import { writeAudit } from "../core/audit";
import type { FederationService } from "../services/federation";
import { applyCredential, isCopyableCredential, readCredential, type CopyableCredential, type CredentialDirs } from "../services/credential-sync";

// gh·Codex 인증 파일을 연결 컴퓨터에 복사하는 API(#138). 인증 값은 응답·감사 로그에 넣지 않는다.
export function createCredentialSyncRouter(database: AppDatabase, federation: FederationService, dirs: CredentialDirs, onApplied: (provider: CopyableCredential) => Promise<void>): Router {
  const router = Router();
  // 메인 쪽: 이 WAM의 인증 파일을 서버 안에서 읽어 대상 WAM에 보낸다.
  router.post("/federation/nodes/:id/credentials/:provider/sync", requireAdmin, requireNonTemporarySession, (request: AuthenticatedRequest, response, next) => {
    const provider = request.params.provider;
    const nodeId = String(request.params.id);
    if (!isCopyableCredential(provider)) return response.status(400).json({ error: "파일로 복사할 수 있는 인증은 GitHub(gh)와 Codex뿐입니다. Claude는 원격 로그인을 사용하세요." });
    if (!federation.get(nodeId)) return response.status(404).json({ error: "연결된 컴퓨터를 찾을 수 없습니다." });
    const content = readCredential(provider, dirs);
    void federation.request(nodeId, `/credential-sync/${provider}`, "POST", { content }).then((result) => {
      let body: any = {};
      try { body = JSON.parse(Buffer.from(result.body).toString("utf8")); } catch { /* 옛 버전 WAM */ }
      if (result.status === 404 && !body?.error) return response.status(502).json({ error: "대상 WAM이 인증 동기화를 지원하지 않는 버전입니다. 대상도 최신 버전으로 업데이트하세요." });
      if (result.status >= 400) return response.status(502).json({ error: `대상 WAM이 적용을 거부했습니다: ${body?.error ?? result.status}` });
      writeAudit(database, request.authUser!.id, "credential.sync", "federation_node", nodeId, { provider, remoteBackup: Boolean(body?.backup) });
      response.json({ provider, backedUp: Boolean(body?.backup) });
    }).catch(next);
  });
  // 서브 쪽: 받은 인증 파일을 고정 경로에 쓰고 CLI 인증 상태를 다시 검사한다.
  router.post("/credential-sync/:provider", requireAdmin, requireNonTemporarySession, (request: AuthenticatedRequest, response, next) => {
    const provider = request.params.provider;
    if (!isCopyableCredential(provider)) return response.status(400).json({ error: "지원하지 않는 인증입니다." });
    const result = applyCredential(provider, request.body?.content, dirs);
    writeAudit(database, request.authUser!.id, "credential.apply", "provider", provider, { federation: Boolean(request.federationAuthenticated), backedUp: Boolean(result.backup) });
    void onApplied(provider).catch(() => undefined).then(() => response.json({ backup: result.backup })).catch(next);
  });
  return router;
}
