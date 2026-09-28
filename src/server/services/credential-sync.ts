import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// 파일 복사로 옮겨도 되는 인증만 다룬다. gh 토큰은 자동 교체되지 않고, Codex는 공식 문서가 원격 머신에 auth.json
// 복사를 안내한다. Claude는 토큰 갱신 때 교체될 수 있어 두 컴퓨터가 같은 토큰을 쓰면 한쪽이 로그아웃될 수 있으므로
// 복사하지 않고 원격 로그인으로 처리한다(#138).
export const COPYABLE_CREDENTIALS = ["github", "codex"] as const;
export type CopyableCredential = typeof COPYABLE_CREDENTIALS[number];

const MAX_BYTES = 64 * 1024;
const KEEP_BACKUPS = 5;

export function isCopyableCredential(value: unknown): value is CopyableCredential {
  return typeof value === "string" && (COPYABLE_CREDENTIALS as readonly string[]).includes(value);
}

// WAM이 CLI를 실행할 때 쓰는 폴더. Codex는 CODEX_HOME(설치 계정 홈의 ~/.codex), gh는 프로세스 HOME 기준이다.
export interface CredentialDirs { homeDir: string; codexHome: string }

// 기본 계정의 인증 파일 경로.
// TODO(#138): 추가 계정 슬롯(agent-accounts의 계정별 설정 디렉터리)도 복사할 수 있게 넓힌다.
export function credentialFile(provider: CopyableCredential, dirs: CredentialDirs, env: NodeJS.ProcessEnv = process.env): string {
  const { homeDir } = dirs;
  if (provider === "codex") return path.join(dirs.codexHome, "auth.json");
  const configDir = env.GH_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(homeDir, ".config"), "gh");
  return path.join(configDir, "hosts.yml");
}

function invalid(message: string, statusCode = 400): Error {
  return Object.assign(new Error(message), { statusCode });
}

// 복사해도 로그인되는 내용인지 값은 드러내지 않고 형태만 확인한다.
function assertUsable(provider: CopyableCredential, content: string): void {
  if (!content.trim()) throw invalid("인증 파일이 비어 있습니다.");
  if (provider === "codex") {
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch { throw invalid("Codex 인증 파일 형식이 올바르지 않습니다."); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid("Codex 인증 파일 형식이 올바르지 않습니다.");
    return;
  }
  // gh가 키링에 토큰을 두면 hosts.yml에는 사용자 이름만 있어 복사해도 로그인되지 않는다.
  if (!/^\s*oauth_token\s*:/m.test(content)) throw invalid("이 컴퓨터의 gh는 토큰을 시스템 키링에 저장해 파일로 복사할 수 없습니다. 대상 컴퓨터에서 원격 로그인을 사용하세요.", 422);
}

// 메인 쪽: 보낼 인증 파일을 읽는다. 호출한 서버 코드 안에서만 쓰고 응답·로그에 넣지 않는다.
export function readCredential(provider: CopyableCredential, dirs: CredentialDirs): string {
  const file = credentialFile(provider, dirs);
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw invalid(`이 컴퓨터에 ${provider === "codex" ? "Codex" : "GitHub(gh)"} 로그인 정보가 없습니다. 먼저 로그인하세요.`, 404);
  if (stat.size > MAX_BYTES) throw invalid("인증 파일이 너무 큽니다.");
  const content = fs.readFileSync(file, "utf8");
  assertUsable(provider, content);
  return content;
}

// 서브 쪽: 받은 인증 파일을 고정 경로에 0600으로 쓴다. 기존 파일은 같은 폴더에 0600 백업으로 남긴다.
export function applyCredential(provider: CopyableCredential, content: unknown, dirs: CredentialDirs): { backup: string | null } {
  if (typeof content !== "string" || Buffer.byteLength(content) > MAX_BYTES) throw invalid("인증 파일 형식이 올바르지 않습니다.");
  assertUsable(provider, content);
  const file = credentialFile(provider, dirs);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let backup: string | null = null;
  if (fs.existsSync(file)) {
    backup = `${path.basename(file)}.wam-backup-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 6)}`;
    fs.copyFileSync(file, path.join(path.dirname(file), backup), fs.constants.COPYFILE_EXCL);
    fs.chmodSync(path.join(path.dirname(file), backup), 0o600);
    const prefix = `${path.basename(file)}.wam-backup-`;
    const backups = fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith(prefix)).sort();
    for (const old of backups.slice(0, Math.max(0, backups.length - KEEP_BACKUPS))) fs.rmSync(path.join(path.dirname(file), old), { force: true });
  }
  const temporary = `${file}.wam-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, content, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* rename 성공 */ }
  }
  return { backup };
}
