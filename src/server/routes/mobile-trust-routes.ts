import { Router, type Response } from "express";
import type { AppConfig } from "../core/config";
import type { AppDatabase } from "../core/database";
import { createWebSession, requireAdmin, setWebSessionCookie, type AuthenticatedRequest } from "../core/auth";
import { writeAudit } from "../core/audit";
import { LoginRateLimiter, type LoginRateLimitDecision } from "../core/login-rate-limit";
import type { MobileDeviceTrustService } from "../services/mobile-device-trust";

// 무인증 기기 로그인 제한에 사용할 클라이언트 주소를 고정 길이로 정규화한다.
function trustClientAddress(request: AuthenticatedRequest): string {
  return (request.ip || request.socket.remoteAddress || "unknown").slice(0, 128);
}

// 차단된 기기 로그인 요청에 재시도 시각과 중복 억제 감사 기록을 남긴다.
function rejectTrustRateLimit(database: AppDatabase, response: Response, deviceId: string, decision: LoginRateLimitDecision): void {
  if (decision.shouldAudit) {
    writeAudit(database, null, "mobile.trust.session.rate_limited", "mobile_trusted_device", deviceId.slice(0, 120) || "<invalid>", {
      retryAfterMs: decision.retryAfterMs,
      scope: decision.scope,
    });
  }
  response.setHeader("Retry-After", String(Math.ceil(decision.retryAfterMs / 1_000)));
  response.status(429).json({ error: "앱 기기 로그인 요청이 너무 많습니다. 잠시 후 다시 시도해주세요." });
}

// 실제 소켓·전달 프로토콜·대표 URL과 Host를 WebSocket과 같은 규칙의 정규 origin으로 고정한다.
function requestOrigin(request: AuthenticatedRequest, config: AppConfig): string {
  const host = request.get("host");
  if (!host) throw new Error("앱 기기 로그인 Host가 없습니다.");
  let protocol = (request.socket as typeof request.socket & { encrypted?: boolean }).encrypted ? "https" : "http";
  const forwardedProtocol = String(request.headers["x-forwarded-proto"] ?? "").split(",", 1)[0].trim().toLowerCase();
  if (["http", "https"].includes(forwardedProtocol)) protocol = forwardedProtocol;
  try {
    const configured = new URL(config.publicUrl);
    if (configured.host === host) protocol = configured.protocol.replace(":", "");
  } catch {
    // 대표 URL이 비어 있거나 잘못됐으면 실제 요청 프로토콜 판정만 사용한다.
  }
  return new URL(`${protocol}://${host}`).origin;
}

// 로그인 쿠키가 없는 새 앱 origin에 기기 서명으로 신뢰 웹 세션을 발급한다.
export function createMobileTrustBootstrapRouter(database: AppDatabase, config: AppConfig, trust: MobileDeviceTrustService, rateLimiter = new LoginRateLimiter()): Router {
  const router = Router();
  router.post("/mobile/trust/session/challenge", (request, response, next) => {
    const deviceId = typeof request.body?.deviceId === "string" ? request.body.deviceId : "";
    const clientAddress = trustClientAddress(request as AuthenticatedRequest);
    const limit = rateLimiter.begin(clientAddress, deviceId || "<invalid>");
    if (!limit.allowed) {
      rejectTrustRateLimit(database, response, deviceId, limit);
      return;
    }
    try {
      const publicKey = typeof request.body?.publicKey === "string" ? request.body.publicKey : "";
      const challenge = trust.createLoginChallenge(deviceId, publicKey, requestOrigin(request as AuthenticatedRequest, config));
      rateLimiter.resetAccount(clientAddress, deviceId || "<invalid>");
      response.json({ challenge });
    } catch (error) {
      rateLimiter.recordFailure(clientAddress, deviceId || "<invalid>");
      next(error);
    }
  });
  router.post("/mobile/trust/session/activate", (request, response) => {
    const deviceId = typeof request.body?.deviceId === "string" ? request.body.deviceId : "";
    const clientAddress = trustClientAddress(request as AuthenticatedRequest);
    const limit = rateLimiter.begin(clientAddress, deviceId || "<invalid>");
    if (!limit.allowed) {
      rejectTrustRateLimit(database, response, deviceId, limit);
      return;
    }
    const challenge = typeof request.body?.challenge === "string" ? request.body.challenge : "";
    const signature = typeof request.body?.signature === "string" ? request.body.signature : "";
    const identity = trust.consumeLoginChallenge(deviceId, challenge, signature);
    if (!identity) {
      rateLimiter.recordFailure(clientAddress, deviceId || "<invalid>");
      return response.status(403).json({ error: "앱 기기 로그인 서명 인증에 실패했습니다." });
    }
    rateLimiter.resetAccount(clientAddress, deviceId || "<invalid>");
    const session = createWebSession(database, config, identity.userId, identity.deviceId);
    if (!session) return response.status(403).json({ error: "앱 기기 로그인 계정을 찾을 수 없습니다." });
    setWebSessionCookie(response, config, session.token);
    writeAudit(database, identity.userId, "mobile.trust.session", "mobile_trusted_device", identity.deviceId, {});
    response.json({ user: session.user, csrfToken: session.csrfToken, networkTrusted: true });
  });
  return router;
}

// Android 기기 등록·challenge 발급·현재 웹 세션 서명 인증 API를 구성한다.
export function createMobileTrustRouter(database: AppDatabase, trust: MobileDeviceTrustService): Router {
  const router = Router();
  router.get("/mobile/trust", requireAdmin, (request: AuthenticatedRequest, response) => {
    const deviceId = typeof request.query.deviceId === "string" ? request.query.deviceId : "";
    response.json(trust.status(request.authUser!.id, request.authSession!.id, deviceId));
  });
  router.post("/mobile/trust/resolve", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      const publicKey = typeof request.body?.publicKey === "string" ? request.body.publicKey : "";
      response.json(trust.resolve(request.authUser!.id, request.authSession!.id, publicKey));
    } catch (error) {
      next(error);
    }
  });
  router.post("/mobile/trust/enroll", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      if (request.networkOriginTrusted !== true) return response.status(403).json({ error: "앱 기기 최초 인증은 내부망에서만 가능합니다." });
      const publicKey = typeof request.body?.publicKey === "string" ? request.body.publicKey : "";
      const label = typeof request.body?.label === "string" ? request.body.label : undefined;
      const result = trust.enroll(request.authUser!.id, publicKey, label);
      writeAudit(database, request.authUser!.id, "mobile.trust.enroll", "mobile_trusted_device", result.deviceId, { label: label?.slice(0, 120) ?? null });
      response.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });
  router.post("/mobile/trust/challenge", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      const deviceId = typeof request.body?.deviceId === "string" ? request.body.deviceId : "";
      response.json({ challenge: trust.createChallenge(request.authUser!.id, request.authSession!.id, deviceId) });
    } catch (error) {
      next(error);
    }
  });
  router.post("/mobile/trust/activate", requireAdmin, (request: AuthenticatedRequest, response) => {
    const deviceId = typeof request.body?.deviceId === "string" ? request.body.deviceId : "";
    const challenge = typeof request.body?.challenge === "string" ? request.body.challenge : "";
    const signature = typeof request.body?.signature === "string" ? request.body.signature : "";
    if (!trust.activate(request.authUser!.id, request.authSession!.id, deviceId, challenge, signature)) {
      return response.status(403).json({ error: "앱 기기 서명 인증에 실패했습니다." });
    }
    request.appTrusted = true;
    request.trustedNetwork = true;
    writeAudit(database, request.authUser!.id, "mobile.trust.activate", "mobile_trusted_device", deviceId, {});
    response.json({ trusted: true });
  });
  router.delete("/mobile/trust", requireAdmin, (request: AuthenticatedRequest, response) => {
    const deviceId = typeof request.body?.deviceId === "string" ? request.body.deviceId : "";
    if (!trust.revoke(request.authUser!.id, deviceId)) return response.status(404).json({ error: "등록된 앱 기기를 찾을 수 없습니다." });
    request.appTrusted = false;
    request.trustedNetwork = request.networkOriginTrusted === true;
    writeAudit(database, request.authUser!.id, "mobile.trust.revoke", "mobile_trusted_device", deviceId, {});
    response.status(204).end();
  });
  return router;
}
