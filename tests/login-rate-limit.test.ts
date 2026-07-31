import { describe, expect, it } from "vitest";
import { DEFAULT_LOGIN_RATE_LIMIT_OPTIONS, LoginRateLimiter, type LoginRateLimitOptions } from "../src/server/core/login-rate-limit";

// 기본값 일부만 바꾼 로그인 제한 테스트 옵션을 만든다.
function options(overrides: Partial<LoginRateLimitOptions> = {}): LoginRateLimitOptions {
  return { ...DEFAULT_LOGIN_RATE_LIMIT_OPTIONS, ...overrides };
}

describe("로그인 요청 제한", () => {
  it("계정별 연속 실패를 잠그고 같은 잠금 감사 이벤트는 한 번만 허용한다", () => {
    const limiter = new LoginRateLimiter(options({ accountFailureLimit: 2 }));
    expect(limiter.begin("127.0.0.1", "admin", 1).allowed).toBe(true);
    limiter.recordFailure("127.0.0.1", "admin", 1);
    expect(limiter.begin("127.0.0.1", "admin", 2).allowed).toBe(true);
    limiter.recordFailure("127.0.0.1", "admin", 2);

    const blocked = limiter.begin("127.0.0.1", "admin", 3);
    const repeated = limiter.begin("127.0.0.1", "admin", 4);
    expect(blocked).toMatchObject({ allowed: false, scope: "account", shouldAudit: true });
    expect(repeated).toMatchObject({ allowed: false, scope: "account", shouldAudit: false });
  });

  it("계정명을 바꿔도 IP 전체 요청 창을 초과하면 비밀번호 검증 전에 차단한다", () => {
    const limiter = new LoginRateLimiter(options({ ipAttemptLimit: 3 }));
    expect(limiter.begin("192.0.2.10", "one", 1).allowed).toBe(true);
    expect(limiter.begin("192.0.2.10", "two", 2).allowed).toBe(true);
    expect(limiter.begin("192.0.2.10", "three", 3).allowed).toBe(true);
    expect(limiter.begin("192.0.2.10", "four", 4)).toMatchObject({ allowed: false, scope: "ip", shouldAudit: true });
    expect(limiter.begin("192.0.2.10", "five", 5)).toMatchObject({ allowed: false, scope: "ip", shouldAudit: false });
  });

  it("공격자가 IP와 계정명을 계속 바꿔도 메모리 항목 상한을 넘지 않는다", () => {
    const limiter = new LoginRateLimiter(options({ maxEntries: 2, ipAttemptLimit: 100 }));
    for (let index = 0; index < 6; index += 1) {
      const ip = `192.0.2.${index}`;
      limiter.begin(ip, `user-${index}`, index + 1);
      limiter.recordFailure(ip, `user-${index}`, index + 1);
    }
    expect(limiter.sizes()).toEqual({ accounts: 2, ips: 2 });
  });

  it("TTL이 지난 잠금 해제 상태를 다음 정리 주기에 제거한다", () => {
    const limiter = new LoginRateLimiter(options({ entryTtlMs: 10, cleanupIntervalMs: 1, ipAttemptLimit: 100 }));
    limiter.begin("192.0.2.1", "old", 1);
    limiter.recordFailure("192.0.2.1", "old", 1);
    limiter.begin("192.0.2.2", "new", 20);
    expect(limiter.sizes()).toEqual({ accounts: 0, ips: 1 });
  });
});
