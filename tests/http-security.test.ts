import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpSecurityHeaders } from "../src/server/core/http-security";

let closeServer: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
});

// 보안 헤더 미들웨어를 실제 HTTP 서버에서 호출할 URL로 만든다.
async function serve(publicUrl: string, development = false): Promise<string> {
  const app = express();
  app.use(createHttpSecurityHeaders(publicUrl, development));
  app.get("/", (_request, response) => response.send("ok"));
  app.get("/preview", (_request, response) => {
    response.setHeader("X-Frame-Options", "SAMEORIGIN");
    response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'self'");
    response.send("preview");
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  closeServer = () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("HTTP 보안 헤더", () => {
  it("공통 CSP와 프레임·MIME·권한 제한을 적용한다", async () => {
    const response = await fetch(await serve("http://127.0.0.1"));
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("permissions-policy")).toContain("camera=()");
    expect(response.headers.get("strict-transport-security")).toBeNull();
    expect(response.headers.get("content-security-policy")).not.toContain("script-src 'self' 'unsafe-inline'");
  });

  it("HTTPS 공개 주소에서만 HSTS를 적용한다", async () => {
    const response = await fetch(await serve("https://example.com"));
    expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000");
  });

  it("검증된 같은 출처 미리보기는 라우트의 더 구체적인 프레임 정책을 유지한다", async () => {
    const baseUrl = await serve("http://127.0.0.1");
    const response = await fetch(`${baseUrl}/preview`);
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
  });

  it("개발 모드에서만 Vite React Refresh 인라인 모듈을 허용한다", async () => {
    const response = await fetch(await serve("http://127.0.0.1", true));
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self' 'unsafe-inline'");
  });
});
