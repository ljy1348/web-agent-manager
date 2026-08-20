import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../core/config";
import type { AppDatabase } from "../core/database";
import type { AgentAccountRecord, Provider, UsageMonitorScope } from "../../shared/types";

// 계정 슬롯 디렉터리를 모아두는 위치. 인증 정보가 들어가므로 소유자만 접근할 수 있게 만든다.
const ACCOUNTS_DIRNAME = "agent-accounts";

// 공급자별로 설정 디렉터리를 지정하는 환경변수. 두 CLI가 공식으로 제공하는 값이라
// 인증 파일을 복사·교체하지 않고 이 변수만 바꿔 계정을 나눌 수 있다.
export const CONFIG_DIR_ENV: Record<Provider, string> = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  grok: "GROK_HOME",
};

// 라벨에서 디렉터리로 쓸 수 있는 slug를 만든다. 한글 라벨도 흔해 사용 가능한 문자가 하나도 안 남을 수 있어,
// 그런 경우 호출부에서 순번을 붙여 유일한 값을 만든다.
export function toAccountSlug(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
}

// 계정 슬롯을 등록·조회하고, 각 계정의 CLI 설정 디렉터리와 실행 환경변수를 계산한다.
export class AgentAccountService {
  constructor(private readonly config: AppConfig, private readonly database: AppDatabase) {}

  // 등록된 계정을 공급자·기본 계정 우선순으로 반환한다.
  list(provider?: Provider): AgentAccountRecord[] {
    const rows = provider
      ? this.database.prepare("SELECT * FROM agent_accounts WHERE provider = ? ORDER BY is_default DESC, id").all(provider)
      : this.database.prepare("SELECT * FROM agent_accounts ORDER BY provider, is_default DESC, id").all();
    return rows as AgentAccountRecord[];
  }

  // 계정 하나를 반환한다. 없으면 null.
  get(id: number): AgentAccountRecord | null {
    return (this.database.prepare("SELECT * FROM agent_accounts WHERE id = ?").get(id) as AgentAccountRecord | undefined) ?? null;
  }

  // 공급자의 기본 계정을 반환한다. 스키마 마이그레이션에서 항상 하나를 보장한다.
  defaultAccount(provider: Provider): AgentAccountRecord {
    const row = this.database.prepare("SELECT * FROM agent_accounts WHERE provider = ? AND is_default = 1").get(provider) as AgentAccountRecord | undefined;
    if (!row) throw new Error("기본 계정이 등록되어 있지 않습니다.");
    return row;
  }

  // 채팅에 지정된 계정을 반환하되, 값이 없거나 지워진 계정이면 기본 계정으로 되돌린다.
  resolveForChat(provider: Provider, accountId: number | null | undefined): AgentAccountRecord {
    if (accountId != null) {
      const account = this.get(accountId);
      if (account && account.provider === provider) return account;
    }
    return this.defaultAccount(provider);
  }

  // 사용자가 고른 계정이 그 공급자의 것인지 확인한다. 지정하지 않았으면 기본 계정을 쓴다.
  // resolveForChat과 달리 잘못된 값을 조용히 넘기지 않고 거부한다(생성·변경 요청 검증용).
  requireForProvider(provider: Provider, accountId: number | null | undefined): AgentAccountRecord {
    if (accountId == null) return this.defaultAccount(provider);
    const account = this.get(accountId);
    if (!account) throw new Error("계정을 찾을 수 없습니다.");
    if (account.provider !== provider) throw new Error("다른 공급자의 계정은 사용할 수 없습니다.");
    return account;
  }

  // 새 계정 슬롯을 만들고 전용 설정 디렉터리를 준비한다. 실제 로그인은 CLI 인증 화면에서 따로 진행한다.
  create(provider: Provider, label: string): AgentAccountRecord {
    const trimmed = label.trim();
    if (!trimmed) throw new Error("계정 이름을 입력해주세요.");
    const base = toAccountSlug(trimmed) || provider;
    let slug = base;
    for (let suffix = 2; this.database.prepare("SELECT 1 FROM agent_accounts WHERE provider = ? AND slug = ?").get(provider, slug); suffix += 1) {
      slug = `${base}-${suffix}`;
    }
    const configDir = path.join(this.config.dataDir, ACCOUNTS_DIRNAME, provider, slug);
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const result = this.database.prepare(`
      INSERT INTO agent_accounts(provider, label, slug, config_dir, is_default) VALUES (?, ?, ?, ?, 0)
    `).run(provider, trimmed, slug, configDir);
    return this.get(Number(result.lastInsertRowid))!;
  }

  // 계정 표시 이름만 바꾼다. 디렉터리 경로는 이미 만들어진 인증을 잃지 않도록 그대로 둔다.
  rename(id: number, label: string): AgentAccountRecord {
    const trimmed = label.trim();
    if (!trimmed) throw new Error("계정 이름을 입력해주세요.");
    const account = this.get(id);
    if (!account) throw new Error("계정을 찾을 수 없습니다.");
    this.database.prepare("UPDATE agent_accounts SET label = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(trimmed, id);
    return this.get(id)!;
  }

  // 이 계정을 쓰는 채팅 수를 센다. 삭제 전 확인 문구와 거부 판단에 쓴다.
  chatCount(id: number): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM chats WHERE account_id = ?").get(id) as { count: number };
    return row.count;
  }

  // 계정 슬롯을 지운다. 기본 계정과 사용 중인 계정은 거부하고, 인증이 들어 있는 디렉터리는
  // 호출부가 명시적으로 요청했을 때만 지운다(되돌릴 수 없는 동작이라 기본값은 보존).
  remove(id: number, removeFiles: boolean): void {
    const account = this.get(id);
    if (!account) throw new Error("계정을 찾을 수 없습니다.");
    if (account.is_default) throw new Error("기본 계정은 삭제할 수 없습니다.");
    const used = this.chatCount(id);
    if (used > 0) throw new Error(`이 계정을 쓰는 채팅이 ${used}개 있습니다. 채팅의 계정을 먼저 옮겨주세요.`);
    this.database.prepare("DELETE FROM agent_accounts WHERE id = ?").run(id);
    this.database.prepare("DELETE FROM usage_status WHERE account_id = ?").run(id);
    if (removeFiles && account.config_dir && this.isManagedDir(account.config_dir)) {
      fs.rmSync(account.config_dir, { recursive: true, force: true });
    }
  }

  // 앱이 직접 만든 계정 디렉터리인지 확인한다. 바깥 경로를 지우는 사고를 막기 위한 방어다.
  private isManagedDir(configDir: string): boolean {
    const root = path.join(this.config.dataDir, ACCOUNTS_DIRNAME);
    const resolved = path.resolve(configDir);
    return resolved.startsWith(`${path.resolve(root)}${path.sep}`);
  }

  // 계정 실행에 필요한 환경변수를 만든다. 기본 계정은 아무것도 주입하지 않아 CLI 기본 경로를 그대로 쓴다.
  environment(account: AgentAccountRecord): Record<string, string> {
    if (!account.config_dir) return {};
    fs.mkdirSync(account.config_dir, { recursive: true, mode: 0o700 });
    return { [CONFIG_DIR_ENV[account.provider]]: account.config_dir };
  }

  // 사용량 조회 대상 계정을 설정에 따라 고른다. 기본은 공급자별 기본 계정 하나뿐이다.
  monitorTargets(provider: Provider): AgentAccountRecord[] {
    return this.usageScope() === "all" ? this.list(provider) : [this.defaultAccount(provider)];
  }

  // 현재 사용량 조회 범위 설정을 반환한다.
  usageScope(): UsageMonitorScope {
    const row = this.database.prepare("SELECT scope FROM usage_monitor_settings WHERE id = 1").get() as { scope: UsageMonitorScope } | undefined;
    return row?.scope ?? "default";
  }

  // 사용량 조회 범위를 바꾼다. 실제 PTY 재구성은 호출부(UsageMonitor)가 이어서 처리한다.
  setUsageScope(scope: UsageMonitorScope): void {
    this.database.prepare(`
      INSERT INTO usage_monitor_settings(id, scope, updated_at) VALUES (1, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET scope = excluded.scope, updated_at = CURRENT_TIMESTAMP
    `).run(scope);
  }
}
