import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { GROK_HOOK_FILE } from "./runtime-files";

export const SETTINGS_PROVIDERS = ["claude", "codex", "grok"] as const;
export type SettingsProvider = typeof SETTINGS_PROVIDERS[number];

interface BundleFile {
  provider: SettingsProvider;
  // 홈 디렉터리 기준 POSIX 상대 경로. 적용 시 공급자 관리 범위 안인지 다시 검증한다.
  path: string;
  content: string;
  mode: number;
}

export interface ProviderSettingsBundle {
  schemaVersion: 1;
  createdAt: string;
  providers: SettingsProvider[];
  files: BundleFile[];
  // Claude 훅은 settings.json 전체가 아니라 hooks 키만 옮긴다(모델·권한 등 나머지 설정은 보존). null은 훅 없음.
  claudeHooks?: unknown;
}

export interface ProviderSettingsBackupMeta {
  id: string;
  createdAt: string;
  reason: "manual" | "before-restore" | "before-sync";
  providers: SettingsProvider[];
  fileCount: number;
  bytes: number;
}

export interface ProviderSettingsSummary {
  provider: SettingsProvider;
  instructions: string[];
  skills: string[];
  hooks: string[];
}

// 공급자별 동기화 범위. 자격증명·WAM 자체 훅/스킬 링크·컴퓨터별 값(신뢰 폴더, MCP 경로)은 설치본마다 달라 넣지 않는다.
// TODO(#135): Grok 전역 지침 파일 위치를 확인하면 instructions에 추가한다. 일반 설정(모델·권한)도 후속 범위다.
interface ProviderScope {
  instructions: string[];
  skillsDir: string;
  skillExcludes: string[];
  hookFiles?: string[];
  hookDir?: { dir: string; exclude: string[] };
  claudeSettings?: string;
}

const SCOPES: Record<SettingsProvider, ProviderScope> = {
  // `skills/synced`는 Claude가 claude.ai에서 내려받아 스스로 관리하는 캐시다.
  claude: { instructions: [".claude/CLAUDE.md"], skillsDir: ".claude/skills", skillExcludes: ["synced"], claudeSettings: ".claude/settings.json" },
  // `.system`은 Codex CLI 내장 스킬이라 버전별로 CLI가 설치한다. 훅은 config.toml을 건드리지 않도록 hooks.json만 다룬다.
  codex: { instructions: [".codex/AGENTS.md", ".codex/AGENTS.override.md"], skillsDir: ".codex/skills", skillExcludes: [".system"], hookFiles: [".codex/hooks.json"] },
  grok: { instructions: [], skillsDir: ".grok/skills", skillExcludes: [], hookDir: { dir: ".grok/hooks", exclude: [GROK_HOOK_FILE] } },
};

const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 3000;
const MAX_BACKUPS = 50;
const SKILL_NAME = /^[^/\\\0]{1,200}$/;

function isProvider(value: unknown): value is SettingsProvider {
  return typeof value === "string" && (SETTINGS_PROVIDERS as readonly string[]).includes(value);
}

// 요청으로 받은 공급자 목록을 검증·중복 제거한다. 비어 있으면 전체 공급자.
export function parseSettingsProviders(value: unknown): SettingsProvider[] {
  if (value === undefined || value === null) return [...SETTINGS_PROVIDERS];
  if (!Array.isArray(value) || !value.every(isProvider)) throw Object.assign(new Error("공급자 목록이 올바르지 않습니다."), { statusCode: 400 });
  const unique = [...new Set(value)];
  if (!unique.length) throw Object.assign(new Error("공급자를 하나 이상 선택하세요."), { statusCode: 400 });
  return unique;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function lstat(target: string): fs.Stats | undefined {
  return fs.lstatSync(target, { throwIfNoEntry: false });
}

// 임시 파일에 쓴 뒤 rename해 도중 실패로 반쯤 쓴 설정이 남지 않게 한다.
function writeAtomic(target: string, data: Buffer, mode: number): void {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.wam-settings-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, data, { mode: mode & 0o777 });
    fs.renameSync(temporary, target);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* rename 성공 */ }
  }
}

// 훅 설정(JSON) 안의 모든 command 문자열을 모은다.
function hookCommands(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) hookCommands(item, found);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "command" && typeof item === "string") found.push(item);
      else hookCommands(item, found);
    }
  }
  return found;
}

const UNIX_ONLY_COMMAND = /(^|[\s"'=])\/(usr|bin|home|opt|tmp|etc|var|root)\/|\.sh(\b|$)|(^|[\s"'])(bash|sh|zsh)(\s|$)/;

// Windows에서 받은 번들 중 그대로는 동작하지 않을 훅 명령·셸 스크립트를 찾는다(#140). 적용은 막지 않고 알려만 준다.
export function windowsCompatibilityWarnings(bundle: Pick<ProviderSettingsBundle, "files" | "claudeHooks">): string[] {
  const warnings: string[] = [];
  const check = (source: string, commands: string[]) => {
    for (const command of commands) if (UNIX_ONLY_COMMAND.test(command)) warnings.push(`${source} 훅 명령이 Linux 경로나 셸을 씁니다: ${command.slice(0, 120)}`);
  };
  if (bundle.claudeHooks) check("Claude settings.json", hookCommands(bundle.claudeHooks));
  for (const file of bundle.files) {
    if (file.path.endsWith(".sh")) warnings.push(`스킬의 셸 스크립트는 Windows에서 실행되지 않을 수 있습니다: ${file.path}`);
    else if (/(^|\/)hooks(\.json|\/[^/]+\.json)$/.test(file.path)) {
      try { check(file.path, hookCommands(JSON.parse(Buffer.from(file.content, "base64").toString("utf8")))); } catch { /* 형식 오류는 CLI가 알린다 */ }
    }
  }
  return warnings.slice(0, 50);
}

// 공급자 전역 지침·사용자 스킬·사용자 훅을 번들로 만들고, 적용·백업·복원을 담당한다.
export class ProviderSettingsService {
  private readonly backupRoot: string;

  // codexHome: WAM은 기본 Codex를 설치 계정 홈의 ~/.codex(CODEX_HOME)로 실행하므로 프로세스 HOME과 다를 수 있다.
  constructor(dataDir: string, private readonly homeDir: string, private readonly codexHome = path.join(homeDir, ".codex")) {
    this.backupRoot = path.join(dataDir, "provider-settings-backups");
  }

  // 번들 경로(".codex/..." 등 홈 기준 표기)를 실제 위치로 바꾼다. Codex만 CODEX_HOME 아래로 연결한다.
  private abs(relative: string): string {
    if (relative === ".codex" || relative.startsWith(".codex/")) return path.join(this.codexHome, relative.slice(".codex/".length));
    return path.join(this.homeDir, relative);
  }

  // 스킬 폴더에서 옮길 스킬 이름 목록. symlink(WAM 스킬 링크 등)와 공급자 관리 폴더는 제외한다.
  private skillNames(provider: SettingsProvider): string[] {
    const scope = SCOPES[provider];
    const root = this.abs(scope.skillsDir);
    if (!lstat(root)?.isDirectory()) return [];
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !scope.skillExcludes.includes(entry.name))
      .map((entry) => entry.name).sort();
  }

  private hookFileNames(provider: SettingsProvider): string[] {
    const scope = SCOPES[provider];
    const names = (scope.hookFiles ?? []).filter((file) => lstat(this.abs(file))?.isFile());
    if (scope.hookDir) {
      const root = this.abs(scope.hookDir.dir);
      if (lstat(root)?.isDirectory()) {
        names.push(...fs.readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !scope.hookDir!.exclude.includes(entry.name))
          .map((entry) => `${scope.hookDir!.dir}/${entry.name}`));
      }
    }
    return names.sort();
  }

  private readClaudeSettings(): Record<string, unknown> | undefined {
    const file = this.abs(SCOPES.claude.claudeSettings!);
    if (!lstat(file)?.isFile()) return undefined;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Claude settings.json 형식이 올바르지 않습니다.");
    return parsed as Record<string, unknown>;
  }

  // 화면 표시용: 공급자별로 어떤 지침·스킬·훅이 동기화/백업 대상인지 이름만 돌려준다(내용은 보내지 않음).
  summary(): ProviderSettingsSummary[] {
    return SETTINGS_PROVIDERS.map((provider) => {
      const scope = SCOPES[provider];
      const hooks = this.hookFileNames(provider);
      if (provider === "claude") {
        try {
          const hookEvents = this.readClaudeSettings()?.hooks;
          if (hookEvents && typeof hookEvents === "object") hooks.unshift(...Object.keys(hookEvents).map((event) => `settings.json hooks.${event}`));
        } catch { hooks.unshift("settings.json (읽기 실패)"); }
      }
      return {
        provider,
        instructions: scope.instructions.filter((file) => lstat(this.abs(file))?.isFile()),
        skills: this.skillNames(provider),
        hooks,
      };
    });
  }

  // 선택한 공급자의 현재 설정을 번들로 만든다. 크기·개수 제한을 넘으면 거부한다.
  exportBundle(providers: SettingsProvider[]): ProviderSettingsBundle {
    const files: BundleFile[] = [];
    let bytes = 0;
    const add = (provider: SettingsProvider, relative: string): void => {
      const data = fs.readFileSync(this.abs(relative));
      bytes += data.length;
      if (bytes > MAX_TOTAL_BYTES) throw Object.assign(new Error("설정 번들이 20MiB를 넘습니다. 큰 파일이 든 스킬을 확인하세요."), { statusCode: 413 });
      if (files.length >= MAX_FILES) throw Object.assign(new Error(`설정 파일이 ${MAX_FILES}개를 넘습니다.`), { statusCode: 413 });
      files.push({ provider, path: relative, content: data.toString("base64"), mode: fs.statSync(this.abs(relative)).mode & 0o777 });
    };
    // 스킬 내부도 일반 파일·폴더만 따라간다. 내부 symlink는 대상 컴퓨터에서 깨지거나 범위 밖을 가리킬 수 있다.
    const walk = (provider: SettingsProvider, relative: string): void => {
      for (const entry of fs.readdirSync(this.abs(relative), { withFileTypes: true })) {
        const child = `${relative}/${entry.name}`;
        if (entry.isDirectory()) walk(provider, child);
        else if (entry.isFile()) add(provider, child);
      }
    };
    let claudeHooks: unknown;
    for (const provider of providers) {
      const scope = SCOPES[provider];
      for (const file of scope.instructions) if (lstat(this.abs(file))?.isFile()) add(provider, file);
      for (const skill of this.skillNames(provider)) walk(provider, `${scope.skillsDir}/${skill}`);
      for (const file of this.hookFileNames(provider)) add(provider, file);
      if (provider === "claude") claudeHooks = this.readClaudeSettings()?.hooks ?? null;
    }
    return { schemaVersion: 1, createdAt: new Date().toISOString(), providers, files, ...(providers.includes("claude") ? { claudeHooks } : {}) };
  }

  // 번들 파일 경로가 해당 공급자의 관리 범위(지침 파일, 스킬 폴더 하위, 훅 파일) 안인지 확인한다.
  private assertManagedPath(file: BundleFile): void {
    const scope = SCOPES[file.provider];
    const normalized = path.posix.normalize(file.path);
    const bad = () => Object.assign(new Error(`허용되지 않은 설정 경로입니다: ${file.path}`), { statusCode: 400 });
    if (normalized !== file.path || normalized.startsWith("/") || normalized.split("/").includes("..") || file.path.includes("\\") || file.path.includes("\0")) throw bad();
    if (scope.instructions.includes(normalized) || scope.hookFiles?.includes(normalized)) return;
    if (scope.hookDir && path.posix.dirname(normalized) === scope.hookDir.dir && normalized.endsWith(".json") && !scope.hookDir.exclude.includes(path.posix.basename(normalized))) return;
    const skillPrefix = `${scope.skillsDir}/`;
    if (normalized.startsWith(skillPrefix)) {
      const [skill, ...rest] = normalized.slice(skillPrefix.length).split("/");
      if (rest.length && SKILL_NAME.test(skill) && !scope.skillExcludes.includes(skill)) return;
    }
    throw bad();
  }

  // 번들 형식을 검증한다. 원격에서 받은 번들도 이 검사를 통과해야만 파일을 쓴다.
  private validate(bundle: unknown): ProviderSettingsBundle {
    const value = bundle as ProviderSettingsBundle;
    if (!value || value.schemaVersion !== 1 || !Array.isArray(value.files)) throw Object.assign(new Error("설정 번들 형식이 올바르지 않습니다."), { statusCode: 400 });
    const providers = parseSettingsProviders(value.providers);
    if (value.files.length > MAX_FILES) throw Object.assign(new Error("설정 파일 수가 너무 많습니다."), { statusCode: 413 });
    let bytes = 0;
    const seen = new Set<string>();
    for (const file of value.files) {
      if (!file || !providers.includes(file.provider) || typeof file.path !== "string" || typeof file.content !== "string" || !Number.isInteger(file.mode)) throw Object.assign(new Error("설정 번들 파일 형식이 올바르지 않습니다."), { statusCode: 400 });
      this.assertManagedPath(file);
      if (seen.has(file.path)) throw Object.assign(new Error(`중복된 설정 경로입니다: ${file.path}`), { statusCode: 400 });
      seen.add(file.path);
      bytes += Buffer.byteLength(file.content, "base64");
    }
    if (bytes > MAX_TOTAL_BYTES) throw Object.assign(new Error("설정 번들이 20MiB를 넘습니다."), { statusCode: 413 });
    return { ...value, providers };
  }

  // 번들을 적용해 선택 공급자의 관리 범위를 번들과 같은 상태로 맞춘다(번들에 없는 지침·스킬·훅은 제거).
  // 호출 전에 현재 상태가 자동 백업되므로 되돌릴 수 있다. 대상 쪽 symlink 스킬(WAM 링크)은 건드리지 않는다.
  apply(input: unknown, reason: "before-restore" | "before-sync", platform: NodeJS.Platform = process.platform): { backup: ProviderSettingsBackupMeta; written: number; removed: number; skipped: string[]; warnings: string[] } {
    const bundle = this.validate(input);
    const warnings = platform === "win32" ? windowsCompatibilityWarnings(bundle) : [];
    const backup = this.createBackup(bundle.providers, reason);
    let written = 0;
    let removed = 0;
    const skipped: string[] = [];
    const remove = (target: string): void => { fs.rmSync(target, { recursive: true, force: true }); removed += 1; };
    for (const provider of bundle.providers) {
      const scope = SCOPES[provider];
      const files = bundle.files.filter((file) => file.provider === provider);
      const incomingSkills = new Set(files.filter((file) => file.path.startsWith(`${scope.skillsDir}/`)).map((file) => file.path.slice(scope.skillsDir.length + 1).split("/")[0]));
      const skillsRoot = this.abs(scope.skillsDir);
      // 기존 스킬은 폴더째 지우고 새로 써서, 원본에서 지운 스킬 내부 파일이 남지 않게 한다.
      for (const skill of this.skillNames(provider)) remove(path.join(skillsRoot, skill));
      for (const skill of incomingSkills) {
        if (lstat(path.join(skillsRoot, skill))?.isSymbolicLink()) skipped.push(`${scope.skillsDir}/${skill} (대상의 링크 스킬 유지)`);
      }
      for (const file of [...scope.instructions, ...this.hookFileNames(provider)]) {
        if (!files.some((item) => item.path === file)) remove(this.abs(file));
      }
      for (const file of files) {
        const target = this.abs(file.path);
        const skill = file.path.startsWith(`${scope.skillsDir}/`) ? file.path.slice(scope.skillsDir.length + 1).split("/")[0] : undefined;
        if (skill && lstat(path.join(skillsRoot, skill))?.isSymbolicLink()) continue;
        // 중간 경로에 symlink가 있으면 홈 밖으로 쓸 수 있으므로 실제 경로로도 범위를 확인한다.
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        const base = file.provider === "codex" ? this.codexHome : this.homeDir;
        if (!inside(fs.realpathSync(base), fs.realpathSync(path.dirname(target)))) throw new Error(`설정 경로가 설정 폴더를 벗어납니다: ${file.path}`);
        writeAtomic(target, Buffer.from(file.content, "base64"), file.mode || 0o600);
        written += 1;
      }
      if (provider === "claude" && "claudeHooks" in bundle) {
        const settingsFile = this.abs(scope.claudeSettings!);
        const current = this.readClaudeSettings() ?? {};
        const next = { ...current };
        if (bundle.claudeHooks === null || bundle.claudeHooks === undefined) delete next.hooks;
        else next.hooks = bundle.claudeHooks;
        if (JSON.stringify(next) !== JSON.stringify(current)) {
          const mode = lstat(settingsFile)?.mode ?? 0o600;
          writeAtomic(settingsFile, Buffer.from(`${JSON.stringify(next, null, 2)}\n`), mode);
          written += 1;
        }
      }
    }
    return { backup, written, removed, skipped, warnings };
  }

  // 선택 공급자의 현재 설정을 백업 파일로 저장한다. 오래된 백업은 최근 MAX_BACKUPS개만 남긴다.
  createBackup(providers: SettingsProvider[], reason: ProviderSettingsBackupMeta["reason"]): ProviderSettingsBackupMeta {
    const bundle = this.exportBundle(providers);
    // 최신순 정렬이 흔들리지 않게 직전 백업과 같은 밀리초면 1ms 뒤로 민다(복원 직전 백업이 연달아 생김).
    const latest = this.listBackups()[0]?.createdAt;
    const now = Date.now();
    const createdAt = new Date(latest && Date.parse(latest) >= now ? Date.parse(latest) + 1 : now).toISOString();
    const meta: ProviderSettingsBackupMeta = {
      id: `${createdAt.replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`,
      createdAt, reason, providers,
      fileCount: bundle.files.length,
      bytes: bundle.files.reduce((sum, file) => sum + Buffer.byteLength(file.content, "base64"), 0),
    };
    fs.mkdirSync(this.backupRoot, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(this.backupRoot, `${meta.id}.json`), JSON.stringify({ meta, bundle }), { mode: 0o600, flag: "wx" });
    for (const old of this.listBackups().slice(MAX_BACKUPS)) this.deleteBackup(old.id);
    return meta;
  }

  // 백업 목록(최신순). 메타데이터만 돌려준다.
  listBackups(): ProviderSettingsBackupMeta[] {
    if (!fs.existsSync(this.backupRoot)) return [];
    return fs.readdirSync(this.backupRoot).filter((name) => name.endsWith(".json")).flatMap((name) => {
      try { return [(JSON.parse(fs.readFileSync(path.join(this.backupRoot, name), "utf8")) as { meta: ProviderSettingsBackupMeta }).meta]; }
      catch { return []; }
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private backupFile(id: string): string {
    if (!/^[0-9A-Za-z-]{8,80}$/.test(id)) throw Object.assign(new Error("백업 ID가 올바르지 않습니다."), { statusCode: 400 });
    const file = path.join(this.backupRoot, `${id}.json`);
    if (!fs.existsSync(file)) throw Object.assign(new Error("백업을 찾을 수 없습니다."), { statusCode: 404 });
    return file;
  }

  // 백업 시점으로 되돌린다. 복원 직전 상태도 자동 백업한다.
  restore(id: string): ReturnType<ProviderSettingsService["apply"]> {
    const { bundle } = JSON.parse(fs.readFileSync(this.backupFile(id), "utf8")) as { bundle: ProviderSettingsBundle };
    return this.apply(bundle, "before-restore");
  }

  deleteBackup(id: string): void {
    fs.unlinkSync(this.backupFile(id));
  }
}
