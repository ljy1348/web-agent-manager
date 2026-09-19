import path from "node:path";
import fs from "node:fs";
import os from "node:os";

export interface AppConfig {
  rootDir: string;
  dataDir: string;
  homeDir: string;
  projectsDir?: string;
  host: string;
  port: number;
  publicUrl: string;
  allowedRoots: string[];
  trustedNetworks?: string[];
  trustedProxies?: string[];
  sessionTtlHours: number;
  sessionIdleMinutes?: number;
  reauthenticationWindowMinutes?: number;
  allowInsecureHttp?: boolean;
  runtimeEnabled: boolean;
  taskLedgerEnabled?: boolean;
  codexAppServerShadowEnabled?: boolean;
  codexInteractiveTransportCandidateEnabled?: boolean;
  codexInteractiveTransportCandidateCohort?: string;
  codexInteractiveTransportMaxNewChats?: number;
  verificationArtifactRetentionDays?: number;
  providerCanaryHarnessDir?: string;
  providerCanaryCredentialsDir?: string;
  providerCandidateCliDir?: string;
  previewBrowserExecutable?: string;
  sshExecutable?: string;
  slack: {
    botToken?: string;
    userToken?: string;
    channelId?: string;
  };
  ntfy: {
    topic?: string;
    serverUrl: string;
  };
  fcm?: {
    enabled: boolean;
    projectId?: string;
  };
}

// 새 제품 환경변수를 우선하고 기존 MyAgent 변수는 업그레이드 호환값으로 읽는다.
export function readProductEnv(suffix: string): string | undefined {
  return process.env[`WEB_AGENT_MANAGER_${suffix}`] ?? process.env[`MYAGENT_${suffix}`];
}

// web-agent-manager 설치 경로(rootDir)에서 "/home/계정" 부분을 뽑아 설치 계정의 홈을 구한다. systemd 등으로
// root 권한으로 프로세스를 띄우는 배포가 흔해 os.homedir()(프로세스 실행 계정의 홈, 예: /root)은
// 실제 설치 계정의 홈과 다를 수 있어 신뢰할 수 없다 — 대신 코드가 실제로 놓인 경로에서 역산한다.
export function resolveHomeDir(rootDir: string): string {
  const match = rootDir.match(/^(\/home\/[^/]+)/);
  return match ? match[1] : os.homedir();
}

// 쉼표로 구분된 허용 루트를 절대 경로로 정규화한다. 미설정 시 특정 홈 디렉터리로 제한하지 않고
// 파일시스템 전체("/")를 기본 허용 루트로 삼는다 — 관리자만 프로젝트를 등록할 수 있으므로(requireAdmin)
// 홈 디렉터리 밖(예: /home/test처럼 다른 계정 폴더)도 매번 WEB_AGENT_MANAGER_ALLOWED_ROOTS를 설정하지 않고 바로
// 추가할 수 있어야 한다. 특정 경로로 좁히고 싶으면 WEB_AGENT_MANAGER_ALLOWED_ROOTS를 명시적으로 설정하면 된다.
export function parseAllowedRoots(value: string | undefined): string[] {
  const roots = value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
  return (roots.length ? roots : ["/"]).map((root) => path.resolve(root));
}

// 쉼표로 구분된 프록시·네트워크 설정을 공백 없이 배열로 변환한다.
export function parseList(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

// 환경변수에서 애플리케이션 설정을 구성한다.
export function loadConfig(): AppConfig {
  const rootDir = process.cwd();
  const homeDir = resolveHomeDir(rootDir);
  const dataDir = path.resolve(readProductEnv("DATA_DIR") ?? path.join(rootDir, "data"));
  const projectsDir = path.resolve(readProductEnv("PROJECTS_DIR") ?? path.join(homeDir, "Projects"));
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(projectsDir, { recursive: true });
  const port = Number.parseInt(readProductEnv("PORT") ?? "4317", 10);
  const host = readProductEnv("HOST") ?? "127.0.0.1";

  return {
    rootDir,
    dataDir,
    homeDir,
    projectsDir,
    host,
    port,
    publicUrl: readProductEnv("PUBLIC_URL") ?? `http://${host}:${port}`,
    allowedRoots: parseAllowedRoots(readProductEnv("ALLOWED_ROOTS")),
    trustedNetworks: parseList(readProductEnv("TRUSTED_NETWORKS")),
    trustedProxies: parseList(readProductEnv("TRUSTED_PROXIES")),
    sessionTtlHours: Number.parseInt(readProductEnv("SESSION_TTL_HOURS") ?? "168", 10),
    sessionIdleMinutes: Math.min(10_080, Math.max(5, Number.parseInt(readProductEnv("SESSION_IDLE_MINUTES") ?? "720", 10) || 720)),
    reauthenticationWindowMinutes: Math.min(60, Math.max(1, Number.parseInt(readProductEnv("REAUTH_WINDOW_MINUTES") ?? "15", 10) || 15)),
    allowInsecureHttp: readProductEnv("ALLOW_INSECURE_HTTP") === "1",
    runtimeEnabled: readProductEnv("DISABLE_RUNTIME") !== "1",
    taskLedgerEnabled: readProductEnv("TASK_LEDGER_V1") !== "0",
    codexAppServerShadowEnabled: readProductEnv("CODEX_APP_SERVER_SHADOW") === "1",
    codexInteractiveTransportCandidateEnabled: readProductEnv("CODEX_INTERACTIVE_TRANSPORT_CANDIDATE") === "1",
    codexInteractiveTransportCandidateCohort: readProductEnv("CODEX_INTERACTIVE_TRANSPORT_COHORT")?.trim() || undefined,
    codexInteractiveTransportMaxNewChats: Math.min(20, Math.max(0, Number.parseInt(readProductEnv("CODEX_INTERACTIVE_TRANSPORT_MAX_NEW_CHATS") ?? "0", 10) || 0)),
    verificationArtifactRetentionDays: Math.max(1, Number.parseInt(readProductEnv("VERIFICATION_ARTIFACT_RETENTION_DAYS") ?? "30", 10) || 30),
    providerCanaryHarnessDir: readProductEnv("PROVIDER_CANARY_HARNESS_DIR") ? path.resolve(readProductEnv("PROVIDER_CANARY_HARNESS_DIR")!) : undefined,
    providerCanaryCredentialsDir: readProductEnv("PROVIDER_CANARY_CREDENTIALS_DIR") ? path.resolve(readProductEnv("PROVIDER_CANARY_CREDENTIALS_DIR")!) : undefined,
    providerCandidateCliDir: readProductEnv("PROVIDER_CANDIDATE_CLI_DIR") ? path.resolve(readProductEnv("PROVIDER_CANDIDATE_CLI_DIR")!) : undefined,
    previewBrowserExecutable: readProductEnv("PREVIEW_BROWSER_EXECUTABLE") ? path.resolve(readProductEnv("PREVIEW_BROWSER_EXECUTABLE")!) : undefined,
    sshExecutable: readProductEnv("SSH_EXECUTABLE") ? path.resolve(readProductEnv("SSH_EXECUTABLE")!) : undefined,
    slack: {
      botToken: process.env.SLACK_BOT_TOKEN,
      userToken: process.env.SLACK_USER_TOKEN,
      channelId: process.env.SLACK_CHANNEL_ID,
    },
    ntfy: {
      topic: process.env.NTFY_TOPIC,
      serverUrl: process.env.NTFY_SERVER_URL || "https://ntfy.sh",
    },
    fcm: {
      enabled: readProductEnv("FCM_ENABLED") === "1",
      projectId: readProductEnv("FCM_PROJECT_ID"),
    },
  };
}
