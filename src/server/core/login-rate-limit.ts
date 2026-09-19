import type { AppDatabase } from "./database";
import { hashToken } from "./security";

interface AccountAttemptState { failures: number; blockedUntil: number; auditedBlockUntil: number; lastSeenAt: number }
interface IpAttemptState { attempts: number; windowStartedAt: number; blockedUntil: number; auditedBlockUntil: number; lastSeenAt: number }

export interface LoginRateLimitOptions {
  accountFailureLimit: number; accountBaseBlockMs: number; accountMaxBlockMs: number;
  ipAttemptLimit: number; ipWindowMs: number; ipBlockMs: number;
  entryTtlMs: number; cleanupIntervalMs: number; maxEntries: number;
}
export interface LoginRateLimitDecision { allowed: boolean; retryAfterMs: number; scope?: "account" | "ip"; shouldAudit: boolean }

export const DEFAULT_LOGIN_RATE_LIMIT_OPTIONS: LoginRateLimitOptions = {
  accountFailureLimit: 5, accountBaseBlockMs: 60_000, accountMaxBlockMs: 15 * 60_000,
  ipAttemptLimit: 30, ipWindowMs: 5 * 60_000, ipBlockMs: 15 * 60_000,
  entryTtlMs: 24 * 60 * 60_000, cleanupIntervalMs: 60_000, maxEntries: 10_000,
};

function accountBlockMs(failures: number, options: LoginRateLimitOptions): number {
  if (failures < options.accountFailureLimit) return 0;
  return Math.min(options.accountMaxBlockMs, options.accountBaseBlockMs * (2 ** (failures - options.accountFailureLimit)));
}

// IP와 계정 원문은 저장하지 않고 각각 독립 SHA-256 bucket으로 관리한다. DB가 주어지면 모든 변경을
// 즉시 upsert해 프로세스 재시작 뒤에도 잠금과 감사 중복 방지 상태가 유지된다.
export class LoginRateLimiter {
  private readonly accounts = new Map<string, AccountAttemptState>();
  private readonly ips = new Map<string, IpAttemptState>();
  private readonly options: LoginRateLimitOptions;
  private readonly database?: AppDatabase;
  private lastCleanupAt = 0;

  constructor(optionsOrDatabase: LoginRateLimitOptions | AppDatabase = DEFAULT_LOGIN_RATE_LIMIT_OPTIONS, database?: AppDatabase) {
    if ("prepare" in optionsOrDatabase) {
      this.options = DEFAULT_LOGIN_RATE_LIMIT_OPTIONS;
      this.database = optionsOrDatabase;
    } else {
      this.options = optionsOrDatabase;
      this.database = database;
    }
    if (this.database) this.hydrate();
  }

  begin(ip: string, username: string, now = Date.now()): LoginRateLimitDecision {
    this.cleanup(now);
    const ipKey = hashToken(ip.slice(0, 128));
    let ipState = this.ips.get(ipKey);
    if (!ipState || (ipState.blockedUntil <= now && now - ipState.windowStartedAt >= this.options.ipWindowMs)) {
      ipState = { attempts: 0, windowStartedAt: now, blockedUntil: 0, auditedBlockUntil: 0, lastSeenAt: now };
    }
    ipState.lastSeenAt = now;
    if (ipState.blockedUntil > now) {
      this.setIp(ipKey, ipState);
      return this.blockedDecision(ipState, "ip", now, () => this.setIp(ipKey, ipState!));
    }
    ipState.attempts += 1;
    if (ipState.attempts > this.options.ipAttemptLimit) ipState.blockedUntil = now + this.options.ipBlockMs;
    this.setIp(ipKey, ipState);
    if (ipState.blockedUntil > now) return this.blockedDecision(ipState, "ip", now, () => this.setIp(ipKey, ipState!));

    const accountKey = hashToken(username.toLowerCase().slice(0, 64));
    const accountState = this.accounts.get(accountKey);
    if (!accountState || accountState.blockedUntil <= now) return { allowed: true, retryAfterMs: 0, shouldAudit: false };
    accountState.lastSeenAt = now;
    this.setAccount(accountKey, accountState);
    return this.blockedDecision(accountState, "account", now, () => this.setAccount(accountKey, accountState));
  }

  recordFailure(_ip: string, username: string, now = Date.now()): { failures: number; blockedMs: number } {
    const key = hashToken(username.toLowerCase().slice(0, 64));
    const current = this.accounts.get(key);
    const failures = (current?.failures ?? 0) + 1;
    const blockedMs = accountBlockMs(failures, this.options);
    this.setAccount(key, { failures, blockedUntil: blockedMs ? now + blockedMs : 0, auditedBlockUntil: current?.auditedBlockUntil ?? 0, lastSeenAt: now });
    return { failures, blockedMs };
  }

  resetAccount(_ip: string, username: string): void {
    const key = hashToken(username.toLowerCase().slice(0, 64));
    this.accounts.delete(key);
    this.database?.prepare("DELETE FROM login_rate_limit_buckets WHERE scope = 'account' AND key_hash = ?").run(key);
  }

  sizes(): { accounts: number; ips: number } { return { accounts: this.accounts.size, ips: this.ips.size }; }

  private hydrate(): void {
    const rows = this.database!.prepare("SELECT * FROM login_rate_limit_buckets ORDER BY last_seen_at_ms").all() as Array<Record<string, number | string>>;
    for (const row of rows) {
      if (row.scope === "account") this.accounts.set(String(row.key_hash), { failures: Number(row.failures), blockedUntil: Number(row.blocked_until_ms), auditedBlockUntil: Number(row.audited_block_until_ms), lastSeenAt: Number(row.last_seen_at_ms) });
      else this.ips.set(String(row.key_hash), { attempts: Number(row.attempts), windowStartedAt: Number(row.window_started_at_ms), blockedUntil: Number(row.blocked_until_ms), auditedBlockUntil: Number(row.audited_block_until_ms), lastSeenAt: Number(row.last_seen_at_ms) });
    }
    this.trimOldest(this.accounts, "account"); this.trimOldest(this.ips, "ip");
  }

  private blockedDecision(state: { blockedUntil: number; auditedBlockUntil: number }, scope: "account" | "ip", now: number, persist: () => void): LoginRateLimitDecision {
    const shouldAudit = state.auditedBlockUntil !== state.blockedUntil;
    if (shouldAudit) { state.auditedBlockUntil = state.blockedUntil; persist(); }
    return { allowed: false, retryAfterMs: Math.max(1, state.blockedUntil - now), scope, shouldAudit };
  }

  private setAccount(key: string, state: AccountAttemptState): void {
    this.accounts.delete(key); this.accounts.set(key, state);
    this.database?.prepare(`INSERT INTO login_rate_limit_buckets(scope,key_hash,failures,last_seen_at_ms,blocked_until_ms,audited_block_until_ms)
      VALUES ('account',?,?,?,?,?) ON CONFLICT(scope,key_hash) DO UPDATE SET failures=excluded.failures,last_seen_at_ms=excluded.last_seen_at_ms,blocked_until_ms=excluded.blocked_until_ms,audited_block_until_ms=excluded.audited_block_until_ms`)
      .run(key, state.failures, state.lastSeenAt, state.blockedUntil, state.auditedBlockUntil);
    this.trimOldest(this.accounts, "account");
  }

  private setIp(key: string, state: IpAttemptState): void {
    this.ips.delete(key); this.ips.set(key, state);
    this.database?.prepare(`INSERT INTO login_rate_limit_buckets(scope,key_hash,attempts,window_started_at_ms,last_seen_at_ms,blocked_until_ms,audited_block_until_ms)
      VALUES ('ip',?,?,?,?,?,?) ON CONFLICT(scope,key_hash) DO UPDATE SET attempts=excluded.attempts,window_started_at_ms=excluded.window_started_at_ms,last_seen_at_ms=excluded.last_seen_at_ms,blocked_until_ms=excluded.blocked_until_ms,audited_block_until_ms=excluded.audited_block_until_ms`)
      .run(key, state.attempts, state.windowStartedAt, state.lastSeenAt, state.blockedUntil, state.auditedBlockUntil);
    this.trimOldest(this.ips, "ip");
  }

  private cleanup(now: number): void {
    if (now - this.lastCleanupAt < this.options.cleanupIntervalMs && this.accounts.size <= this.options.maxEntries && this.ips.size <= this.options.maxEntries) return;
    this.lastCleanupAt = now;
    for (const [key, state] of this.accounts) if (state.blockedUntil <= now && now - state.lastSeenAt >= this.options.entryTtlMs) { this.accounts.delete(key); this.database?.prepare("DELETE FROM login_rate_limit_buckets WHERE scope='account' AND key_hash=?").run(key); }
    for (const [key, state] of this.ips) if (state.blockedUntil <= now && now - state.lastSeenAt >= this.options.entryTtlMs) { this.ips.delete(key); this.database?.prepare("DELETE FROM login_rate_limit_buckets WHERE scope='ip' AND key_hash=?").run(key); }
  }

  private trimOldest<T>(map: Map<string, T>, scope: "account" | "ip"): void {
    while (map.size > this.options.maxEntries) {
      const oldest = map.keys().next().value as string | undefined;
      if (!oldest) return;
      map.delete(oldest);
      this.database?.prepare("DELETE FROM login_rate_limit_buckets WHERE scope = ? AND key_hash = ?").run(scope, oldest);
    }
  }
}
