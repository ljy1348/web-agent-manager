import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DUMMY_PASSWORD_SALT = Buffer.alloc(16);
const DUMMY_PASSWORD_HASH = `scrypt:${DUMMY_PASSWORD_SALT.toString("base64")}:${crypto.scryptSync("invalid-password", DUMMY_PASSWORD_SALT, 64).toString("base64")}`;

// 비밀번호를 scrypt로 해시해 저장 가능한 문자열로 만든다.
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const derived = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(key));
  });
  return `scrypt:${salt.toString("base64")}:${derived.toString("base64")}`;
}

// 입력 비밀번호가 저장된 scrypt 해시와 일치하는지 검증한다.
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, saltValue, hashValue] = encoded.split(":");
  if (algorithm !== "scrypt" || !saltValue || !hashValue) return false;
  const salt = Buffer.from(saltValue, "base64");
  const expected = Buffer.from(hashValue, "base64");
  const actual = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, expected.length, (error, key) => error ? reject(error) : resolve(key));
  });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// 존재하지 않는 계정도 실제 계정과 같은 scrypt 비용을 사용하도록 더미 해시를 반환한다.
export function dummyPasswordHash(): string {
  return DUMMY_PASSWORD_HASH;
}

// 브라우저에 전달할 임의 토큰을 생성한다.
export function createToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

// 원문 토큰을 저장하지 않도록 SHA-256 해시를 계산한다.
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// 길이가 다른 문자열도 해시 후 고정 길이 버퍼로 바꿔 타이밍 차이를 줄여 비교한다.
export function timingSafeEqualString(actual: string, expected: string): boolean {
  const actualDigest = crypto.createHash("sha256").update(actual).digest();
  const expectedDigest = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(actualDigest, expectedDigest);
}

// Cookie 헤더를 키와 값의 객체로 변환한다.
export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(header.split(";").map((part) => {
    const index = part.indexOf("=");
    if (index < 0) return [part.trim(), ""];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
  }));
}

// 대상 경로가 허용된 루트 내부인지 실제 경로 기준으로 검증한다.
export function assertAllowedPath(target: string, allowedRoots: string[], mustExist = true): string {
  const resolved = path.resolve(target);
  const candidate = mustExist
    ? fs.realpathSync(resolved)
    : path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
  const allowed = allowedRoots.some((root) => {
    const actualRoot = fs.realpathSync(root);
    // 루트("/")는 그 자체로 전체 파일시스템을 의미하므로 sep를 덧붙이면("//") 일반 경로와 절대 안 맞는다.
    if (actualRoot === path.sep) return true;
    return candidate === actualRoot || candidate.startsWith(`${actualRoot}${path.sep}`);
  });
  if (!allowed) throw new Error("허용된 프로젝트 경로를 벗어났습니다.");
  return candidate;
}

// 사용자 제공 파일명이 디렉터리 이동을 포함하지 않는지 검증한다.
export function safeBasename(value: string): string {
  const basename = value.normalize("NFC").trim();
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
  if (!basename || basename !== path.basename(basename) || basename.includes("\\") || basename === "." || basename === ".." || /[\x00-\x1f\x7f]/.test(basename) || /[. ]$/.test(basename) || reserved.test(basename)) {
    throw new Error("유효하지 않은 파일명입니다.");
  }
  return basename;
}

// ANSI와 OSC 제어 시퀀스를 제거해 터미널 텍스트를 정규화한다.
export function stripAnsi(value: string): string {
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/\r/g, "");
}
