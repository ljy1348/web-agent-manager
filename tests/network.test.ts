import { describe, expect, it } from "vitest";
import type { Response } from "express";
import { DEFAULT_TRUSTED_NETWORKS, createNetworkCapability, isTrustedNetworkAddress, parseCidrs } from "../src/server/core/network";
import type { AuthenticatedRequest } from "../src/server/core/auth";

// 프록시 주소로 들어온 요청을 흉내 내 내부망 capability만 확인한다.
function judge(headers: Record<string, string>, trustProxyConfigured = false, ip = "127.0.0.1"): boolean {
  const middleware = createNetworkCapability(DEFAULT_TRUSTED_NETWORKS, trustProxyConfigured);
  const request = { headers, ip, socket: { remoteAddress: ip } } as unknown as AuthenticatedRequest;
  middleware(request, {} as Response, () => undefined);
  return request.trustedNetwork === true;
}

describe("신뢰 네트워크 판정", () => {
  it("로컬·사설망·CGNAT·IPv6 로컬 주소만 기본 내부망으로 판정한다", () => {
    expect(isTrustedNetworkAddress("127.0.0.1", DEFAULT_TRUSTED_NETWORKS)).toBe(true);
    expect(isTrustedNetworkAddress("192.168.10.2", DEFAULT_TRUSTED_NETWORKS)).toBe(true);
    expect(isTrustedNetworkAddress("100.64.0.1", DEFAULT_TRUSTED_NETWORKS)).toBe(true);
    expect(isTrustedNetworkAddress("100.127.255.254", DEFAULT_TRUSTED_NETWORKS)).toBe(true);
    expect(isTrustedNetworkAddress("::ffff:10.0.0.3", DEFAULT_TRUSTED_NETWORKS)).toBe(true);
    expect(isTrustedNetworkAddress("fd00::1", DEFAULT_TRUSTED_NETWORKS)).toBe(true);
    expect(isTrustedNetworkAddress("100.63.255.255", DEFAULT_TRUSTED_NETWORKS)).toBe(false);
    expect(isTrustedNetworkAddress("100.128.0.1", DEFAULT_TRUSTED_NETWORKS)).toBe(false);
    expect(isTrustedNetworkAddress("8.8.8.8", DEFAULT_TRUSTED_NETWORKS)).toBe(false);
  });

  it("사용자 CIDR 목록을 파싱하고 잘못된 설정을 판정 시 거부한다", () => {
    expect(parseCidrs(" 192.0.2.0/24,10.1.0.0/16 ")).toEqual(["192.0.2.0/24", "10.1.0.0/16"]);
    expect(parseCidrs(undefined, ["127.0.0.0/8"])).toEqual(["127.0.0.0/8"]);
    expect(() => isTrustedNetworkAddress("127.0.0.1", ["잘못된-CIDR"])).toThrow("유효하지 않은 네트워크 주소");
  });

  it("신뢰 프록시를 지정하지 않으면 프록시 경유 요청을 내부망으로 보지 않는다", () => {
    // reverse proxy 뒤에서는 socket 주소가 항상 로컬이라, 이 판정이 없으면 외부 도메인 접속이 전부 내부망이 된다.
    expect(judge({})).toBe(true);
    expect(judge({ "x-forwarded-for": "203.0.113.9" })).toBe(false);
    expect(judge({ "cf-connecting-ip": "203.0.113.9" })).toBe(false);
    expect(judge({ forwarded: "for=203.0.113.9" })).toBe(false);
    expect(judge({ "x-real-ip": "203.0.113.9" })).toBe(false);
  });

  it("신뢰 프록시를 지정하면 프록시가 전달한 실제 클라이언트 주소로 판정한다", () => {
    expect(judge({ "x-forwarded-for": "203.0.113.9" }, true, "192.168.0.31")).toBe(true);
    expect(judge({ "x-forwarded-for": "192.168.0.31" }, true, "203.0.113.9")).toBe(false);
  });
});
