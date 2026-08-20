import { Router } from "express";
import type { AppDatabase } from "../core/database";
import { requireAdmin, type AuthenticatedRequest } from "../core/auth";
import { requireTrustedNetwork } from "../core/network";
import { writeAudit } from "../core/audit";
import type { AgentAccountService } from "../services/agent-accounts";
import type { CliAuthManager } from "../services/cli-auth";
import type { UsageMonitor } from "../services/usage-monitor";
import type { SessionManager } from "../services/session-manager";
import type { AgentAccountSummary, Provider, UsageMonitorScope } from "../../shared/types";

const PROVIDERS = new Set<Provider>(["codex", "claude", "grok"]);
const SCOPES = new Set<UsageMonitorScope>(["default", "all"]);

// 계정 슬롯 관리와 사용량 조회 범위 설정 API를 구성한다.
// 계정 자체는 인증 정보를 담은 폴더를 가리키므로 조회를 포함해 전부 관리자 전용이다.
export function createAgentAccountRouter(
  database: AppDatabase,
  accounts: AgentAccountService,
  cliAuth: CliAuthManager,
  usage: UsageMonitor,
  sessions: SessionManager,
): Router {
  const router = Router();

  router.get("/agent-accounts", requireAdmin, async (_request, response, next) => {
    try {
      // 로그인 여부는 CLI 상태 조회 결과를 그대로 쓴다(계정 폴더의 인증 파일은 읽지 않는다).
      const authStatus = await cliAuth.status();
      const authenticated = new Map(authStatus.providers.map((entry) => [entry.key, entry.authenticated]));
      const summaries: AgentAccountSummary[] = accounts.list().map((account) => ({
        ...account,
        authenticated: authenticated.get(`${account.provider}:${account.id}`) ?? false,
        chatCount: accounts.chatCount(account.id),
      }));
      response.json({ accounts: summaries, usageScope: accounts.usageScope() });
    } catch (error) {
      next(error);
    }
  });

  router.post("/agent-accounts", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      const provider = String(request.body?.provider) as Provider;
      if (!PROVIDERS.has(provider)) throw new Error("지원하지 않는 공급자입니다.");
      const account = accounts.create(provider, String(request.body?.label ?? ""));
      writeAudit(database, request.authUser!.id, "agent_account.create", "agent_account", account.id, { provider, label: account.label });
      response.status(201).json({ account });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/agent-accounts/:id", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      const account = accounts.rename(Number(request.params.id), String(request.body?.label ?? ""));
      writeAudit(database, request.authUser!.id, "agent_account.rename", "agent_account", account.id, { label: account.label });
      response.json({ account });
    } catch (error) {
      next(error);
    }
  });

  // 계정 삭제는 인증이 든 폴더까지 지울 수 있어 되돌릴 수 없다 — 다른 불가역 작업과 같은 내부망 제한을 건다.
  router.delete("/agent-accounts/:id", requireAdmin, requireTrustedNetwork, (request: AuthenticatedRequest, response, next) => {
    try {
      const id = Number(request.params.id);
      const removeFiles = request.query.removeFiles === "1";
      accounts.remove(id, removeFiles);
      usage.applyScopeChange();
      writeAudit(database, request.authUser!.id, "agent_account.delete", "agent_account", id, { removeFiles });
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.put("/agent-accounts/usage-scope", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      const scope = String(request.body?.scope) as UsageMonitorScope;
      if (!SCOPES.has(scope)) throw new Error("지원하지 않는 사용량 조회 범위입니다.");
      accounts.setUsageScope(scope);
      // 범위를 넓히면 새 계정의 조회 PTY를 띄우고, 좁히면 빠진 계정의 PTY와 저장된 상태를 정리한다.
      usage.applyScopeChange();
      writeAudit(database, request.authUser!.id, "agent_account.usage_scope", "setting", scope);
      response.json({ scope });
    } catch (error) {
      next(error);
    }
  });

  router.put("/chats/:id/account", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      const chatId = Number(request.params.id);
      const accountId = request.body?.accountId != null ? Number(request.body.accountId) : null;
      sessions.assignAccount(chatId, accountId, request.authUser!);
      response.json({ chat: database.prepare("SELECT * FROM chats WHERE id = ?").get(chatId) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
