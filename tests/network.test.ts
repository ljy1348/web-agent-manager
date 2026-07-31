import { describe, expect, it } from "vitest";
import { DEFAULT_TRUSTED_NETWORKS, isTrustedNetworkAddress, parseCidrs } from "../src/server/core/network";

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
});
