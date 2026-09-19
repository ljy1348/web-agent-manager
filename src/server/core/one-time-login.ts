import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "./config";
import { deleteExpiredTemporaryUsers, type AppDatabase } from "./database";
import { createWebSession } from "./auth";
import { verifyPassword } from "./security";

export const ONE_TIME_CODE_TTL_MINUTES = 10;
export const TEMPORARY_SESSION_TTL_MINUTES = 60;
const MAX_ACTIVE_ONE_TIME_CODES = 10;
const CODE_SECRET_FILE = "one-time-code-secret";
const CODE_SECRET_BYTES = 32;
const secretCache = new Map<string, Buffer>();

// 시크릿을 기동 시점에 한 번 읽어(없으면 만들어) 잘못된 설정을 첫 로그인 요청까지 미루지 않는다.
// 이 호출이 없으면 짧은 환경변수를 넣어도 서버는 그대로 뜨고 일회용 로그인만 500이 된다.

// 코드 해시에 쓸 서버 시크릿을 읽고, 없으면 한 번만 만든다.
// 8자리 숫자는 약 26.6비트라 해시 함수만으로는 DB 유출 시 전수조사를 막지 못한다. 시크릿이 DB
// 바깥에 있어야 유출된 해시로 후보를 시험해 볼 수 없다. 환경변수를 먼저 보고, 없으면 데이터
// 디렉터리(0700)에 0600 파일로 만든다. DB 파일과 같은 디렉터리라 파일 시스템 전체가 털리는
// 경우까지 막지는 못하며, 그때는 환경변수나 외부 시크릿 저장소로 옮겨야 한다.
export function ensureOneTimeCodeSecret(config: AppConfig): void {
  codeSecret(config);
}

function codeSecret(config: AppConfig): Buffer {
  const fromEnv = process.env.WEB_AGENT_MANAGER_ONE_TIME_CODE_SECRET;
  if (fromEnv) {
    const value = Buffer.from(fromEnv, "utf8");
    // 파일에만 최소 길이를 요구하면 환경변수로 짧은 값을 넣었을 때 조용히 약해진다.
    if (value.length < CODE_SECRET_BYTES) throw new Error(`WEB_AGENT_MANAGER_ONE_TIME_CODE_SECRET은 ${CODE_SECRET_BYTES}바이트 이상이어야 합니다.`);
    return value;
  }
  const cached = secretCache.get(config.dataDir);
  if (cached) return cached;
  const file = path.join(config.dataDir, CODE_SECRET_FILE);
  let secret: Buffer | null = null;
  try {
    const existing = fs.readFileSync(file);
    if (existing.length >= CODE_SECRET_BYTES) secret = existing;
  } catch {
    // 파일이 아직 없으면 아래에서 만든다.
  }
  if (!secret) {
    const created = crypto.randomBytes(CODE_SECRET_BYTES);
    try {
      // wx는 이미 있으면 실패한다. 두 프로세스가 같은 데이터 디렉터리로 동시에 처음 뜨더라도
      // 나중 프로세스가 앞선 시크릿을 덮어써 서로 다른 값을 캐시하는 일을 막는다.
      fs.writeFileSync(file, created, { mode: 0o600, flag: "wx" });
      secret = created;
    } catch {
      const existing = fs.readFileSync(file);
      if (existing.length < CODE_SECRET_BYTES) throw new Error("일회용 코드 시크릿 파일이 손상되었습니다.");
      secret = existing;
    }
  }
  secretCache.set(config.dataDir, secret);
  return secret;
}

// 코드를 인덱스로 찾을 수 있는 고정 해시로 바꾼다.
// 예전에는 salt가 섞인 scrypt로 저장해 입력 코드를 활성 코드마다 한 번씩 검증해야 했고, 인증 없이
// 호출되는 로그인 요청 하나가 최대 10회(약 486ms) scrypt를 돌렸다(#62).
function hashCode(config: AppConfig, code: string): string {
  return `hmac:${crypto.createHmac("sha256", codeSecret(config)).update(code).digest("base64")}`;
}

// 활성 코드 한도 초과는 서버 장애가 아니라 잠시 뒤 재시도하면 되는 상태라 라우트가 429로 구분한다.
export class OneTimeCodeLimitError extends Error {
  // 가장 이른 코드가 만료되면 자리가 나므로, 그 시각까지만 기다리게 Retry-After에 쓴다.
  readonly earliestExpiresAt: string | null;
  constructor(earliestExpiresAt: string | null = null) {
    // 실제 대기 시간은 가장 이른 코드의 만료까지라 본문에 10분을 박으면 Retry-After와 어긋난다.
    super("유효한 일회용 코드가 너무 많습니다. 기존 코드가 만료된 뒤 다시 시도해주세요.");
    this.name = "OneTimeCodeLimitError";
    this.earliestExpiresAt = earliestExpiresAt;
  }
}

export interface IssuedOneTimeCode {
  id: string;
  code: string;
  expiresAt: string;
}

// 숫자 코드는 엔트로피가 낮으므로 서버 시크릿 HMAC으로 저장한다(원문은 저장하지 않는다).
export async function issueOneTimeLoginCode(database: AppDatabase, config: AppConfig, issuedBy: number): Promise<IssuedOneTimeCode> {
  database.prepare("DELETE FROM one_time_login_codes WHERE created_at <= datetime('now', '-30 days')").run();
  deleteExpiredTemporaryUsers(database);
  const active = database.prepare(`
    SELECT COUNT(*) AS count, MIN(expires_at) AS earliest FROM one_time_login_codes
    WHERE consumed_at IS NULL AND expires_at > datetime('now')
  `).get() as { count: number; earliest: string | null };
  if (active.count >= MAX_ACTIVE_ONE_TIME_CODES) throw new OneTimeCodeLimitError(active.earliest);
  // HMAC은 같은 숫자에 늘 같은 해시를 만들고 code_hash에는 UNIQUE가 걸려 있다. 소비·만료된 행도
  // 30일 남으므로, 그 사이에 같은 숫자가 다시 뽑히면 INSERT가 제약 위반으로 실패한다. salt를 쓰던
  // scrypt 시절에는 없던 충돌이라 여기서 다시 뽑는다(1e8 공간이라 재시도는 사실상 일어나지 않는다).
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = crypto.randomUUID();
    const code = crypto.randomInt(100_000_000).toString().padStart(8, "0");
    const codeHash = hashCode(config, code);
    // 활성 개수를 다시 세고 넣는 것까지 한 트랜잭션으로 묶는다. 묶지 않으면 한도를 넘겨 저장되고,
    // 그렇게 넘친 코드는 소비 시점에 후보로 조회되지 않아 올바른 입력으로도 영영 교환되지 않는다.
    let row: { expires_at: string };
    try {
      row = database.transaction(() => {
        const current = database.prepare(`
          SELECT COUNT(*) AS count, MIN(expires_at) AS earliest FROM one_time_login_codes
          WHERE consumed_at IS NULL AND expires_at > datetime('now')
        `).get() as { count: number; earliest: string | null };
        // 트랜잭션 안에서 던지면 롤백되고 그대로 밖으로 전파돼, 라우트가 429와 Retry-After를 만든다.
        if (current.count >= MAX_ACTIVE_ONE_TIME_CODES) throw new OneTimeCodeLimitError(current.earliest);
        return database.prepare(`
          INSERT INTO one_time_login_codes(id, code_hash, issued_by, expires_at)
          VALUES (?, ?, ?, datetime('now', ?))
          RETURNING expires_at
        `).get(id, codeHash, issuedBy, `+${ONE_TIME_CODE_TTL_MINUTES} minutes`) as { expires_at: string };
      })();
    } catch (error) {
      if (isDuplicateCodeHash(error)) continue;
      throw error;
    }
    return { id, code, expiresAt: row.expires_at };
  }
  throw new Error("일회용 로그인 코드를 생성하지 못했습니다. 다시 시도해주세요.");
}

// 같은 코드 해시가 이미 저장돼 있어 INSERT가 거부된 경우인지 확인한다.
function isDuplicateCodeHash(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && (error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE";
}

// 아직 유효하고 사용되지 않은 코드를 원자적으로 소비해 일반 사용자·비신뢰 세션을 만든다.
export async function consumeOneTimeLoginCode(database: AppDatabase, config: AppConfig, code: string) {
  // HMAC은 같은 코드에 늘 같은 값이라 인덱스로 한 번에 찾는다. 후보를 순회하며 검증하던 예전
  // 구조는 로그인 요청 하나가 활성 코드 수만큼 scrypt를 돌게 만들었다(#62).
  let matched = database.prepare(`
    SELECT id, issued_by FROM one_time_login_codes
    WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > datetime('now')
  `).get(hashCode(config, code)) as { id: string; issued_by: number } | undefined;
  // TODO(#62): HMAC 전환 전에 발급된 scrypt 코드를 위한 과도기 경로. 코드 수명이 10분이라
  // 배포 후 10분이 지나면 남은 scrypt 행이 없으므로, 그때 이 블록과 verifyPassword import를
  // 지우면 된다. 남겨 두는 동안에도 HMAC 조회가 먼저 성공하면 여기까지 오지 않는다.
  if (!matched) {
    const legacy = database.prepare(`
      SELECT id, issued_by, code_hash FROM one_time_login_codes
      WHERE consumed_at IS NULL AND expires_at > datetime('now') AND code_hash LIKE 'scrypt:%'
      ORDER BY created_at DESC
    `).all() as Array<{ id: string; issued_by: number; code_hash: string }>;
    for (const candidate of legacy) {
      if (await verifyPassword(code, candidate.code_hash)) { matched = candidate; break; }
    }
  }
  if (!matched) return null;
  return database.transaction(() => {
    const row = database.prepare(`
      SELECT id, issued_by FROM one_time_login_codes
      WHERE id = ? AND consumed_at IS NULL AND expires_at > datetime('now')
    `).get(matched.id) as { id: string; issued_by: number } | undefined;
    if (!row) return null;
    const consumed = database.prepare(`
      UPDATE one_time_login_codes SET consumed_at = CURRENT_TIMESTAMP
      WHERE id = ? AND consumed_at IS NULL AND expires_at > datetime('now')
    `).run(row.id);
    if (consumed.changes !== 1) return null;

    const username = `임시-${row.id.slice(0, 8)}`;
    const temporaryUser = database.prepare(`
      INSERT INTO users(username, password_hash, role, temporary_expires_at, created_by)
      VALUES (?, 'temporary-login-disabled', 'user', datetime('now', ?), ?)
    `).run(username, `+${TEMPORARY_SESSION_TTL_MINUTES} minutes`, row.issued_by);
    const session = createWebSession(database, config, Number(temporaryUser.lastInsertRowid), null, {
      ttlMinutes: TEMPORARY_SESSION_TTL_MINUTES,
      networkAccessAllowed: false,
      reauthenticated: false,
    });
    if (!session) throw new Error("임시 로그인 세션을 만들지 못했습니다.");
    return { ...session, codeId: row.id, issuedBy: row.issued_by };
  })();
}
