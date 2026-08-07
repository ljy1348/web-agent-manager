import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { isSameOrigin } from "../src/server/services/realtime";

// Origin 검사용 최소 HTTP upgrade 요청 객체를 만든다.
function request(origin: string | undefined, host: string, encrypted = false, forwardedProto?: string): IncomingMessage {
  return { headers: { origin, host, "x-forwarded-proto": forwardedProto }, socket: { encrypted } } as unknown as IncomingMessage;
}

describe("WebSocket Origin 검증", () => {
  it("호스트와 프로토콜이 모두 같은 요청만 허용한다", () => {
    expect(isSameOrigin(request("http://example.com", "example.com"))).toBe(true);
    expect(isSameOrigin(request("https://example.com", "example.com"))).toBe(false);
    expect(isSameOrigin(request("https://other.example", "example.com", true))).toBe(false);
    expect(isSameOrigin(request("https://example.com", "example.com", true))).toBe(true);
  });

  it("HTTPS reverse proxy는 일치하는 publicUrl 프로토콜을 기준으로 검사한다", () => {
    const proxied = request("https://example.com", "example.com");
    expect(isSameOrigin(proxied, "https://example.com")).toBe(true);
    expect(isSameOrigin(request("http://example.com", "example.com"), "https://example.com")).toBe(false);
  });

  it("여러 외부 Host를 쓰는 reverse proxy는 전달된 실제 프로토콜로 검사한다", () => {
    expect(isSameOrigin(request("https://agent.example.com", "agent.example.com", false, "https"))).toBe(true);
    expect(isSameOrigin(request("https://agent.example.com", "agent.example.com", false, "https, http"))).toBe(true);
    expect(isSameOrigin(request("https://agent.example.com", "agent.example.com", false, "ftp"))).toBe(false);
    expect(isSameOrigin(request("https://other.example.com", "agent.example.com", false, "https"))).toBe(false);
  });

  it("브라우저가 아닌 클라이언트의 Origin 없는 요청은 세션 인증 단계로 넘긴다", () => {
    expect(isSameOrigin(request(undefined, "example.com"))).toBe(true);
  });
});
