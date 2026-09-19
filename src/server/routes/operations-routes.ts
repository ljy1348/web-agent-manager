import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Router } from "express";
import type { AppDatabase } from "../core/database";
import { requireAdmin, requireNonTemporarySession, requireTestOperator, type AuthenticatedRequest } from "../core/auth";
import type { ApprovalService } from "../services/approval";
import type { UsageMonitor } from "../services/usage-monitor";
import type { SessionManager } from "../services/session-manager";
import type { SystemMetricsService } from "../services/system-metrics";
import type { SlackNotifier } from "../services/slack";
import type { NtfyNotifier } from "../services/ntfy";
import type { Provider } from "../../shared/types";
import { writeAudit } from "../core/audit";
import type { IdleChatReaper } from "../services/idle-chat-reaper";
import type { ProviderAdapter } from "../providers/provider";
import { ProviderCapabilityRegistry } from "../services/provider-capabilities";
import type { CodexStructuredShadowService } from "../services/codex-structured-shadow";
import type { ProviderCanaryService } from "../services/provider-canary";
import type { ProviderUpdateLedger } from "../services/provider-update-ledger";
import type { ProviderCliBackupService, ProviderBackupManifest } from "../services/provider-cli-backup";
import type { ProviderRolloutService } from "../services/provider-rollout";

const runFile = promisify(execFile);

// CLI 버전 명령을 실행하고 첫 출력 줄만 반환한다.
async function version(command: string, args: string[]): Promise<string | null> {
  try {
    const { stdout, stderr } = await runFile(command, args, { timeout: 5_000 });
    return `${stdout}${stderr}`.trim().split("\n")[0] || null;
  } catch {
    return null;
  }
}

// 어댑터가 선언한 고정 명령만 직접 실행한다. 셸을 거치지 않아 공급자·요청값이 임의 명령으로
// 해석되지 않으며, 설치 파일 다운로드 시간을 고려해 버전 조회보다 긴 제한을 둔다.
async function updateCli(command: string, args: string[]): Promise<void> {
  await runFile(command, args, { timeout: 5 * 60_000, maxBuffer: 2 * 1024 * 1024 });
}

// 승인·사용량·시스템·Slack 운영 API를 구성한다.
export function createOperationsRouter(
  database: AppDatabase,
  approvals: ApprovalService,
  usage: UsageMonitor,
  metrics: SystemMetricsService,
  slack: SlackNotifier,
  ntfy: NtfyNotifier,
  adapters: ProviderAdapter[],
  idleChatReaper: IdleChatReaper,
  readVersion: typeof version = version,
  sessions?: Pick<SessionManager, "restartProviderTerminals">,
  runCliUpdate: typeof updateCli = updateCli,
  codexShadow?: Pick<CodexStructuredShadowService, "snapshot" | "probeChat">,
  providerCanaries?: Pick<ProviderCanaryService, "run" | "list" | "latest" | "authorizeUpdate">,
  providerUpdates?: Pick<ProviderUpdateLedger, "start" | "findByIdempotency" | "latest" | "transition" | "invariantsPreserved" | "setBackupManifest" | "beginRollback" | "backupManifest" | "get">,
  providerBackups?: Pick<ProviderCliBackupService, "prepare" | "restore">,
  providerRollouts?: Pick<ProviderRolloutService, "start" | "latest" | "get" | "authorizePromotion" | "promote" | "halt">,
): Router {
  const router = Router();
  const adapterById = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  const updatingProviders = new Set<Provider>();
  const capabilityRegistry = new ProviderCapabilityRegistry(database);
  // 런타임 버전은 서버 라우터 생성 시 한 번만 조회해 모든 API 요청에서 재사용한다.
  const runtimeSnapshot = (async (): Promise<Record<string, string | null>> => {
    const providerVersions = await Promise.all(adapters.map(async (adapter) => [
      adapter.id,
      await readVersion(adapter.cliVersionCommand.command, adapter.cliVersionCommand.args),
    ] as const));
    const [git, gh, tmux] = await Promise.all([
      readVersion("git", ["--version"]),
      readVersion("gh", ["--version"]),
      readVersion("tmux", ["-V"]),
    ]);
    return { ...Object.fromEntries(providerVersions), git, gh, tmux };
  })();
  const getProvider = (value: string): Provider => {
    const provider = value as Provider;
    if (!adapterById.has(provider)) throw new Error("지원하지 않는 공급자입니다.");
    return provider;
  };
  router.get("/providers", (_request, response) => {
    response.json({ providers: adapters.map((adapter) => ({
      id: adapter.id,
      label: adapter.displayLabel,
      usageWindowId: adapter.usageWindowId,
      usageWindowLabels: adapter.usageWindowLabels ?? {},
      supportsSessionRename: !!adapter.supportsSessionRename,
      supportsPermissionMode: !!adapter.detectPermissionMode,
      supportsCliUpdate: !!adapter.cliUpdateCommand,
    })) });
  });
  router.get("/providers/capabilities", async (request: AuthenticatedRequest, response, next) => {
    try {
      const versions = await runtimeSnapshot;
      const providers = adapters.map((adapter) => capabilityRegistry.capture(adapter, versions[adapter.id] ?? null));
      response.json({
        providers,
        canaries: providerCanaries?.latest() ?? [],
        updates: request.authUser?.role === "admin" ? providerUpdates?.latest() ?? [] : [],
        rollouts: request.authUser?.role === "admin" ? providerRollouts?.latest() ?? [] : [],
        rolloutConfigured: !!providerRollouts,
      });
    } catch (error) {
      next(error);
    }
  });
  router.get("/providers/:provider/canaries", requireTestOperator, (request, response, next) => {
    try {
      const provider = getProvider(String(request.params.provider));
      response.json({ canaries: providerCanaries?.list(provider, 20) ?? [] });
    } catch (error) {
      next(error);
    }
  });
  // 후보 버전 문자열만 입력받는다. 실행 파일·인자·환경은 서버에 고정된 harness가 결정하므로
  // 관리자 요청이 임의 명령 실행 경로로 바뀌지 않는다.
  router.post("/providers/:provider/canaries", requireTestOperator, async (request: AuthenticatedRequest, response, next) => {
    try {
      if (!providerCanaries) throw Object.assign(new Error("CLI canary 서비스가 준비되지 않았습니다."), { statusCode: 503 });
      const provider = getProvider(String(request.params.provider));
      const adapter = adapterById.get(provider)!;
      const candidateVersion = typeof request.body?.candidateVersion === "string" ? request.body.candidateVersion : "";
      const idempotencyKey = typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : "";
      const versions = await runtimeSnapshot;
      const canary = await providerCanaries.run({
        provider,
        adapter,
        currentVersion: versions[provider] ?? null,
        candidateVersion,
        idempotencyKey,
        userId: request.authUser!.id,
      });
      const run = canary.run as Record<string, unknown>;
      writeAudit(database, request.authUser!.id, "provider.cli_canary", "provider", provider, {
        canaryRunId: run.id,
        currentVersion: run.currentVersion,
        candidateVersion: run.candidateVersion,
        state: run.state,
      });
      response.status(201).json({ canary });
    } catch (error) {
      next(error);
    }
  });
  router.get("/admin/providers/codex/shadow", requireAdmin, (_request, response) => {
    response.json(codexShadow?.snapshot() ?? { enabled: false, mode: "off", windowDays: 7, summary: {}, latest: [] });
  });
  router.post("/providers/:provider/rollouts", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    try {
      if (!providerCanaries || !providerRollouts) throw Object.assign(new Error("단계 rollout 서비스가 설정되지 않았습니다."), { statusCode: 503 });
      const provider = getProvider(String(request.params.provider));
      const adapter = adapterById.get(provider)!;
      const versions = await runtimeSnapshot;
      const canaryRunId = typeof request.body?.canaryRunId === "string" ? request.body.canaryRunId : "";
      const authorization = providerCanaries.authorizeUpdate(provider, canaryRunId, versions[provider] ?? null);
      const rollout = await providerRollouts.start({ provider, canaryRunId, candidateVersion: authorization.candidateVersion,
        candidateSha256: authorization.candidateSha256,
        versionArgs: adapter.cliVersionCommand.args, maxNewChats: Number(request.body?.maxNewChats),
        idempotencyKey: String(request.header("Idempotency-Key") ?? "").trim(), userId: request.authUser!.id });
      writeAudit(database, request.authUser!.id, "provider.cli_rollout_start", "provider", provider, {
        rolloutRunId: rollout.id, canaryRunId, candidateVersion: authorization.candidateVersion,
        maxNewChats: rollout.maxNewChats, replay: rollout.replay === true,
      });
      response.status(201).json({ rollout });
    } catch (error) { next(error); }
  });
  router.post("/providers/:provider/rollouts/:runId/halt", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      if (!providerRollouts) throw Object.assign(new Error("단계 rollout 서비스가 설정되지 않았습니다."), { statusCode: 503 });
      const provider = getProvider(String(request.params.provider));
      const rollout = providerRollouts.halt(String(request.params.runId), provider, request.authUser!.id);
      writeAudit(database, request.authUser!.id, "provider.cli_rollout_halt", "provider_rollout", String(request.params.runId), { provider });
      response.json({ rollout });
    } catch (error) { next(error); }
  });
  router.post("/admin/providers/codex/shadow/chats/:chatId/probe", requireAdmin, async (request, response, next) => {
    try {
      if (!codexShadow) throw Object.assign(new Error("Codex app-server shadow가 비활성화되어 있습니다."), { statusCode: 409 });
      const chatId = Number(request.params.chatId);
      if (!Number.isInteger(chatId) || chatId < 1) throw new Error("유효한 채팅 ID가 필요합니다.");
      response.json({ observation: await codexShadow.probeChat(chatId) });
    } catch (error) {
      next(error);
    }
  });
  // 공급자 CLI를 최신 버전으로 갱신한 뒤, 구버전을 메모리에 유지하는 모든 채팅·상태 조회 PTY를
  // 재시작한다. 관리자 한 명의 중복 클릭으로 같은 설치 파일을 동시에 바꾸지 않도록 공급자별 잠금을 둔다.
  router.post("/providers/:provider/update", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    let provider: Provider | undefined;
    let updateLockHeld = false;
    let updateRunId: string | undefined;
    let updateInProgress = false;
    try {
      provider = getProvider(String(request.params.provider));
      const adapter = adapterById.get(provider)!;
      if (!adapter.cliUpdateCommand) throw new Error("이 공급자는 CLI 업데이트를 지원하지 않습니다.");
      if (!sessions) throw new Error("터미널 재시작 서비스가 준비되지 않았습니다.");
      if (!providerCanaries) throw Object.assign(new Error("CLI canary 서비스가 준비되지 않았습니다."), { statusCode: 503 });
      if (!providerUpdates) throw Object.assign(new Error("CLI update 원장 서비스가 준비되지 않았습니다."), { statusCode: 503 });
      if (!providerBackups) throw Object.assign(new Error("CLI backup 서비스가 준비되지 않았습니다."), { statusCode: 503 });
      if (updatingProviders.has(provider)) throw new Error("이 공급자의 CLI 업데이트가 이미 진행 중입니다.");
      updatingProviders.add(provider);
      updateLockHeld = true;

      const canaryRunId = typeof request.body?.canaryRunId === "string" ? request.body.canaryRunId : "";
      const idempotencyKey = String(request.header("Idempotency-Key") ?? "").trim();
      const rolloutRunId = typeof request.body?.rolloutRunId === "string" ? request.body.rolloutRunId : "";
      const replay = providerUpdates.findByIdempotency(provider, idempotencyKey, canaryRunId);
      if (replay) {
        const replayRun = replay.run as Record<string, unknown>;
        if (replayRun.state !== "applied") throw Object.assign(new Error(`기존 update 실행 상태가 ${String(replayRun.state)}이므로 다시 실행하지 않습니다.`), { statusCode: 409 });
        if (providerRollouts) {
          if (!rolloutRunId || replayRun.rollout_run_id !== rolloutRunId) throw Object.assign(new Error("update 실행과 단계 rollout이 일치하지 않습니다."), { statusCode: 409 });
          const rollout = providerRollouts.get(rolloutRunId) as Record<string, unknown>;
          if (rollout.state === "active") {
            providerRollouts.authorizePromotion(rolloutRunId, provider, canaryRunId);
            providerRollouts.promote(rolloutRunId, request.authUser!.id);
          } else if (rollout.state !== "promoted") throw Object.assign(new Error("단계 rollout이 승격 가능한 상태가 아닙니다."), { statusCode: 409 });
        }
        return response.json({
          status: "completed", provider, canaryRunId, updateRunId: replayRun.id,
          previousVersion: replayRun.previous_version, currentVersion: replayRun.installed_version,
          restartedMonitorCount: 0, restartedChatIds: [], failures: [], warnings: [], replay: true,
        });
      }
      const versions = await runtimeSnapshot;
      const previousVersion = versions[provider] ?? null;
      if (!previousVersion) throw Object.assign(new Error("현재 CLI 버전을 확인할 수 없어 안전한 rollback을 준비할 수 없습니다."), { statusCode: 409 });
      const authorization = providerCanaries.authorizeUpdate(provider, canaryRunId, previousVersion);
      if (providerRollouts) providerRollouts.authorizePromotion(rolloutRunId, provider, canaryRunId);
      const updateRecord = providerUpdates.start({ provider, canaryRunId, idempotencyKey, previousVersion, candidateVersion: authorization.candidateVersion, userId: request.authUser!.id, rolloutRunId: rolloutRunId || null });
      updateRunId = String((updateRecord.run as Record<string, unknown>).id);
      let backupManifest: ProviderBackupManifest;
      try {
        backupManifest = providerBackups.prepare(updateRunId, provider, adapter.cliVersionCommand.command);
        providerUpdates.setBackupManifest(updateRunId, backupManifest as unknown as Record<string, unknown>);
      } catch (error) {
        providerUpdates.transition(updateRunId, "failed", { reason: "backup_failed" });
        throw error;
      }
      providerUpdates.transition(updateRunId, "updating");
      updateInProgress = true;
      await runCliUpdate(adapter.cliUpdateCommand.command, adapter.cliUpdateCommand.args);
      const currentVersion = await readVersion(adapter.cliVersionCommand.command, adapter.cliVersionCommand.args);
      if (currentVersion !== authorization.candidateVersion) {
        providerUpdates.transition(updateRunId, "rollback_required", { reason: "installed_version_mismatch", installedVersion: currentVersion });
        updateInProgress = false;
        throw Object.assign(new Error("설치된 CLI 버전이 canary 후보와 달라 터미널 재시작을 중단했습니다."), { statusCode: 409 });
      }
      // 설치 명령이 성공했다면 버전 출력 파싱만 실패해도 구버전 PTY를 남겨두지 않는다.
      // 버전 확인 실패는 경고로 반환하고, 확인된 값이 있을 때만 런타임 캐시를 교체한다.
      const warnings = currentVersion ? [] : ["업데이트 후 CLI 버전을 확인하지 못했습니다."];
      if (currentVersion) versions[provider] = currentVersion;

      const restartedMonitorCount = usage.restartProviderTerminals(provider);
      const chats = await sessions.restartProviderTerminals(provider, request.authUser!);
      const invariantsPreserved = providerUpdates.invariantsPreserved(updateRunId);
      if (!invariantsPreserved) {
        providerUpdates.transition(updateRunId, "rollback_required", { reason: "session_invariant_changed", installedVersion: currentVersion, invariantsPreserved: false });
        updateInProgress = false;
        throw Object.assign(new Error("업데이트 중 세션·task·profile 불변성이 바뀌어 rollback이 필요합니다."), { statusCode: 409 });
      }
      const status = chats.failures.length || warnings.length ? "partial" : "completed";
      providerUpdates.transition(updateRunId, "applied", { installedVersion: currentVersion, invariantsPreserved: true, restartedMonitorCount, restartedChatCount: chats.restartedChatIds.length });
      if (providerRollouts) providerRollouts.promote(rolloutRunId, request.authUser!.id);
      updateInProgress = false;
      writeAudit(database, request.authUser!.id, "provider.cli_update", "provider", provider, {
        previousVersion,
        currentVersion,
        canaryRunId: authorization.canaryRunId,
        updateRunId,
        rolloutRunId: rolloutRunId || null,
        restartedMonitorCount,
        restartedChatIds: chats.restartedChatIds,
        failures: chats.failures,
        warnings,
        status,
      });
      response.json({
        status,
        provider,
        canaryRunId: authorization.canaryRunId,
        updateRunId,
        previousVersion,
        currentVersion,
        restartedMonitorCount,
        restartedChatIds: chats.restartedChatIds,
        failures: chats.failures,
        warnings,
      });
    } catch (error) {
      if (updateRunId && updateInProgress && providerUpdates) {
        try { providerUpdates.transition(updateRunId, "rollback_required", { reason: "update_execution_failed" }); } catch { /* 원래 update 오류를 유지한다. */ }
      }
      next(error);
    } finally {
      if (provider && updateLockHeld) updatingProviders.delete(provider);
    }
  });
  router.post("/providers/:provider/updates/:runId/rollback", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    try {
      if (!providerUpdates || !providerBackups || !sessions) throw Object.assign(new Error("CLI rollback 서비스가 준비되지 않았습니다."), { statusCode: 503 });
      const provider = getProvider(String(request.params.provider));
      const runId = String(request.params.runId);
      const idempotencyKey = String(request.header("Idempotency-Key") ?? "").trim();
      const before = providerUpdates.get(runId);
      const run = before.run as Record<string, unknown>;
      if (run.provider !== provider) throw Object.assign(new Error("공급자와 update 실행이 일치하지 않습니다."), { statusCode: 409 });
      const begun = providerUpdates.beginRollback(runId, idempotencyKey, request.authUser!.id);
      if (begun.replay) return response.json({ status: "rolled_back", update: begun.record, replay: true });
      try {
        providerBackups.restore(runId, providerUpdates.backupManifest(runId) as unknown as ProviderBackupManifest);
        const adapter = adapterById.get(provider)!;
        const restoredVersion = await readVersion(adapter.cliVersionCommand.command, adapter.cliVersionCommand.args);
        if (restoredVersion !== run.previous_version) {
          providerUpdates.transition(runId, "rollback_failed", { reason: "restored_version_mismatch", installedVersion: restoredVersion });
          throw Object.assign(new Error("복원된 CLI 버전이 이전 버전과 일치하지 않습니다."), { statusCode: 409 });
        }
        const restartedMonitorCount = usage.restartProviderTerminals(provider);
        const chats = await sessions.restartProviderTerminals(provider, request.authUser!);
        const invariantsPreserved = providerUpdates.invariantsPreserved(runId);
        if (!invariantsPreserved) {
          providerUpdates.transition(runId, "rollback_failed", { reason: "session_invariant_changed", installedVersion: restoredVersion, invariantsPreserved: false });
          throw Object.assign(new Error("rollback 뒤 세션·task·profile 불변성이 유지되지 않았습니다."), { statusCode: 409 });
        }
        const final = providerUpdates.transition(runId, "rolled_back", { installedVersion: restoredVersion, invariantsPreserved: true, restartedMonitorCount, restartedChatCount: chats.restartedChatIds.length });
        const versions = await runtimeSnapshot;
        versions[provider] = restoredVersion;
        writeAudit(database, request.authUser!.id, "provider.cli_rollback", "provider_update", runId, { provider, restoredVersion, restartedMonitorCount, restartedChatIds: chats.restartedChatIds, failures: chats.failures });
        response.json({ status: "rolled_back", provider, restoredVersion, restartedMonitorCount, restartedChatIds: chats.restartedChatIds, failures: chats.failures, update: final });
      } catch (error) {
        const state = (providerUpdates.get(runId).run as Record<string, unknown>).state;
        if (state === "rolling_back") {
          try { providerUpdates.transition(runId, "rollback_failed", { reason: "rollback_execution_failed" }); } catch { /* 원래 오류 유지 */ }
        }
        throw error;
      }
    } catch (error) { next(error); }
  });
  router.get("/approvals", (request: AuthenticatedRequest, response) => {
    // 결정을 막았으면 조회도 막아야 한다. request_payload에는 도구 이름과 인자(경로 등)가 그대로
    // 실려 손님에게 보일 이유가 없고, 목록만 보이면 눌러도 403인 카드가 뜬다.
    // 403이 아니라 빈 목록인 것은 클라이언트 loadCore가 여러 API를 Promise.all로 묶어, 한 곳이
    // 실패하면 임시 사용자 화면 전체 로딩이 깨지기 때문이다.
    if (request.authSession?.temporary) return response.json({ approvals: [] });
    const rows = database.prepare(`
      SELECT a.*, c.title AS chat_title FROM approvals a JOIN chats c ON c.id = a.chat_id
      ORDER BY CASE WHEN a.status = 'pending' THEN 0 ELSE 1 END, a.created_at DESC LIMIT 200
    `).all();
    response.json({ approvals: rows });
  });
  // 임시 세션이 accept를 누르면 강한 권한으로 실행 중인 AI의 도구 실행이 그대로 이어지고,
  // 거부·취소도 남의 작업 흐름을 막을 수 있어 결정 자체를 차단한다. 정식 일반 사용자 계정의
  // 승인 권한은 그대로 둔다.
  router.post("/approvals/:id/decision", requireNonTemporarySession, (request: AuthenticatedRequest, response, next) => {
    try {
      const decision = String(request.body?.decision);
      const approvalId = String(request.params.id);
      // "dismiss"는 웹 목록에서만 정리하는 것이라 AI에 실제 응답을 전달하는 decide()와는 완전히 다른
      // 경로를 탄다(ApprovalService.dismiss 참고) — 아직 실제로 살아있는 요청이면 여기서 에러가 난다.
      if (decision === "dismiss") {
        approvals.dismiss(approvalId, request.authUser!);
        writeAudit(database, request.authUser!.id, "approval.dismiss", "approval", approvalId, {});
        response.status(204).end();
        return;
      }
      if (!["accept", "acceptForSession", "decline", "cancel"].includes(decision)) throw new Error("유효하지 않은 승인 결정입니다.");
      // AskUserQuestion처럼 실제 답변이 필요한 도구 호출은 사용자가 고른 답을 여기 실어 보낸다.
      const answer = typeof request.body?.answer === "string" && request.body.answer.trim() ? request.body.answer.trim().slice(0, 4000) : undefined;
      approvals.decide(approvalId, decision as "accept" | "acceptForSession" | "decline" | "cancel", request.authUser!, answer);
      writeAudit(database, request.authUser!.id, "approval.decide", "approval", approvalId, { decision, answer });
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });
  router.get("/usage", (_request, response) => response.json({ usage: usage.list() }));
  router.post("/usage/:provider/refresh", requireNonTemporarySession, (request, response, next) => {
    try {
      const provider = getProvider(String(request.params.provider));
      usage.refresh(provider);
      response.status(202).json({ accepted: true });
    } catch (error) {
      next(error);
    }
  });
  // 조회 전용 PTY를 지금 끊고 새 프로세스로 갈아탄다. 위의 `refresh`는 이미 떠 있는 PTY에 슬래시
  // 명령만 다시 보내므로, 플랜 변경처럼 CLI가 시작 시점 캐시를 계속 돌려주는 값은 바뀌지 않는다
  // (자동으로는 MONITOR_PTY_MAX_AGE_MS가 지나야 교체된다). 실행 중인 채팅 세션은 건드리지 않아
  // CLI 업데이트 경로와 달리 진행 중인 응답이 끊기지 않는다. 이슈 #86.
  router.post("/usage/:provider/restart", requireNonTemporarySession, (request: AuthenticatedRequest, response, next) => {
    try {
      const provider = getProvider(String(request.params.provider));
      const restartedMonitorCount = usage.restartProviderTerminals(provider);
      writeAudit(database, request.authUser!.id, "usage.monitor_restart", "provider", provider, { restartedMonitorCount });
      response.status(202).json({ accepted: true, restartedMonitorCount });
    } catch (error) {
      next(error);
    }
  });
  // 가치가 있는 초기화권 소모는 관리자만 가능하며, 서비스가 실제 잔여량과 중복 요청을 다시 검증한다.
  router.post("/usage/:provider/reset-credit/redeem", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    try {
      const provider = getProvider(String(request.params.provider));
      const accountId = Number(request.body?.accountId);
      if (!Number.isInteger(accountId) || accountId < 1) throw new Error("유효한 Codex 계정을 지정해주세요.");
      const result = await usage.redeemResetCredit(provider, accountId);
      writeAudit(database, request.authUser!.id, "usage.reset_credit.redeem", "provider", provider, {
        accountId,
        outcome: result.outcome,
        remainingCount: result.after?.availableCount ?? null,
      });
      response.json({ outcome: result.outcome, credits: result.after });
    } catch (error) {
      next(error);
    }
  });
  // 마지막 사용량 조회 때 파서에 실제로 넘어간 원본 화면 텍스트를 그대로 보여준다 — 파싱이 왜
  // 실패·이상하게 됐는지 숫자만으로는 알기 어려워, 실제 CLI 화면을 웹에서 바로 확인할 수 있게 한다.
  router.get("/usage/:provider/snapshot", (request, response, next) => {
    try {
      const provider = getProvider(request.params.provider);
      response.json({ snapshot: usage.snapshot(provider) });
    } catch (error) {
      next(error);
    }
  });
  // 채팅 화면 진입마다 부르므로 CLI를 다시 조회하지 않고 캐시된 목록만 돌려준다.
  router.get("/models/:provider", (request, response, next) => {
    try {
      const provider = getProvider(request.params.provider);
      response.json({ options: usage.cachedModelOptions(provider) });
    } catch (error) {
      next(error);
    }
  });
  // 사용자가 명시적으로 새로고침을 눌렀을 때만 실제 CLI에 /model을 보내 다시 조회한다.
  // 실행 중인 세션 화면을 실제로 조작하므로 임시 세션에는 열지 않는다.
  router.post("/models/:provider/refresh", requireNonTemporarySession, async (request, response, next) => {
    try {
      const provider = getProvider(String(request.params.provider));
      response.json({ options: await usage.modelOptions(provider) });
    } catch (error) {
      next(error);
    }
  });
  router.get("/system", (_request, response) => response.json(metrics.snapshot()));
  // 대시보드 프로세스 표에서 관리자가 직접 종료(SIGTERM)·강제 종료(SIGKILL)할 수 있게 한다.
  // 사용자의 결정으로 외부망 관리자에게도 허용하되, 서버 자기 자신과 init(pid 1)은 계속 거부한다.
  router.post("/system/processes/:pid/kill", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      const pid = Number(request.params.pid);
      if (!Number.isInteger(pid) || pid <= 1) throw new Error("유효하지 않은 PID입니다.");
      if (pid === process.pid) throw new Error("이 앱 자신의 프로세스는 종료할 수 없습니다.");
      // 서버를 띄운 watch 프로세스나 MCP 브리지처럼 앱 구동에 필요한 프로세스도 막는다. 화면에서
      // 버튼을 없애는 것만으로는 API를 직접 부르는 경로가 남는다.
      const systemProcess = metrics.snapshot().latest?.processes.find((item) => item.pid === pid && item.group.kind === "system");
      if (systemProcess) throw new Error("web-agent-manager 시스템 프로세스는 대시보드에서 종료할 수 없습니다.");
      const force = request.body?.force === true;
      process.kill(pid, force ? "SIGKILL" : "SIGTERM");
      writeAudit(database, request.authUser!.id, "process.kill", "process", String(pid), { force });
      response.status(202).json({ accepted: true });
    } catch (error) {
      next(error instanceof Error && (error as NodeJS.ErrnoException).code === "ESRCH" ? new Error("이미 종료된 프로세스입니다.") : error);
    }
  });
  router.get("/slack", (_request, response) => response.json(slack.status()));
  router.post("/slack/test", requireAdmin, async (request: AuthenticatedRequest, response) => {
    const id = `slack-test:${Date.now()}:${request.authUser!.id}`;
    await slack.notify(id, "test", "웹 에이전트 관리자 Slack 연동 테스트입니다.");
    response.json({ requested: true });
  });
  // Slack bot token·channel id는 관리자만 조회·변경할 수 있다(토큰 원문은 응답에 절대 포함하지 않음).
  router.get("/admin/slack-settings", requireAdmin, (_request, response) => {
    response.json(slack.settingsForAdmin());
  });
  router.put("/admin/slack-settings", requireAdmin, (request: AuthenticatedRequest, response) => {
    const botToken = typeof request.body?.botToken === "string" ? request.body.botToken : "";
    const channelId = typeof request.body?.channelId === "string" ? request.body.channelId : "";
    slack.updateSettings(botToken, channelId);
    writeAudit(database, request.authUser!.id, "slack.settings.update", "slack_settings", "1", { channelIdChanged: !!channelId.trim(), botTokenChanged: !!botToken.trim() });
    response.json(slack.settingsForAdmin());
  });
  router.get("/ntfy", (_request, response) => response.json(ntfy.status()));
  router.post("/ntfy/test", requireAdmin, async (request: AuthenticatedRequest, response) => {
    const id = `ntfy-test:${Date.now()}:${request.authUser!.id}`;
    await ntfy.notify(id, "test", "웹 에이전트 관리자 ntfy 연동 테스트입니다.");
    response.json({ requested: true });
  });
  // ntfy topic·서버 URL은 관리자만 조회·변경할 수 있다(topic이 곧 구독 URL의 일부라 토큰처럼 감추지는
  // 않지만, 설정 변경은 여전히 관리자 전용으로 제한한다).
  router.get("/admin/ntfy-settings", requireAdmin, (_request, response) => {
    response.json(ntfy.settingsForAdmin());
  });
  router.put("/admin/ntfy-settings", requireAdmin, (request: AuthenticatedRequest, response) => {
    const topic = typeof request.body?.topic === "string" ? request.body.topic : "";
    const serverUrl = typeof request.body?.serverUrl === "string" ? request.body.serverUrl : "";
    ntfy.updateSettings(topic, serverUrl);
    writeAudit(database, request.authUser!.id, "ntfy.settings.update", "ntfy_settings", "1", { topicChanged: !!topic.trim(), serverUrlChanged: !!serverUrl.trim() });
    response.json(ntfy.settingsForAdmin());
  });
  // 유휴 채팅 자동 종료 정책. 되돌릴 수 없는 동작이라 조회도 관리자로 제한한다.
  router.get("/admin/idle-chat-settings", requireAdmin, (_request, response) => {
    response.json(idleChatReaper.settings());
  });
  router.put("/admin/idle-chat-settings", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      const enabled = request.body?.enabled !== false;
      const timeoutHours = Number(request.body?.timeoutHours ?? 24);
      const saved = idleChatReaper.updateSettings(enabled, timeoutHours);
      writeAudit(database, request.authUser!.id, "idle_chat.settings.update", "idle_chat_settings", "1", { ...saved });
      response.json(saved);
    } catch (error) {
      next(error);
    }
  });
  router.get("/runtime", async (_request, response) => {
    response.json(await runtimeSnapshot);
  });
  return router;
}
