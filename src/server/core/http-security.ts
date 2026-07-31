import type { RequestHandler } from "express";

const CONTENT_SECURITY_POLICY_DIRECTIVES = [
  "default-src 'self'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "form-action 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "frame-src 'self'",
  "worker-src 'self' blob:",
];

// HTML·API 응답에 공통 브라우저 보안 헤더를 적용하고 HTTPS 배포에만 HSTS를 추가한다.
export function createHttpSecurityHeaders(publicUrl: string, development = false): RequestHandler {
  const useHsts = publicUrl.startsWith("https://");
  const scriptPolicy = development ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'";
  const contentSecurityPolicy = [...CONTENT_SECURITY_POLICY_DIRECTIVES, scriptPolicy].join("; ");
  return (_request, response, next) => {
    response.setHeader("Content-Security-Policy", contentSecurityPolicy);
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    if (useHsts) response.setHeader("Strict-Transport-Security", "max-age=31536000");
    next();
  };
}
