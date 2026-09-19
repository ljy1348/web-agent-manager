import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppDatabase } from "./database";
import { createToken, hashToken, timingSafeEqualString } from "./security";

const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
const SETUP_TTL_MINUTES = 10;
const LOGIN_CHALLENGE_TTL_MINUTES = 5;
const LOGIN_CHALLENGE_MAX_ATTEMPTS = 5;
const RECOVERY_CODE_COUNT = 10;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(value: Buffer): string {
  let bits = 0; let accumulator = 0; let encoded = "";
  for (const byte of value) {
    accumulator = (accumulator << 8) | byte; bits += 8;
    while (bits >= 5) { encoded += BASE32_ALPHABET[(accumulator >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) encoded += BASE32_ALPHABET[(accumulator << (5 - bits)) & 31];
  return encoded;
}

function base32Decode(value: string): Buffer {
  let bits = 0; let accumulator = 0; const bytes: number[] = [];
  for (const character of value.toUpperCase().replace(/=+$/, "")) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw new Error("TOTP 비밀 형식이 올바르지 않습니다.");
    accumulator = (accumulator << 5) | index; bits += 5;
    if (bits >= 8) { bytes.push((accumulator >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}

export function totpCode(secret: string, now = Date.now()): { code: string; step: number } {
  const step = Math.floor(now / (TOTP_PERIOD_SECONDS * 1000));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = crypto.createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return { code: String(binary % (10 ** TOTP_DIGITS)).padStart(TOTP_DIGITS, "0"), step };
}

function matchingTotpStep(secret: string, code: string, now: number): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  for (const offset of [-1, 0, 1]) {
    const generated = totpCode(secret, now + offset * TOTP_PERIOD_SECONDS * 1000);
    if (timingSafeEqualString(generated.code, code)) return generated.step;
  }
  return null;
}

function normalizeRecoveryCode(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function recoveryCode(): string {
  const raw = base32Encode(crypto.randomBytes(8)).slice(0, 12);
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

interface MfaRow {
  encrypted_secret: string;
  nonce: string;
  auth_tag: string;
  last_used_step: number | null;
  enabled_at: string | null;
}

export class MfaService {
  private readonly keyPath: string;

  constructor(private readonly database: AppDatabase, dataDir: string) {
    this.keyPath = path.join(dataDir, "secrets", "mfa-master.key");
    const existing = this.database.prepare("SELECT user_id, encrypted_secret, nonce, auth_tag FROM user_mfa LIMIT 1").get() as ({ user_id: number } & Pick<MfaRow, "encrypted_secret" | "nonce" | "auth_tag">) | undefined;
    // 등록 데이터가 있는데 key가 없거나 다른 key라면 로그인 뒤 500을 내는 대신 기동 시 드러낸다.
    if (existing) this.decrypt(existing.user_id, existing);
  }

  enabled(userId: number): boolean {
    return !!this.database.prepare("SELECT 1 FROM user_mfa WHERE user_id = ? AND enabled_at IS NOT NULL").get(userId);
  }

  status(userId: number): { enabled: boolean; recoveryCodesRemaining: number } {
    const enabled = this.enabled(userId);
    const remaining = enabled ? (this.database.prepare("SELECT COUNT(*) AS count FROM user_mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL").get(userId) as { count: number }).count : 0;
    return { enabled, recoveryCodesRemaining: remaining };
  }

  beginSetup(userId: number, username: string): { secret: string; otpauthUri: string; expiresInMinutes: number } {
    if (this.enabled(userId)) throw new Error("MFA가 이미 활성화되어 있습니다.");
    const secret = base32Encode(crypto.randomBytes(20));
    const encrypted = this.encrypt(userId, secret);
    this.database.transaction(() => {
      this.database.prepare("DELETE FROM user_mfa_recovery_codes WHERE user_id = ?").run(userId);
      this.database.prepare(`INSERT INTO user_mfa(user_id, encrypted_secret, nonce, auth_tag, last_used_step, enabled_at, created_at)
        VALUES (?, ?, ?, ?, NULL, NULL, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET encrypted_secret=excluded.encrypted_secret, nonce=excluded.nonce,
          auth_tag=excluded.auth_tag, last_used_step=NULL, enabled_at=NULL, created_at=CURRENT_TIMESTAMP`)
        .run(userId, encrypted.encryptedSecret, encrypted.nonce, encrypted.authTag);
    })();
    const label = encodeURIComponent(`WAM:${username}`);
    const issuer = encodeURIComponent("web-agent-manager");
    return { secret, otpauthUri: `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`, expiresInMinutes: SETUP_TTL_MINUTES };
  }

  confirmSetup(userId: number, code: string, now = Date.now()): string[] | null {
    const row = this.database.prepare(`SELECT encrypted_secret, nonce, auth_tag, last_used_step, enabled_at FROM user_mfa
      WHERE user_id = ? AND enabled_at IS NULL AND created_at > datetime('now', ?)`).get(userId, `-${SETUP_TTL_MINUTES} minutes`) as MfaRow | undefined;
    if (!row) return null;
    const step = matchingTotpStep(this.decrypt(userId, row), code.trim(), now);
    if (step === null) return null;
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => recoveryCode());
    this.database.transaction(() => {
      // 등록 확인은 로그인 인증 자체가 아니므로 같은 30초 창에서 바로 다시 로그인할 수 있게 replay
      // 기준에는 넣지 않는다. 이후 실제 로그인/해제에서 소비한 코드부터 step을 고정한다.
      this.database.prepare("UPDATE user_mfa SET enabled_at = CURRENT_TIMESTAMP, last_used_step = NULL WHERE user_id = ? AND enabled_at IS NULL").run(userId);
      const insert = this.database.prepare("INSERT INTO user_mfa_recovery_codes(user_id, code_hash) VALUES (?, ?)");
      for (const recovery of codes) insert.run(userId, hashToken(normalizeRecoveryCode(recovery)));
    })();
    return codes;
  }

  createLoginChallenge(userId: number): { token: string; expiresAt: string } {
    this.database.prepare("DELETE FROM mfa_login_challenges WHERE expires_at <= datetime('now')").run();
    const token = createToken();
    const row = this.database.transaction(() => {
      // 올바른 비밀번호를 아는 공격자도 challenge 행을 무제한 쌓거나 새 token으로 시도 횟수를
      // 초기화하지 못하게 계정당 최신 하나만 유지한다.
      this.database.prepare("DELETE FROM mfa_login_challenges WHERE user_id = ?").run(userId);
      return this.database.prepare(`INSERT INTO mfa_login_challenges(token_hash, user_id, expires_at)
        VALUES (?, ?, datetime('now', ?)) RETURNING expires_at`).get(hashToken(token), userId, `+${LOGIN_CHALLENGE_TTL_MINUTES} minutes`) as { expires_at: string };
    })();
    return { token, expiresAt: row.expires_at };
  }

  loginChallengeLimiterKey(token: string): string {
    if (!token || token.length > 256) return "<invalid-mfa-challenge>";
    const row = this.database.prepare("SELECT user_id FROM mfa_login_challenges WHERE token_hash = ? AND expires_at > datetime('now')").get(hashToken(token)) as { user_id: number } | undefined;
    return row ? `mfa-user:${row.user_id}` : "<invalid-mfa-challenge>";
  }

  consumeLoginChallenge(token: string, code: string, now = Date.now()): { userId: number; method: "totp" | "recovery" } | null {
    if (!token || token.length > 256 || !code || code.length > 64) return null;
    return this.database.transaction(() => {
      const challenge = this.database.prepare(`SELECT token_hash, user_id, attempts FROM mfa_login_challenges
        WHERE token_hash = ? AND expires_at > datetime('now') AND attempts < ?`).get(hashToken(token), LOGIN_CHALLENGE_MAX_ATTEMPTS) as { token_hash: string; user_id: number; attempts: number } | undefined;
      if (!challenge) return null;
      const method = this.consumeUserCode(challenge.user_id, code, now);
      if (!method) {
        this.database.prepare("UPDATE mfa_login_challenges SET attempts = attempts + 1 WHERE token_hash = ?").run(challenge.token_hash);
        return null;
      }
      this.database.prepare("DELETE FROM mfa_login_challenges WHERE token_hash = ?").run(challenge.token_hash);
      return { userId: challenge.user_id, method };
    })();
  }

  consumeUserCode(userId: number, code: string, now = Date.now()): "totp" | "recovery" | null {
    const row = this.database.prepare("SELECT encrypted_secret, nonce, auth_tag, last_used_step, enabled_at FROM user_mfa WHERE user_id = ? AND enabled_at IS NOT NULL").get(userId) as MfaRow | undefined;
    if (!row) return null;
    const normalized = code.trim();
    const step = matchingTotpStep(this.decrypt(userId, row), normalized, now);
    if (step !== null && (row.last_used_step === null || step > row.last_used_step)) {
      const updated = this.database.prepare("UPDATE user_mfa SET last_used_step = ? WHERE user_id = ? AND (last_used_step IS NULL OR last_used_step < ?)").run(step, userId, step);
      if (updated.changes === 1) return "totp";
    }
    const recoveryHash = hashToken(normalizeRecoveryCode(normalized));
    const recovered = this.database.prepare("UPDATE user_mfa_recovery_codes SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND code_hash = ? AND used_at IS NULL").run(userId, recoveryHash);
    return recovered.changes === 1 ? "recovery" : null;
  }

  disable(userId: number): void {
    this.database.prepare("DELETE FROM user_mfa WHERE user_id = ?").run(userId);
  }

  private encrypt(userId: number, secret: string): { encryptedSecret: string; nonce: string; authTag: string } {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.loadOrCreateKey(), nonce);
    cipher.setAAD(Buffer.from(`wam-mfa:${userId}`));
    const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return { encryptedSecret: encrypted.toString("base64"), nonce: nonce.toString("base64"), authTag: cipher.getAuthTag().toString("base64") };
  }

  private decrypt(userId: number, row: Pick<MfaRow, "encrypted_secret" | "nonce" | "auth_tag">): string {
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.loadOrCreateKey(), Buffer.from(row.nonce, "base64"));
    decipher.setAAD(Buffer.from(`wam-mfa:${userId}`));
    decipher.setAuthTag(Buffer.from(row.auth_tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(row.encrypted_secret, "base64")), decipher.final()]).toString("utf8");
  }

  private loadOrCreateKey(): Buffer {
    const directory = path.dirname(this.keyPath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077) !== 0) throw new Error("MFA key 디렉터리는 소유자 전용이어야 합니다.");
    if (!fs.existsSync(this.keyPath)) {
      if (this.database.prepare("SELECT 1 FROM user_mfa LIMIT 1").get()) throw new Error("기존 MFA 데이터의 master key가 없습니다.");
      try {
        const descriptor = fs.openSync(this.keyPath, "wx", 0o600);
        try { fs.writeSync(descriptor, crypto.randomBytes(32)); } finally { fs.closeSync(descriptor); }
      } catch (error: any) { if (error?.code !== "EEXIST") throw error; }
    }
    const stat = fs.lstatSync(this.keyPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 32 || (stat.mode & 0o077) !== 0) throw new Error("MFA master key가 안전하지 않습니다.");
    return fs.readFileSync(this.keyPath);
  }
}
