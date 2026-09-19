import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../core/config";

export interface RuntimeFiles {
  hookToken: string;
  claudeSettingsFile: string;
  hookEnvironment: Record<string, string>;
  // WAM Codex 채팅 실행에만 붙이는 훅 주입 인자(`-c hooks.*=...`). 신뢰 우회 플래그는 어댑터가 함께 붙인다.
  codexHookArgs: string[];
  // Grok 전역 훅 파일 내용(#96). 설치는 installGrokHooks가 서버 시작 시에만 한다.
  grokHooks: { hooks: Record<string, unknown[]> };
}

// Grok 전역 훅 파일 이름. 이 파일만 WAM이 관리한다.
export const GROK_HOOK_FILE = "web-agent-manager.json";

// Grok 전역 훅을 `<grokHome>/hooks/`에 설치한다(#96). 신뢰 절차 없이 로드되는 곳은 전역뿐이라 이
// 계정의 모든 Grok 세션이 읽지만, 브리지가 채팅 ID 환경변수 없는 세션에서는 아무것도 하지 않는다.
// 내용이 같으면 다시 쓰지 않는다.
// TODO(Grok 추가 계정): GROK_HOME을 쓰는 추가 계정 슬롯에는 설치하지 않는다. 계정별 Grok 채팅이 생기면
// 계정 설정 디렉터리마다 설치하도록 넓힌다.
export function installGrokHooks(grokHooks: RuntimeFiles["grokHooks"], grokHome: string): string {
  const directory = path.join(grokHome, "hooks");
  const file = path.join(directory, GROK_HOOK_FILE);
  const content = `${JSON.stringify(grokHooks, null, 2)}\n`;
  fs.mkdirSync(directory, { recursive: true });
  let current: string | null = null;
  try {
    current = fs.readFileSync(file, "utf8");
  } catch {
    current = null;
  }
  if (current !== content) fs.writeFileSync(file, content, { mode: 0o600 });
  return file;
}

// 앱 내부 훅 인증 토큰을 처음 한 번만 생성하고 권한을 제한한다.
function loadOrCreateHookToken(dataDir: string): string {
  const file = path.join(dataDir, "hook-token");
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString("base64url"), { mode: 0o600, flag: "wx" });
  return fs.readFileSync(file, "utf8").trim();
}

// scripts/의 훅 브리지를 운영에서는 빌드 산출물로, 개발에서는 tsx로 실행하는 명령을 만든다.
function bridgeCommand(config: AppConfig, scriptName: string, args: string[] = []): string {
  const script = process.env.NODE_ENV === "production"
    ? `${process.execPath} ${JSON.stringify(path.join(config.rootDir, "dist", "server", "scripts", `${scriptName}.js`))}`
    : `${path.join(config.rootDir, "node_modules", ".bin", "tsx")} ${JSON.stringify(path.join(config.rootDir, "scripts", `${scriptName}.ts`))}`;
  return [script, ...args.map((arg) => JSON.stringify(arg))].join(" ");
}

// Codex `-c`로 넘길 훅 설정 한 줄을 만든다. 값은 TOML 인라인 배열이며 명령 문자열은 JSON 문자열 규칙으로
// 이스케이프한다(TOML 기본 문자열과 호환).
function codexHookArg(event: string, command: string, options: { async?: boolean; timeout: number }): string {
  const handler = [`type="command"`, `command=${JSON.stringify(command)}`, `timeout=${options.timeout}`, ...(options.async ? ["async=true"] : [])];
  return `hooks.${event}=[{hooks=[{${handler.join(",")}}]}]`;
}

// Claude·Codex 웹 채팅 훅(승인 브리지·관찰 훅)의 런타임 설정을 만든다.
export function prepareRuntimeFiles(config: AppConfig): RuntimeFiles {
  const hookToken = loadOrCreateHookToken(config.dataDir);
  const claudeEventUrl = `http://127.0.0.1:${config.port}/internal/claude/hook-event`;
  const codexEventUrl = `http://127.0.0.1:${config.port}/internal/codex/hook-event`;
  // 관찰 훅은 프로세스를 띄우지 않는 HTTP 훅이다. 실패는 Claude가 non-blocking 오류로 넘겨 작업을 막지
  // 않는다. Claude는 자격증명처럼 보이는 환경변수를 헤더에 치환하지 않으므로 토큰은 0600인 이 파일에
  // 직접 두고, 채팅 ID만 allowedEnvVars로 치환한다.
  const eventHook = {
    type: "http",
    url: claudeEventUrl,
    timeout: 5,
    headers: { Authorization: `Bearer ${hookToken}`, "X-WAM-Chat-Id": "$WEB_AGENT_MANAGER_CHAT_ID" },
    allowedEnvVars: ["WEB_AGENT_MANAGER_CHAT_ID"],
  };
  // SessionStart는 Claude가 HTTP 훅을 건너뛰어(실측 "HTTP hooks are not supported for SessionStart")
  // command 브리지로 받는다. /clear 뒤 새 session ID로 채팅을 옮기는 데 쓴다(#91).
  const eventBridge = (url: string) => bridgeCommand(config, "hook-event-bridge", [url]);
  const claudeSettingsFile = path.join(config.dataDir, "claude-web-settings.json");
  fs.writeFileSync(claudeSettingsFile, JSON.stringify({
    hooks: {
      PermissionRequest: [{ hooks: [{ type: "command", command: bridgeCommand(config, "claude-permission-bridge"), timeout: 600 }] }],
      UserPromptSubmit: [{ hooks: [eventHook] }],
      Stop: [{ hooks: [eventHook] }],
      StopFailure: [{ hooks: [eventHook] }],
      SessionStart: [{ hooks: [{ type: "command", command: eventBridge(claudeEventUrl), timeout: 10 }] }],
    },
  }, null, 2), { mode: 0o600 });
  // Codex는 HTTP 훅이 없어 command 브리지를 쓴다. SessionStart는 첫 기록보다 먼저 채팅에 session ID를
  // 붙여야 하므로 동기로, 턴 이벤트는 매 턴 프로세스 기동 지연이 입력을 막지 않게 async로 둔다(#92).
  // PermissionRequest는 사람 결정을 기다려야 해 동기이며, 서버의 9분 대기보다 길게 둔다(#95).
  const codexPermissionUrl = `http://127.0.0.1:${config.port}/internal/codex/permission`;
  const codexHookArgs = [
    codexHookArg("SessionStart", eventBridge(codexEventUrl), { timeout: 10 }),
    codexHookArg("PermissionRequest", bridgeCommand(config, "claude-permission-bridge", [codexPermissionUrl]), { timeout: 600 }),
    codexHookArg("UserPromptSubmit", eventBridge(codexEventUrl), { async: true, timeout: 10 }),
    codexHookArg("Stop", eventBridge(codexEventUrl), { async: true, timeout: 10 }),
  ].flatMap((value) => ["-c", value]);
  // Grok HTTP 훅은 헤더가 없어 토큰·채팅 ID를 URL에 실어야 하므로 command 브리지를 쓴다. 입력에는
  // snake_case hook_event_name·session_id가 함께 오고 턴 ID만 camelCase promptId로 온다(실측).
  const grokEventHook = { hooks: [{ type: "command", command: eventBridge(`http://127.0.0.1:${config.port}/internal/grok/hook-event`), timeout: 10 }] };
  const grokHooks = { hooks: Object.fromEntries(["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "StopCancelled"].map((event) => [event, [grokEventHook]])) };
  return {
    hookToken,
    claudeSettingsFile,
    hookEnvironment: {
      WEB_AGENT_MANAGER_HOOK_URL: `http://127.0.0.1:${config.port}/internal/claude/permission`,
      WEB_AGENT_MANAGER_HOOK_TOKEN: hookToken,
    },
    codexHookArgs,
    grokHooks,
  };
}
