import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { loadConfig } from "./core/config";
import { createNetworkCapability, DEFAULT_TRUSTED_NETWORKS } from "./core/network";
import { initServerLogging, createRequestLogger, createClientLogHandler, createLogger } from "./core/logger";
import { createHttpSecurityHeaders } from "./core/http-security";
import { openDatabase } from "./core/database";
import { createSessionLoader, requireAuth, requireCsrf } from "./core/auth";
import { timingSafeEqualString } from "./core/security";
import { createAuthRouter } from "./routes/auth-routes";
import { createProjectRouter } from "./routes/project-routes";
import { createFileRouter } from "./routes/file-routes";
import { createInstructionRouter } from "./routes/instruction-routes";
import { createGitRouter } from "./routes/git-routes";
import { createOperationsRouter } from "./routes/operations-routes";
import { createToolRouter } from "./routes/tool-routes";
import { prepareRuntimeFiles } from "./services/runtime-files";
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
  initServerLogging(config.dataDir);
  const log = createLogger("server");
  const database = openDatabase(config);
  const runtime = prepareRuntimeFiles(config);
  const app = express();
  if (config.trustedProxies?.length) app.set("trust proxy", config.trustedProxies);
  const server = http.createServer(app);
  const realtime = new RealtimeHub(server, database, config.publicUrl);
  const slack = new SlackNotifier(config, database);
  const ntfy = new NtfyNotifier(config, database);
  const fcm = new FcmNotifier(config, database);
  const mobileTrust = new MobileDeviceTrustService(database);
  // 각 서비스는 이 허브 하나만 알면 되고, Slack·ntfy 둘 다(또는 나중에 추가될 다른 채널도) 같이 알림이
  // 간다 — 채널별 세부 설정(토큰·topic)은 관리자 설정 API에서만 개별 SlackNotifier·NtfyNotifier로 다룬다.
  const notifications = new NotificationHub([slack, ntfy, fcm]);
  const approvals = new ApprovalService(config, database, realtime, notifications);
  const adapters = [new CodexAdapter(), new ClaudeAdapter(runtime.claudeSettingsFile, runtime.hookEnvironment), new GrokAdapter()];
  const accounts = new AgentAccountService(config, database);
  const sessions = new SessionManager(database, adapters, realtime, approvals, notifications, accounts);
  const historyCache = new HistoryCache();
  const tokenUsage = new TokenUsageLedger(database);
  const backups = new SessionBackupService(config, database, adapters, historyCache, tokenUsage);
  const history = new HistorySynchronizer(config, database, adapters, realtime, notifications, historyCache, approvals, accounts, tokenUsage);
  const usageResetNotifier = new UsageResetNotifier(database, notifications, realtime, adapters);
  const usage = new UsageMonitor(database, adapters, realtime, accounts, usageResetNotifier);
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
  const cliAuth = new CliAuthManager(config, realtime, accounts);
  const gitWorkspaces = new GitWorkspaceService(database, config);

  app.disable("x-powered-by");
  app.use(createHttpSecurityHeaders(config.publicUrl, process.env.NODE_ENV !== "production"));
  app.use(express.json({ limit: "2mb" }));
  app.use(createNetworkCapability(config.trustedNetworks?.length ? config.trustedNetworks : DEFAULT_TRUSTED_NETWORKS, Boolean(config.trustedProxies?.length)));
  app.use(createSessionLoader(database));
  app.use(createRequestLogger());
  app.get("/health", (_request, response) => response.json({ ok: true }));
  app.use("/api/auth", createAuthRouter(database, config));
  app.use("/api", createMobileTrustBootstrapRouter(database, config, mobileTrust));
  app.post("/internal/claude/permission", (request, response, next) => {
    if (!timingSafeEqualString(request.headers.authorization ?? "", `Bearer ${runtime.hookToken}`)) return response.status(401).json({ error: "내부 인증 실패" });
    void approvals.handleClaudeHook(request.body).then((result) => response.json(result)).catch(next);
  });
  app.use("/api", requireAuth, requireCsrf);
  app.post("/api/logs/client", createClientLogHandler());
  app.use("/api", createProjectRouter(database, config, sessions, adapters, accounts, historyCache, backups, gitWorkspaces));
  app.use("/api", createFileRouter(database, gitWorkspaces));
  app.use("/api", createInstructionRouter(database, gitWorkspaces));
  app.use("/api", createGitRouter(database, gitWorkspaces));
  app.use("/api", createToolRouter(database));
  app.use("/api", createAgentIntegrationRouter(database, agentIntegrations));
  app.use("/api", createCliAuthRouter(database, cliAuth));
  app.use("/api", createAgentAccountRouter(database, accounts, cliAuth, usage, sessions));
  app.use("/api", createAgentDelegationRouter(database, agentBridge));
  app.use("/api", createOperationsRouter(database, approvals, usage, metrics, slack, ntfy, adapters, idleChatReaper));
  app.use("/api", createMobileRouter(database, usage, metrics, fcm));
  app.use("/api", createMobileTrustRouter(database, mobileTrust));
  app.use("/api", createTokenUsageRouter(tokenUsage));
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
    log.error("API 오류 응답", { method: request.method, path: request.originalUrl, error });
    response.status(400).json({ error: message });
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

  // 종료 신호에서 앱 소유 자원만 닫고 tmux 채팅은 유지한다.
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (config.runtimeEnabled) usage.stop();
    if (config.runtimeEnabled) usageResetNotifier.stop();
    if (config.runtimeEnabled) rateLimitResume.stop();
    if (config.runtimeEnabled) idleChatReaper.stop();
    metrics.stop();
    history.stop();
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
