import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { loadConfig } from "./core/config";
import { createNetworkCapability, DEFAULT_TRUSTED_NETWORKS } from "./core/network";
import { initServerLogging, createRequestLogger, createClientLogHandler, createLogger } from "./core/logger";
import { createHttpSecurityHeaders } from "./core/http-security";
import { openDatabase } from "./core/database";
import { ensureOneTimeCodeSecret } from "./core/one-time-login";
import { createRecentReauthenticationGuard, createSessionLoader, requireAdmin, requireAuth, requireCsrf, requiresRecentReauthentication, restrictTestOnlyMutations } from "./core/auth";
import { timingSafeEqualString } from "./core/security";
import { assertDeploymentSecurity, diagnoseDeploymentSecurity } from "./core/deployment-security";
import { createAuthRouter } from "./routes/auth-routes";
import { createProjectRouter } from "./routes/project-routes";
import { createPromptScheduleRouter } from "./routes/prompt-schedule-routes";
import { createFileRouter } from "./routes/file-routes";
import { createInstructionRouter } from "./routes/instruction-routes";
import { createGitRouter } from "./routes/git-routes";
import { createOperationsRouter } from "./routes/operations-routes";
import { createToolRouter } from "./routes/tool-routes";
import { installGrokHooks, prepareRuntimeFiles } from "./services/runtime-files";
import { CodexAdapter } from "./providers/codex";
import { ClaudeAdapter } from "./providers/claude";
import { GrokAdapter } from "./providers/grok";
import { RealtimeHub } from "./services/realtime";
import { SlackNotifier } from "./services/slack";
import { NtfyNotifier } from "./services/ntfy";
import { NotificationHub } from "./services/notifier";
import { ApprovalService } from "./services/approval";
import { SessionManager } from "./services/session-manager";
import { HistorySynchronizer } from "./services/history-sync";
import { AgentHookEventService, HookObserver, HOOK_CHAT_ID_HEADER, parseHookChatId } from "./services/agent-hook-events";
import { HistoryCache } from "./services/history-cache";
import { UsageMonitor } from "./services/usage-monitor";
import { SystemMetricsService } from "./services/system-metrics";
import { SessionBackupService } from "./services/session-backups";
import { RateLimitResumeService } from "./services/rate-limit-resume";
import { AgentBridge } from "./services/agent-bridge";
import { installProjectAgentSkills } from "./services/agent-skill-installer";
import { AgentIntegrationManager } from "./services/agent-integration";
import { createAgentIntegrationRouter } from "./routes/agent-integration-routes";
import { createAgentDelegationRouter } from "./routes/agent-delegation-routes";
import { CliAuthManager } from "./services/cli-auth";
import { AgentAccountService } from "./services/agent-accounts";
import { createCliAuthRouter } from "./routes/cli-auth-routes";
import { createAgentAccountRouter } from "./routes/agent-account-routes";
import { GitWorkspaceService } from "./services/git-workspaces";
import { PromptScheduler } from "./services/prompt-scheduler";
import { IdleChatReaper } from "./services/idle-chat-reaper";
import { UsageResetNotifier } from "./services/usage-reset-notifier";
import { FcmNotifier } from "./services/fcm";
import { createMobileRouter } from "./routes/mobile-routes";
import { MobileDeviceTrustService } from "./services/mobile-device-trust";
import { createMobileTrustBootstrapRouter, createMobileTrustRouter } from "./routes/mobile-trust-routes";
import { TokenUsageLedger } from "./services/token-usage-ledger";
import { createTokenUsageRouter } from "./routes/token-usage-routes";
import { ExperimentService } from "./services/experiment-service";
import { createExperimentRouter } from "./routes/experiment-routes";
import { TaskCommandService } from "./services/task-command-service";
import { ProviderEventJournal } from "./services/provider-event-journal";
import { CodexStructuredShadowService } from "./services/codex-structured-shadow";
import { VerificationService } from "./services/verification-service";
import { createVerificationRouter } from "./routes/verification-routes";
import { createConfiguredProviderCanaryRunner, ProviderCanaryService } from "./services/provider-canary";
import { ProviderUpdateLedger } from "./services/provider-update-ledger";
import { ProviderCliBackupService } from "./services/provider-cli-backup";
import { ProviderRolloutService } from "./services/provider-rollout";
import { CredentialVault } from "./services/credential-vault";
import { FullBackupService } from "./services/full-backup";
import { createFullBackupRouter } from "./routes/full-backup-routes";
import { TaskBoardService } from "./services/task-board";
import { createTaskBoardRouter } from "./routes/task-board-routes";
import { LivePreviewService } from "./services/live-preview";
import { createLivePreviewRouter } from "./routes/live-preview-routes";
import { RemoteWorkerService } from "./services/remote-worker";
import { createRemoteWorkerRouter } from "./routes/remote-worker-routes";
import { WebhookNotifier } from "./services/webhook";
import { createWebhookRouter } from "./routes/webhook-routes";
import { CodexStructuredTransportService } from "./services/codex-structured-transport";
import { setChatBusy } from "./core/chat-busy";

// 종료 신호를 받은 뒤 처리 중이던 요청을 기다려 주는 한계 시간. systemd 유닛의 TimeoutStopSec(20초)과
// 감시 스크립트의 강제 종료 유예(10초)보다 짧게 잡아 항상 애플리케이션이 먼저 스스로 정리하도록 한다.
const SHUTDOWN_GRACE_MS = 5_000;

// 이름 변경 전 남은 비활성 Unix 소켓만 제거해 새 브리지 경로와 혼동되지 않게 한다.
function removeLegacyAgentSocket(dataDir: string): void {
  const legacySocket = path.join(dataDir, "myagent-agent.sock");
  try {
    if (fs.lstatSync(legacySocket).isSocket()) fs.unlinkSync(legacySocket);
  } catch {
    // 기존 소켓이 없거나 다른 파일이면 건드리지 않는다.
  }
}

// 서버 구성 요소를 연결하고 HTTP·WebSocket 서비스를 시작한다.
async function main(): Promise<void> {
  const config = loadConfig();
  if (config.providerCanaryHarnessDir && !config.providerCandidateCliDir) {
    throw new Error("실제 provider canary harness에는 동일 후보를 단계 배포할 WEB_AGENT_MANAGER_PROVIDER_CANDIDATE_CLI_DIR이 필요합니다.");
  }
  initServerLogging(config.dataDir);
  const log = createLogger("server");
  const deploymentSecurity = diagnoseDeploymentSecurity(config, process.env.NODE_ENV === "production");
  assertDeploymentSecurity(deploymentSecurity);
  for (const issue of deploymentSecurity.issues) log.warn("deployment_security", issue);
  const database = openDatabase(config);
  const credentialVault = new CredentialVault(database, config.dataDir);
  const remoteWorkers = new RemoteWorkerService(database, config, credentialVault);
  const fullBackups = new FullBackupService(database, config.dataDir);
  const taskBoard = new TaskBoardService(database);
  const livePreviews = new LivePreviewService(database, config);
  // 일회용 코드 시크릿을 여기서 확정한다. 첫 로그인 요청 때 만들면 잘못된 설정을 그때야 알게 된다.
  ensureOneTimeCodeSecret(config);
  const runtime = prepareRuntimeFiles(config);
  const app = express();
  if (config.trustedProxies?.length) app.set("trust proxy", config.trustedProxies);
  const server = http.createServer(app);
  const realtime = new RealtimeHub(server, database, config.publicUrl, undefined, config.sessionIdleMinutes ?? 720);
  const slack = new SlackNotifier(config, database, credentialVault);
  const ntfy = new NtfyNotifier(config, database);
  const fcm = new FcmNotifier(config, database);
  const webhook = new WebhookNotifier(database, credentialVault);
  const mobileTrust = new MobileDeviceTrustService(database);
  // 각 서비스는 이 허브 하나만 알면 되고, Slack·ntfy 둘 다(또는 나중에 추가될 다른 채널도) 같이 알림이
  // 간다 — 채널별 세부 설정(토큰·topic)은 관리자 설정 API에서만 개별 SlackNotifier·NtfyNotifier로 다룬다.
  const notifications = new NotificationHub([slack, ntfy, fcm, webhook]);
  const approvals = new ApprovalService(config, database, realtime, notifications);
  const adapters = [new CodexAdapter(runtime.codexHookArgs, runtime.hookEnvironment), new ClaudeAdapter(runtime.claudeSettingsFile, runtime.hookEnvironment), new GrokAdapter(runtime.hookEnvironment)];
  // Grok 전역 훅은 신뢰 절차 없이 로드되는 ~/.grok/hooks에만 둘 수 있다(#96). 실패해도 Grok 채팅은
  // 기존 폴링으로 동작하므로 서버 시작을 막지 않는다.
  try {
    installGrokHooks(runtime.grokHooks, path.join(os.homedir(), ".grok"));
  } catch (error) {
    log.warn("grok_hooks_install_failed", { error: error instanceof Error ? error.message : String(error) });
  }
  const accounts = new AgentAccountService(config, database);
  const providerRollouts = config.providerCandidateCliDir ? new ProviderRolloutService(database, config.providerCandidateCliDir, undefined, config.dataDir) : undefined;
  const taskCommands = new TaskCommandService(database);
  const providerEvents = new ProviderEventJournal(database);
  const codexShadow = new CodexStructuredShadowService(
    database,
    accounts,
    config.codexAppServerShadowEnabled === true,
    undefined,
    undefined,
    undefined,
    config.codexInteractiveTransportCandidateEnabled === true,
    config.codexInteractiveTransportCandidateCohort,
    config.codexInteractiveTransportMaxNewChats,
  );
  let history!: HistorySynchronizer;
  let structuredHistoryTimer: NodeJS.Timeout | undefined;
  const structuredTransport = new CodexStructuredTransportService(
    database,
    accounts,
    approvals,
    credentialVault,
    {
      onStatus: (chatId, status, error) => {
        database.prepare("UPDATE chats SET status=?, last_error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(status, error, chatId);
        providerRollouts?.observeChatStatus(chatId, status);
        realtime.broadcast("chat_status", { chatId, status, error });
      },
      onBusy: (chatId, busy) => setChatBusy(database, realtime, chatId, busy),
      onEvent: (event) => {
        providerEvents.record(event);
        taskCommands.observeProviderEvent(event);
      },
      // delta마다 전체 history tree를 훑지 않도록 짧게 합치되 기존 2초 polling보다 먼저 반영한다.
      onHistorySignal: () => {
        if (structuredHistoryTimer) return;
        structuredHistoryTimer = setTimeout(() => {
          structuredHistoryTimer = undefined;
          history?.syncActive(true);
        }, 100);
        structuredHistoryTimer.unref();
      },
    },
    {
      enabled: config.codexInteractiveTransportCandidateEnabled === true,
      cohort: config.codexInteractiveTransportCandidateCohort,
      maxNewChats: config.codexInteractiveTransportMaxNewChats,
      readiness: codexShadow,
    },
  );
  const recoveredStructuredDeliveries = structuredTransport.recoverInterruptedDeliveries();
  if (recoveredStructuredDeliveries > 0) log.warn("재시작 전 진행 중이던 구조화 프롬프트를 재전송 없이 확인 필요 상태로 보존했다", { count: recoveredStructuredDeliveries });
  const sessions = new SessionManager(database, adapters, realtime, approvals, notifications, accounts, providerRollouts, credentialVault, structuredTransport);
  const verifications = new VerificationService(database, config.dataDir, config.homeDir, undefined, undefined, config.verificationArtifactRetentionDays);
  const recoveredVerifications = verifications.recoverInterruptedRuns();
  if (recoveredVerifications > 0) log.warn("재시작 전 끝나지 않은 검증을 확인 필요 상태로 보존했다", { count: recoveredVerifications });
  const artifactCleanup = verifications.cleanupExpiredArtifacts();
  if (artifactCleanup.deleted > 0 || artifactCleanup.skipped > 0) log.info("검증 artifact 보존 정책을 적용했다", artifactCleanup);
  const providerCanaryRunner = config.providerCanaryHarnessDir
    ? createConfiguredProviderCanaryRunner(config.providerCanaryHarnessDir, config.providerCanaryCredentialsDir, config.providerCandidateCliDir)
    : undefined;
  const providerCanaries = new ProviderCanaryService(database, config.dataDir, providerCanaryRunner);
  const recoveredCanaries = providerCanaries.recoverInterruptedRuns();
  if (recoveredCanaries > 0) log.warn("재시작 전 끝나지 않은 CLI canary를 확인 필요 상태로 보존했다", { count: recoveredCanaries });
  const providerUpdates = new ProviderUpdateLedger(database);
  const providerBackups = new ProviderCliBackupService(config.dataDir, config.homeDir);
  const recoveredProviderUpdates = providerUpdates.recoverInterruptedRuns();
  if (recoveredProviderUpdates > 0) log.warn("재시작 중단된 CLI update를 rollback 필요 상태로 보존했다", { count: recoveredProviderUpdates });
  const recoveredPromptCommands = config.taskLedgerEnabled !== false ? taskCommands.recoverInterruptedCommands() : 0;
  if (recoveredPromptCommands > 0) {
    log.warn("재시작 전 전달이 끝나지 않은 프롬프트를 확인 필요 상태로 보존했다", { count: recoveredPromptCommands });
  }
  const reconciledCompletedTurns = config.taskLedgerEnabled !== false ? taskCommands.reconcileCompletedTurns() : 0;
  if (reconciledCompletedTurns > 0) {
    log.info("idle 채팅에 남아 있던 완료 턴의 작업 상태를 정리했다", { count: reconciledCompletedTurns });
  }
  const historyCache = new HistoryCache();
  const tokenUsage = new TokenUsageLedger(database);
  const backups = new SessionBackupService(config, database, adapters, historyCache, accounts, tokenUsage);
  const hookObserver = new HookObserver();
  history = new HistorySynchronizer(config, database, adapters, realtime, notifications, historyCache, approvals, accounts, tokenUsage, hookObserver, taskCommands);
  const agentHookEvents = new AgentHookEventService(database, realtime, () => history.syncActive(true), {
    releaseHistoryFile: (file) => history.forgetHistoryFile(file),
    observer: hookObserver,
    onRateLimit: (chatId, details) => { sessions.registerRateLimitWaitFromHook(chatId, details); },
    onPromptSubmit: (chatId) => sessions.notePromptSubmitted(chatId),
    onNormalizedEvent: (event) => {
      providerEvents.record(event);
      taskCommands.observeProviderEvent(event);
    },
  });
  const usageResetNotifier = new UsageResetNotifier(database, notifications, realtime, adapters);
  // cliAuth는 usage보다 뒤에 만들어져 여기서는 아직 없다 — 클로저로 참조만 걸어두고 실제 호출은
  // usage.start() 이후(cliAuth 생성 뒤)에나 일어나므로 안전하다. 인증 안 된 계정을 무작정 폴링하면
  // codex·claude 모두 로그인 화면에 계속 걸리는 문제가 있어(실사용 보고), 인증된 계정만 조회한다.
  let cliAuth: CliAuthManager;
  const usage = new UsageMonitor(database, adapters, realtime, accounts, usageResetNotifier, (provider, accountId) => cliAuth.isAuthenticatedCached(provider, accountId), notifications);
  const metrics = new SystemMetricsService(realtime, database);
  const rateLimitResume = new RateLimitResumeService(database, sessions, notifications, realtime, adapters);
  const idleChatReaper = new IdleChatReaper(database, (chatId) => sessions.stop(chatId, null));
  const experiments = new ExperimentService(database, config, accounts);
  const agentBridge = new AgentBridge({
    database,
    adapters,
    historyCache,
    sessions,
    experiments,
    socketPath: path.join(config.dataDir, "web-agent-manager-agent.sock"),
  });
  const agentIntegrations = new AgentIntegrationManager(config, database);
  cliAuth = new CliAuthManager(config, realtime, accounts, undefined, (provider, accountId) => usage.notifyAuthenticated(provider, accountId));
  const gitWorkspaces = new GitWorkspaceService(database, config);
  const promptScheduler = new PromptScheduler(database, sessions, adapters, accounts);

  app.disable("x-powered-by");
  app.use(createHttpSecurityHeaders(config.publicUrl, process.env.NODE_ENV !== "production"));
  app.use(express.json({ limit: "2mb" }));
  app.use(createNetworkCapability(config.trustedNetworks?.length ? config.trustedNetworks : DEFAULT_TRUSTED_NETWORKS, Boolean(config.trustedProxies?.length)));
  app.use(createSessionLoader(database, config.sessionIdleMinutes ?? 720));
  app.use(createRequestLogger());
  app.get("/health", (_request, response) => response.json({ ok: true }));
  app.use("/api/auth", createAuthRouter(database, config));
  app.use("/api", createMobileTrustBootstrapRouter(database, config, mobileTrust));
  app.post("/internal/claude/permission", (request, response, next) => {
    if (!timingSafeEqualString(request.headers.authorization ?? "", `Bearer ${runtime.hookToken}`)) return response.status(401).json({ error: "내부 인증 실패" });
    void approvals.handleClaudeHook(request.body, parseHookChatId(request.headers[HOOK_CHAT_ID_HEADER])).then((result) => response.json(result)).catch(next);
  });
  // Codex PermissionRequest 훅(#95). 결정이 없으면 빈 JSON이라 Codex 기본 승인 화면으로 넘어간다.
  app.post("/internal/codex/permission", (request, response, next) => {
    if (!timingSafeEqualString(request.headers.authorization ?? "", `Bearer ${runtime.hookToken}`)) return response.status(401).json({ error: "내부 인증 실패" });
    void approvals.handleCodexHook(request.body, parseHookChatId(request.headers[HOOK_CHAT_ID_HEADER])).then((result) => response.json(result)).catch(next);
  });
  // Claude·Codex 관찰 훅. 응답 본문은 CLI가 훅 출력으로 해석할 수 있으므로 항상 빈 JSON만 돌려준다.
  for (const provider of ["claude", "codex", "grok"] as const) {
    app.post(`/internal/${provider}/hook-event`, (request, response) => {
      if (!timingSafeEqualString(request.headers.authorization ?? "", `Bearer ${runtime.hookToken}`)) return response.status(401).json({ error: "내부 인증 실패" });
      agentHookEvents.handle(provider, request.headers[HOOK_CHAT_ID_HEADER], request.body ?? {});
      response.json({});
    });
  }
  app.use("/api", requireAuth, requireCsrf);
  app.use("/api", restrictTestOnlyMutations);
  const requireRecentReauthentication = createRecentReauthenticationGuard(database, config.reauthenticationWindowMinutes ?? 15);
  app.use("/api", (request: Request, response: Response, next: NextFunction) => requiresRecentReauthentication(request.method, request.path)
    ? requireRecentReauthentication(request, response, next)
    : next());
  app.get("/api/security/deployment", (_request, response) => response.json(deploymentSecurity));
  app.post("/api/logs/client", createClientLogHandler());
  // 훅 도착 관찰 통계(#93). 폴링·추측 fallback을 걷을지 판단하는 근거라 관리자만 본다.
  app.get("/api/admin/hook-stats", requireAdmin, (_request, response) => response.json(hookObserver.snapshot()));
  app.use("/api", createProjectRouter(database, config, sessions, adapters, accounts, historyCache, backups, gitWorkspaces, taskCommands));
  app.use("/api", createPromptScheduleRouter(promptScheduler));
  app.use("/api", createFileRouter(database, gitWorkspaces));
  app.use("/api", createInstructionRouter(database, gitWorkspaces));
  app.use("/api", createGitRouter(database, gitWorkspaces));
  app.use("/api", createToolRouter(database, credentialVault));
  app.use("/api", createFullBackupRouter(database, fullBackups));
  app.use("/api", createTaskBoardRouter(database, taskBoard));
  app.use("/api", createLivePreviewRouter(database, livePreviews));
  app.use("/api", createRemoteWorkerRouter(database, remoteWorkers));
  app.use("/api", createWebhookRouter(database, webhook));
  app.use("/api", createAgentIntegrationRouter(database, agentIntegrations));
  app.use("/api", createCliAuthRouter(database, cliAuth));
  app.use("/api", createAgentAccountRouter(database, accounts, cliAuth, usage, sessions));
  app.use("/api", createAgentDelegationRouter(database, agentBridge));
  app.use("/api", createOperationsRouter(database, approvals, usage, metrics, slack, ntfy, adapters, idleChatReaper, undefined, sessions, undefined, codexShadow, providerCanaries, providerUpdates, providerBackups, providerRollouts));
  app.use("/api", createMobileRouter(database, usage, metrics, fcm, adapters));
  app.use("/api", createMobileTrustRouter(database, mobileTrust));
  app.use("/api", createTokenUsageRouter(tokenUsage));
  app.use("/api", createVerificationRouter(database, verifications));
  app.use("/api", createExperimentRouter(database, experiments));

  if (process.env.NODE_ENV === "production") {
    const clientDir = path.join(config.rootDir, "dist", "client");
    app.use(express.static(clientDir));
    app.get("/{*splat}", (_request, response) => response.sendFile(path.join(clientDir, "index.html")));
  } else {
    const { createServer } = await import("vite");
    const vite = await createServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  }

  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : "서버 오류가 발생했습니다.";
    const statusCode = typeof (error as { statusCode?: unknown })?.statusCode === "number"
      ? (error as { statusCode: number }).statusCode
      : 400;
    log.error("API 오류 응답", { method: request.method, path: request.originalUrl, error });
    response.status(statusCode).json({ error: message });
  });

  const registeredProjects = database.prepare("SELECT path FROM projects WHERE active = 1").all() as Array<{ path: string }>;
  for (const project of registeredProjects) {
    const integration = installProjectAgentSkills(project.path, config.rootDir);
    if (integration.errors.length) log.warn("프로젝트 에이전트 스킬 설치 일부 실패", { projectPath: project.path, errors: integration.errors });
  }
  removeLegacyAgentSocket(config.dataDir);
  await agentBridge.start();
  await agentIntegrations.initialize();
  await cliAuth.initialize();
  await gitWorkspaces.initialize();
  server.listen(config.port, config.host, () => process.stdout.write(`web-agent-manager: ${config.publicUrl}\n`));
  backups.backfillTokenUsage();
  history.start();
  sessions.restore();
  metrics.start();
  if (config.runtimeEnabled) usageResetNotifier.start();
  if (config.runtimeEnabled) usage.start();
  if (config.runtimeEnabled) rateLimitResume.start();
  if (config.runtimeEnabled) idleChatReaper.start();
  if (config.runtimeEnabled) promptScheduler.start();
  if (config.runtimeEnabled) codexShadow.start();
  if (config.runtimeEnabled) taskBoard.start();

  // 종료 신호에서 앱 소유 자원만 닫고 tmux 채팅은 유지한다.
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (config.runtimeEnabled) usage.stop();
    if (config.runtimeEnabled) usageResetNotifier.stop();
    if (config.runtimeEnabled) rateLimitResume.stop();
    if (config.runtimeEnabled) idleChatReaper.stop();
    if (config.runtimeEnabled) promptScheduler.stop();
    if (config.runtimeEnabled) codexShadow.stop();
    if (config.runtimeEnabled) taskBoard.stop();
    metrics.stop();
    if (structuredHistoryTimer) clearTimeout(structuredHistoryTimer);
    history.stop();
    hookObserver.stop();
    sessions.close();
    cliAuth.close();
    const experimentShutdown = experiments.shutdown();

    // 정상 종료와 시간 초과 경로가 함께 도달할 수 있어 마무리는 한 번만 수행한다.
    let finalized = false;
    let forceTimer: NodeJS.Timeout | undefined;
    const finalize = (): void => {
      if (finalized) return;
      finalized = true;
      if (forceTimer) clearTimeout(forceTimer);
      void Promise.allSettled([agentBridge.close(), experimentShutdown]).finally(() => {
        database.close();
        process.exit(0);
      });
    };

    // server.close는 새 연결만 막고 이미 열린 연결이 모두 끊겨야 콜백을 부른다. 웹 화면이 붙어 있으면
    // 승격된 WebSocket이 남아 콜백이 호출되지 않으므로 실시간 연결과 유휴 keep-alive 연결을 먼저 끊는다.
    realtime.close();
    server.close(finalize);
    server.closeIdleConnections();

    // 처리 중이던 요청이 끝나지 않아도 종료가 막히지 않도록 한계 시간이 지나면 남은 연결까지 정리한다.
    forceTimer = setTimeout(() => {
      log.warn("종료 대기 시간이 지나 남은 연결을 정리한다", { graceMs: SHUTDOWN_GRACE_MS });
      server.closeAllConnections();
      finalize();
    }, SHUTDOWN_GRACE_MS);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
