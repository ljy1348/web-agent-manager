import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Router } from "express";
import type { AppDatabase } from "../core/database";
import { requireAdmin, type AuthenticatedRequest } from "../core/auth";
import { requireTrustedNetwork } from "../core/network";
import type { ApprovalService } from "../services/approval";
import type { UsageMonitor } from "../services/usage-monitor";
import type { SystemMetricsService } from "../services/system-metrics";
import type { SlackNotifier } from "../services/slack";
import type { NtfyNotifier } from "../services/ntfy";
import type { Provider } from "../../shared/types";
import { writeAudit } from "../core/audit";
import type { IdleChatReaper } from "../services/idle-chat-reaper";
import type { ProviderAdapter } from "../providers/provider";

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
): Router {
  const router = Router();
  const adapterById = new Map(adapters.map((adapter) => [adapter.id, adapter]));
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
      supportsPermissionMode: !!adapter.detectPermissionMode,
    })) });
  });
  router.get("/approvals", (_request, response) => {
    const rows = database.prepare(`
      SELECT a.*, c.title AS chat_title FROM approvals a JOIN chats c ON c.id = a.chat_id
      ORDER BY CASE WHEN a.status = 'pending' THEN 0 ELSE 1 END, a.created_at DESC LIMIT 200
    `).all();
    response.json({ approvals: rows });
  });
  router.post("/approvals/:id/decision", (request: AuthenticatedRequest, response, next) => {
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
  router.post("/usage/:provider/refresh", (request, response, next) => {
    try {
      const provider = getProvider(request.params.provider);
      usage.refresh(provider);
      response.status(202).json({ accepted: true });
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
  router.post("/models/:provider/refresh", async (request, response, next) => {
    try {
      const provider = getProvider(request.params.provider);
      response.json({ options: await usage.modelOptions(provider) });
    } catch (error) {
      next(error);
    }
  });
  router.get("/system", (_request, response) => response.json(metrics.snapshot()));
  // 대시보드 프로세스 표에서 관리자가 직접 종료(SIGTERM)·강제 종료(SIGKILL)할 수 있게 한다.
  // 서버 자기 자신과 init(pid 1)은 실수로 앱 전체가 죽는 것을 막기 위해 항상 거부한다.
  router.post("/system/processes/:pid/kill", requireAdmin, requireTrustedNetwork, (request: AuthenticatedRequest, response, next) => {
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
