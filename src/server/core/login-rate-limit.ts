interface AccountAttemptState {
  failures: number;
  blockedUntil: number;
  auditedBlockUntil: number;
  lastSeenAt: number;
}

interface IpAttemptState {
  attempts: number;
  windowStartedAt: number;
  blockedUntil: number;
  auditedBlockUntil: number;
  lastSeenAt: number;
}

export interface LoginRateLimitOptions {
  accountFailureLimit: number;
  accountBaseBlockMs: number;
  accountMaxBlockMs: number;
  ipAttemptLimit: number;
  ipWindowMs: number;
  ipBlockMs: number;
  entryTtlMs: number;
  cleanupIntervalMs: number;
  maxEntries: number;
}

export interface LoginRateLimitDecision {
  allowed: boolean;
  retryAfterMs: number;
  scope?: "account" | "ip";
  shouldAudit: boolean;
}

export const DEFAULT_LOGIN_RATE_LIMIT_OPTIONS: LoginRateLimitOptions = {
  accountFailureLimit: 5,
  accountBaseBlockMs: 60_000,
  accountMaxBlockMs: 15 * 60_000,
  ipAttemptLimit: 30,
  ipWindowMs: 5 * 60_000,
  ipBlockMs: 15 * 60_000,
  entryTtlMs: 24 * 60 * 60_000,
  cleanupIntervalMs: 60_000,
  maxEntries: 10_000,
};

// 로그인 주소와 계정명을 메모리 사용량이 제한된 키로 정규화한다.
function attemptKey(ip: string, username: string): string {
  return `${ip.slice(0, 128)}:${username.toLowerCase().slice(0, 64)}`;
}

// 계정 실패 횟수에 따라 지수 증가하는 잠금 시간을 계산한다.
function accountBlockMs(failures: number, options: LoginRateLimitOptions): number {
  if (failures < options.accountFailureLimit) return 0;
  return Math.min(options.accountMaxBlockMs, options.accountBaseBlockMs * (2 ** (failures - options.accountFailureLimit)));
}

// 로그인 시도 상태를 IP 전체와 IP+계정 조합으로 제한하고 오래된 항목을 정리한다.
export class LoginRateLimiter {
  private readonly accounts = new Map<string, AccountAttemptState>();
  private readonly ips = new Map<string, IpAttemptState>();
  private lastCleanupAt = 0;

  constructor(private readonly options: LoginRateLimitOptions = DEFAULT_LOGIN_RATE_LIMIT_OPTIONS) {}

  // 비밀번호 검증 전에 IP 요청량과 기존 계정 잠금을 검사한다.
  begin(ip: string, username: string, now = Date.now()): LoginRateLimitDecision {
    this.cleanup(now);
    const ipKey = ip.slice(0, 128);
    let ipState = this.ips.get(ipKey);
    if (!ipState || (ipState.blockedUntil <= now && now - ipState.windowStartedAt >= this.options.ipWindowMs)) {
      ipState = { attempts: 0, windowStartedAt: now, blockedUntil: 0, auditedBlockUntil: 0, lastSeenAt: now };
    }
    ipState.lastSeenAt = now;
    if (ipState.blockedUntil > now) {
      this.setBounded(this.ips, ipKey, ipState);
      return this.blockedDecision(ipState, "ip", now);
    }
    ipState.attempts += 1;
    if (ipState.attempts > this.options.ipAttemptLimit) ipState.blockedUntil = now + this.options.ipBlockMs;
    this.setBounded(this.ips, ipKey, ipState);
    if (ipState.blockedUntil > now) return this.blockedDecision(ipState, "ip", now);

    const accountKey = attemptKey(ip, username);
    const accountState = this.accounts.get(accountKey);
    if (!accountState || accountState.blockedUntil <= now) return { allowed: true, retryAfterMs: 0, shouldAudit: false };
    accountState.lastSeenAt = now;
    this.setBounded(this.accounts, accountKey, accountState);
    return this.blockedDecision(accountState, "account", now);
  }

  // 실패한 계정 조합의 횟수와 다음 잠금 시각을 갱신한다.
  recordFailure(ip: string, username: string, now = Date.now()): { failures: number; blockedMs: number } {
    const key = attemptKey(ip, username);
    const current = this.accounts.get(key);
    const failures = (current?.failures ?? 0) + 1;
    const blockedMs = accountBlockMs(failures, this.options);
    this.setBounded(this.accounts, key, {
      failures,
      blockedUntil: blockedMs ? now + blockedMs : 0,
      auditedBlockUntil: current?.auditedBlockUntil ?? 0,
      lastSeenAt: now,
    });
    return { failures, blockedMs };
  }

  // 성공한 IP+계정 조합의 실패 기록만 초기화하고 IP 전체 창은 유지한다.
  resetAccount(ip: string, username: string): void {
    this.accounts.delete(attemptKey(ip, username));
  }

  // 테스트와 운영 진단에서 현재 메모리 항목 수를 확인한다.
  sizes(): { accounts: number; ips: number } {
    return { accounts: this.accounts.size, ips: this.ips.size };
  }

  // 같은 잠금 구간의 감사 이벤트를 한 번만 허용하는 차단 결정을 만든다.
  private blockedDecision(
    state: Pick<AccountAttemptState, "blockedUntil" | "auditedBlockUntil">,
    scope: "account" | "ip",
    now: number,
  ): LoginRateLimitDecision {
    const shouldAudit = state.auditedBlockUntil !== state.blockedUntil;
    if (shouldAudit) state.auditedBlockUntil = state.blockedUntil;
    return { allowed: false, retryAfterMs: Math.max(1, state.blockedUntil - now), scope, shouldAudit };
  }

  // 오래된 상태를 주기적으로 지우고 공격 중에도 맵 크기를 상한 이내로 유지한다.
  private cleanup(now: number): void {
    if (now - this.lastCleanupAt < this.options.cleanupIntervalMs
      && this.accounts.size <= this.options.maxEntries
      && this.ips.size <= this.options.maxEntries) return;
    this.lastCleanupAt = now;
    for (const [key, state] of this.accounts) {
      if (state.blockedUntil <= now && now - state.lastSeenAt >= this.options.entryTtlMs) this.accounts.delete(key);
    }
    for (const [key, state] of this.ips) {
      if (state.blockedUntil <= now && now - state.lastSeenAt >= this.options.entryTtlMs) this.ips.delete(key);
    }
    this.trimOldest(this.accounts);
    this.trimOldest(this.ips);
  }

  // 값을 최신 삽입 순서로 옮긴 뒤 초과한 오래된 항목을 제거한다.
  private setBounded<T>(map: Map<string, T>, key: string, value: T): void {
    map.delete(key);
    map.set(key, value);
    this.trimOldest(map);
  }

  // Map 삽입 순서상 가장 오래된 항목부터 최대 크기까지 줄인다.
  private trimOldest<T>(map: Map<string, T>): void {
    while (map.size > this.options.maxEntries) {
      const oldest = map.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      map.delete(oldest);
    }
  }
}
