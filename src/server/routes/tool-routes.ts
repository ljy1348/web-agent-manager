import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Router } from "express";
import type { AppDatabase } from "../core/database";
import { requireAdmin, type AuthenticatedRequest } from "../core/auth";
import { requireTrustedNetwork } from "../core/network";
import { writeAudit } from "../core/audit";
import { resolveProjectPath } from "./helpers";
import type { Provider } from "../../shared/types";

type ToolKind = "commands" | "skills" | "marketplace" | "mcp";
type ToolStatus = "active" | "disabled" | "needs_auth" | "error" | "incompatible" | "not_installed";
type ToolScope = "builtin" | "project" | "user" | "local" | "global" | "marketplace";

interface ToolItem {
  id: string;
  provider: Provider;
  kind: ToolKind;
  name: string;
  label: string;
  description: string;
  status: ToolStatus;
  scope: ToolScope;
  source: string;
  command?: string;
  template?: string;
  details?: Record<string, unknown>;
}

interface McpInput {
  provider: Provider;
  projectId?: number;
  name: string;
  transport: "stdio" | "http" | "sse" | "ws";
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  enabled?: boolean;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

const MCP_NAME_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const execFileAsync = promisify(execFile);
const CLI_MCP_CACHE_MS = 60_000;
const CLI_MCP_ERROR_CACHE_MS = 10_000;
const cliMcpCache = new Map<string, { expiresAt: number; items?: ToolItem[]; promise?: Promise<ToolItem[]> }>();

const BUILTIN_COMMANDS: ToolItem[] = [
  { id: "claude:command:model", provider: "claude", kind: "commands", name: "/model", label: "/model", description: "모델과 추론 강도를 선택합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/model", template: "/model" },
  { id: "claude:command:mcp", provider: "claude", kind: "commands", name: "/mcp", label: "/mcp", description: "Claude Code MCP 서버 상태와 인증을 확인합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/mcp", template: "/mcp" },
  { id: "claude:command:agents", provider: "claude", kind: "commands", name: "/agents", label: "/agents", description: "Claude Code 서브에이전트 목록과 설정을 엽니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/agents", template: "/agents" },
  { id: "claude:command:compact", provider: "claude", kind: "commands", name: "/compact", label: "/compact", description: "현재 대화를 압축해 컨텍스트를 정리합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/compact", template: "/compact" },
  { id: "claude:command:rename", provider: "claude", kind: "commands", name: "/rename", label: "/rename", description: "세션 표시 이름을 변경합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/rename", template: "/rename " },
  { id: "claude:command:exit", provider: "claude", kind: "commands", name: "/exit", label: "/exit", description: "Claude Code 세션을 종료합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/exit", template: "/exit" },
  { id: "claude:command:add-dir", provider: "claude", kind: "commands", name: "/add-dir", label: "/add-dir", description: "현재 세션에 작업 디렉터리 접근 권한을 추가합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/add-dir", template: "/add-dir " },
  { id: "claude:command:advisor", provider: "claude", kind: "commands", name: "/advisor", label: "/advisor", description: "보조 모델 advisor 도구를 켜거나 끕니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/advisor", template: "/advisor " },
  { id: "claude:command:autofix-pr", provider: "claude", kind: "commands", name: "/autofix-pr", label: "/autofix-pr", description: "현재 PR의 CI/리뷰 댓글을 고치는 웹 세션을 시작합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/autofix-pr", template: "/autofix-pr " },
  { id: "claude:command:background", provider: "claude", kind: "commands", name: "/background", label: "/background", description: "현재 세션을 백그라운드 에이전트로 분리합니다. Alias: /bg", status: "active", scope: "builtin", source: "Claude Code", command: "/background", template: "/background " },
  { id: "claude:command:branch", provider: "claude", kind: "commands", name: "/branch", label: "/branch", description: "현재 대화 지점에서 새 conversation branch를 만듭니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/branch", template: "/branch " },
  { id: "claude:command:btw", provider: "claude", kind: "commands", name: "/btw", label: "/btw", description: "대화 기록에 크게 남기지 않는 빠른 사이드 질문을 합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/btw", template: "/btw " },
  { id: "claude:command:cd", provider: "claude", kind: "commands", name: "/cd", label: "/cd", description: "세션의 작업 디렉터리를 이동합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/cd", template: "/cd " },
  { id: "claude:command:chrome", provider: "claude", kind: "commands", name: "/chrome", label: "/chrome", description: "Claude in Chrome 설정을 구성합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/chrome", template: "/chrome" },
  { id: "claude:command:clear", provider: "claude", kind: "commands", name: "/clear", label: "/clear", description: "새 대화를 시작합니다. Alias: /reset, /new", status: "active", scope: "builtin", source: "Claude Code", command: "/clear", template: "/clear" },
  { id: "claude:command:color", provider: "claude", kind: "commands", name: "/color", label: "/color", description: "현재 세션의 prompt bar 색상을 바꿉니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/color", template: "/color " },
  { id: "claude:command:config", provider: "claude", kind: "commands", name: "/config", label: "/config", description: "설정 화면을 열거나 key=value 설정을 적용합니다. Alias: /settings", status: "active", scope: "builtin", source: "Claude Code", command: "/config", template: "/config" },
  { id: "claude:command:context", provider: "claude", kind: "commands", name: "/context", label: "/context", description: "현재 컨텍스트 사용량을 시각화합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/context", template: "/context" },
  { id: "claude:command:copy", provider: "claude", kind: "commands", name: "/copy", label: "/copy", description: "최근 assistant 응답을 클립보드로 복사합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/copy", template: "/copy" },
  { id: "claude:command:cost", provider: "claude", kind: "commands", name: "/cost", label: "/cost", description: "사용량 정보를 봅니다. Alias for /usage", status: "active", scope: "builtin", source: "Claude Code", command: "/cost", template: "/cost" },
  { id: "claude:command:desktop", provider: "claude", kind: "commands", name: "/desktop", label: "/desktop", description: "현재 세션을 Claude Code Desktop 앱에서 계속합니다. Alias: /app", status: "active", scope: "builtin", source: "Claude Code", command: "/desktop", template: "/desktop" },
  { id: "claude:command:diff", provider: "claude", kind: "commands", name: "/diff", label: "/diff", description: "현재 git diff와 turn별 diff viewer를 엽니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/diff", template: "/diff" },
  { id: "claude:command:effort", provider: "claude", kind: "commands", name: "/effort", label: "/effort", description: "추론 강도를 low/medium/high/xhigh/max/auto로 바꿉니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/effort", template: "/effort " },
  { id: "claude:command:export", provider: "claude", kind: "commands", name: "/export", label: "/export", description: "현재 대화를 텍스트로 내보냅니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/export", template: "/export " },
  { id: "claude:command:fast", provider: "claude", kind: "commands", name: "/fast", label: "/fast", description: "fast mode를 켜거나 끕니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/fast", template: "/fast " },
  { id: "claude:command:feedback", provider: "claude", kind: "commands", name: "/feedback", label: "/feedback", description: "피드백이나 버그 리포트를 보냅니다. Alias: /bug, /share", status: "active", scope: "builtin", source: "Claude Code", command: "/feedback", template: "/feedback " },
  { id: "claude:command:focus", provider: "claude", kind: "commands", name: "/focus", label: "/focus", description: "마지막 프롬프트와 요약 중심의 focus view를 전환합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/focus", template: "/focus" },
  { id: "claude:command:fork", provider: "claude", kind: "commands", name: "/fork", label: "/fork", description: "현재 대화를 상속한 forked background subagent를 시작합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/fork", template: "/fork " },
  { id: "claude:command:goal", provider: "claude", kind: "commands", name: "/goal", label: "/goal", description: "목표 조건을 설정하거나 지웁니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/goal", template: "/goal " },
  { id: "claude:command:heapdump", provider: "claude", kind: "commands", name: "/heapdump", label: "/heapdump", description: "메모리 진단용 heap snapshot을 기록합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/heapdump", template: "/heapdump" },
  { id: "claude:command:help", provider: "claude", kind: "commands", name: "/help", label: "/help", description: "도움말과 사용 가능한 명령어를 표시합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/help", template: "/help" },
  { id: "claude:command:hooks", provider: "claude", kind: "commands", name: "/hooks", label: "/hooks", description: "Claude Code hook 구성을 봅니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/hooks", template: "/hooks" },
  { id: "claude:command:ide", provider: "claude", kind: "commands", name: "/ide", label: "/ide", description: "IDE integration 상태와 설정을 관리합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/ide", template: "/ide" },
  { id: "claude:command:init", provider: "claude", kind: "commands", name: "/init", label: "/init", description: "프로젝트 CLAUDE.md 가이드를 초기화합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/init", template: "/init" },
  { id: "claude:command:insights", provider: "claude", kind: "commands", name: "/insights", label: "/insights", description: "Claude Code 세션 사용 패턴 리포트를 생성합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/insights", template: "/insights" },
  { id: "claude:command:install-github-app", provider: "claude", kind: "commands", name: "/install-github-app", label: "/install-github-app", description: "저장소에 Claude GitHub App을 설치합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/install-github-app", template: "/install-github-app" },
  { id: "claude:command:install-slack-app", provider: "claude", kind: "commands", name: "/install-slack-app", label: "/install-slack-app", description: "Claude Slack app 설치 OAuth 흐름을 시작합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/install-slack-app", template: "/install-slack-app" },
  { id: "claude:command:keybindings", provider: "claude", kind: "commands", name: "/keybindings", label: "/keybindings", description: "키보드 단축키 파일을 엽니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/keybindings", template: "/keybindings" },
  { id: "claude:command:login", provider: "claude", kind: "commands", name: "/login", label: "/login", description: "Anthropic 계정에 로그인합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/login", template: "/login" },
  { id: "claude:command:logout", provider: "claude", kind: "commands", name: "/logout", label: "/logout", description: "Anthropic 계정에서 로그아웃합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/logout", template: "/logout" },
  { id: "claude:command:memory", provider: "claude", kind: "commands", name: "/memory", label: "/memory", description: "CLAUDE.md memory 파일과 auto-memory를 관리합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/memory", template: "/memory" },
  { id: "claude:command:mobile", provider: "claude", kind: "commands", name: "/mobile", label: "/mobile", description: "Claude mobile app 다운로드 QR을 표시합니다. Alias: /ios, /android", status: "active", scope: "builtin", source: "Claude Code", command: "/mobile", template: "/mobile" },
  { id: "claude:command:passes", provider: "claude", kind: "commands", name: "/passes", label: "/passes", description: "Claude Code 무료 사용권 공유 화면을 엽니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/passes", template: "/passes" },
  { id: "claude:command:permissions", provider: "claude", kind: "commands", name: "/permissions", label: "/permissions", description: "도구 권한 allow/ask/deny 규칙을 관리합니다. Alias: /allowed-tools", status: "active", scope: "builtin", source: "Claude Code", command: "/permissions", template: "/permissions" },
  { id: "claude:command:plan", provider: "claude", kind: "commands", name: "/plan", label: "/plan", description: "Plan mode로 들어갑니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/plan", template: "/plan " },
  { id: "claude:command:plugin", provider: "claude", kind: "commands", name: "/plugin", label: "/plugin", description: "Claude Code plugin을 list/install/enable/disable 합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/plugin", template: "/plugin" },
  { id: "claude:command:powerup", provider: "claude", kind: "commands", name: "/powerup", label: "/powerup", description: "Claude Code 기능 학습 데모를 엽니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/powerup", template: "/powerup" },
  { id: "claude:command:privacy-settings", provider: "claude", kind: "commands", name: "/privacy-settings", label: "/privacy-settings", description: "프라이버시 설정을 확인하거나 바꿉니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/privacy-settings", template: "/privacy-settings" },
  { id: "claude:command:radio", provider: "claude", kind: "commands", name: "/radio", label: "/radio", description: "Claude FM 라디오 URL을 엽니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/radio", template: "/radio" },
  { id: "claude:command:recap", provider: "claude", kind: "commands", name: "/recap", label: "/recap", description: "현재 세션을 한 줄로 요약합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/recap", template: "/recap" },
  { id: "claude:command:release-notes", provider: "claude", kind: "commands", name: "/release-notes", label: "/release-notes", description: "Claude Code changelog를 봅니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/release-notes", template: "/release-notes" },
  { id: "claude:command:reload-plugins", provider: "claude", kind: "commands", name: "/reload-plugins", label: "/reload-plugins", description: "활성 plugin을 다시 로드합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/reload-plugins", template: "/reload-plugins" },
  { id: "claude:command:reload-skills", provider: "claude", kind: "commands", name: "/reload-skills", label: "/reload-skills", description: "skill/command 디렉터리를 다시 스캔합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/reload-skills", template: "/reload-skills" },
  { id: "claude:command:remote-control", provider: "claude", kind: "commands", name: "/remote-control", label: "/remote-control", description: "claude.ai remote control에서 세션을 이어갈 수 있게 합니다. Alias: /rc", status: "active", scope: "builtin", source: "Claude Code", command: "/remote-control", template: "/remote-control" },
  { id: "claude:command:remote-env", provider: "claude", kind: "commands", name: "/remote-env", label: "/remote-env", description: "Cloud agent 기본 실행 환경을 선택합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/remote-env", template: "/remote-env" },
  { id: "claude:command:resume", provider: "claude", kind: "commands", name: "/resume", label: "/resume", description: "이전 대화를 재개합니다. Alias: /continue", status: "active", scope: "builtin", source: "Claude Code", command: "/resume", template: "/resume " },
  { id: "claude:command:review", provider: "claude", kind: "commands", name: "/review", label: "/review", description: "GitHub PR에 대한 빠른 read-only 리뷰를 실행합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/review", template: "/review " },
  { id: "claude:command:rewind", provider: "claude", kind: "commands", name: "/rewind", label: "/rewind", description: "대화나 코드를 이전 checkpoint로 되돌립니다. Alias: /checkpoint, /undo", status: "active", scope: "builtin", source: "Claude Code", command: "/rewind", template: "/rewind" },
  { id: "claude:command:sandbox", provider: "claude", kind: "commands", name: "/sandbox", label: "/sandbox", description: "지원 플랫폼에서 sandbox mode를 전환합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/sandbox", template: "/sandbox" },
  { id: "claude:command:schedule", provider: "claude", kind: "commands", name: "/schedule", label: "/schedule", description: "Anthropic-managed routines를 만들거나 실행합니다. Alias: /routines", status: "active", scope: "builtin", source: "Claude Code", command: "/schedule", template: "/schedule " },
  { id: "claude:command:scroll-speed", provider: "claude", kind: "commands", name: "/scroll-speed", label: "/scroll-speed", description: "마우스 휠 스크롤 속도를 조정합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/scroll-speed", template: "/scroll-speed" },
  { id: "claude:command:setup-bedrock", provider: "claude", kind: "commands", name: "/setup-bedrock", label: "/setup-bedrock", description: "Amazon Bedrock 인증과 모델 설정을 구성합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/setup-bedrock", template: "/setup-bedrock" },
  { id: "claude:command:setup-vertex", provider: "claude", kind: "commands", name: "/setup-vertex", label: "/setup-vertex", description: "Google Cloud Vertex 인증과 모델 설정을 구성합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/setup-vertex", template: "/setup-vertex" },
  { id: "claude:command:skills", provider: "claude", kind: "commands", name: "/skills", label: "/skills", description: "사용 가능한 skills를 목록/필터/정렬하고 visibility를 조정합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/skills", template: "/skills" },
  { id: "claude:command:stats", provider: "claude", kind: "commands", name: "/stats", label: "/stats", description: "사용량 통계를 엽니다. Alias for /usage", status: "active", scope: "builtin", source: "Claude Code", command: "/stats", template: "/stats" },
  { id: "claude:command:status", provider: "claude", kind: "commands", name: "/status", label: "/status", description: "설정 화면의 Status 탭을 엽니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/status", template: "/status" },
  { id: "claude:command:statusline", provider: "claude", kind: "commands", name: "/statusline", label: "/statusline", description: "Claude Code status line을 구성합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/statusline", template: "/statusline " },
  { id: "claude:command:stickers", provider: "claude", kind: "commands", name: "/stickers", label: "/stickers", description: "Claude Code stickers 주문 화면을 엽니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/stickers", template: "/stickers" },
  { id: "claude:command:stop", provider: "claude", kind: "commands", name: "/stop", label: "/stop", description: "attached background session을 멈춥니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/stop", template: "/stop" },
  { id: "claude:command:tasks", provider: "claude", kind: "commands", name: "/tasks", label: "/tasks", description: "백그라운드에서 실행 중인 작업을 봅니다. Alias: /bashes", status: "active", scope: "builtin", source: "Claude Code", command: "/tasks", template: "/tasks" },
  { id: "claude:command:team-onboarding", provider: "claude", kind: "commands", name: "/team-onboarding", label: "/team-onboarding", description: "팀 온보딩 가이드를 생성합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/team-onboarding", template: "/team-onboarding" },
  { id: "claude:command:teleport", provider: "claude", kind: "commands", name: "/teleport", label: "/teleport", description: "Claude Code web 세션을 터미널로 가져옵니다. Alias: /tp", status: "active", scope: "builtin", source: "Claude Code", command: "/teleport", template: "/teleport" },
  { id: "claude:command:terminal-setup", provider: "claude", kind: "commands", name: "/terminal-setup", label: "/terminal-setup", description: "Shift+Enter 등 터미널 키 바인딩을 구성합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/terminal-setup", template: "/terminal-setup" },
  { id: "claude:command:theme", provider: "claude", kind: "commands", name: "/theme", label: "/theme", description: "Claude Code 색상 테마를 바꿉니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/theme", template: "/theme " },
  { id: "claude:command:tui", provider: "claude", kind: "commands", name: "/tui", label: "/tui", description: "terminal UI renderer를 변경하고 재실행합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/tui", template: "/tui " },
  { id: "claude:command:ultraplan", provider: "claude", kind: "commands", name: "/ultraplan", label: "/ultraplan", description: "브라우저에서 검토 가능한 큰 계획을 작성합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/ultraplan", template: "/ultraplan " },
  { id: "claude:command:ultrareview", provider: "claude", kind: "commands", name: "/ultrareview", label: "/ultrareview", description: "Cloud sandbox에서 deep multi-agent review를 실행합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/ultrareview", template: "/ultrareview " },
  { id: "claude:command:upgrade", provider: "claude", kind: "commands", name: "/upgrade", label: "/upgrade", description: "상위 plan upgrade 페이지를 엽니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/upgrade", template: "/upgrade" },
  { id: "claude:command:usage", provider: "claude", kind: "commands", name: "/usage", label: "/usage", description: "세션 비용, plan usage, activity stats를 표시합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/usage", template: "/usage" },
  { id: "claude:command:usage-credits", provider: "claude", kind: "commands", name: "/usage-credits", label: "/usage-credits", description: "한도 도달 시 사용할 usage credits를 구성합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/usage-credits", template: "/usage-credits" },
  { id: "claude:command:voice", provider: "claude", kind: "commands", name: "/voice", label: "/voice", description: "voice dictation mode를 바꿉니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/voice", template: "/voice " },
  { id: "claude:command:web-setup", provider: "claude", kind: "commands", name: "/web-setup", label: "/web-setup", description: "로컬 gh 인증으로 Claude Code on the web GitHub 연결을 설정합니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/web-setup", template: "/web-setup" },
  { id: "claude:command:workflows", provider: "claude", kind: "commands", name: "/workflows", label: "/workflows", description: "실행 중이거나 완료된 workflow 진행 상황을 봅니다.", status: "active", scope: "builtin", source: "Claude Code", command: "/workflows", template: "/workflows" },
  { id: "grok:command:model", provider: "grok", kind: "commands", name: "/model", label: "/model", description: "모델과 추론 강도를 바꿉니다. Alias: /m", status: "active", scope: "builtin", source: "Grok CLI", command: "/model", template: "/model " },
  { id: "grok:command:new", provider: "grok", kind: "commands", name: "/new", label: "/new", description: "새 세션을 시작합니다(문맥 초기화).", status: "active", scope: "builtin", source: "Grok CLI", command: "/new", template: "/new" },
  { id: "grok:command:load", provider: "grok", kind: "commands", name: "/load", label: "/load", description: "이전 세션을 불러옵니다. Alias: /resume", status: "active", scope: "builtin", source: "Grok CLI", command: "/load", template: "/load " },
  { id: "grok:command:rewind", provider: "grok", kind: "commands", name: "/rewind", label: "/rewind", description: "이전 프롬프트 시점으로 되돌리고 파일도 복원합니다.", status: "active", scope: "builtin", source: "Grok CLI", command: "/rewind", template: "/rewind " },
  { id: "grok:command:compact", provider: "grok", kind: "commands", name: "/compact", label: "/compact", description: "대화 기록을 압축합니다.", status: "active", scope: "builtin", source: "Grok CLI", command: "/compact", template: "/compact " },
  { id: "grok:command:always-approve", provider: "grok", kind: "commands", name: "/always-approve", label: "/always-approve", description: "모든 도구 실행을 자동 승인하는 모드를 전환합니다. Alias: /yolo", status: "active", scope: "builtin", source: "Grok CLI", command: "/always-approve", template: "/always-approve " },
  { id: "grok:command:multiline", provider: "grok", kind: "commands", name: "/multiline", label: "/multiline", description: "여러 줄 입력 모드를 전환합니다. Alias: /ml", status: "active", scope: "builtin", source: "Grok CLI", command: "/multiline", template: "/multiline" },
  { id: "grok:command:memory", provider: "grok", kind: "commands", name: "/memory", label: "/memory", description: "메모리 파일에 내용을 덧붙입니다(메모리 기능 활성화 필요).", status: "active", scope: "builtin", source: "Grok CLI", command: "/memory", template: "/memory " },
  { id: "grok:command:flush", provider: "grok", kind: "commands", name: "/flush", label: "/flush", description: "현재 세션에서 얻은 지식을 메모리에 지금 저장합니다.", status: "active", scope: "builtin", source: "Grok CLI", command: "/flush", template: "/flush" },
  { id: "grok:command:skills", provider: "grok", kind: "commands", name: "/skills", label: "/skills", description: "스킬 목록을 보거나 스킬을 문맥에 주입합니다.", status: "active", scope: "builtin", source: "Grok CLI", command: "/skills", template: "/skills " },
  { id: "grok:command:plugins", provider: "grok", kind: "commands", name: "/plugins", label: "/plugins", description: "플러그인을 관리합니다(list, reload, trust). Alias: /plugin", status: "active", scope: "builtin", source: "Grok CLI", command: "/plugins", template: "/plugins " },
  { id: "grok:command:hooks-list", provider: "grok", kind: "commands", name: "/hooks-list", label: "/hooks-list", description: "이 세션에 로드된 훅을 표시합니다.", status: "active", scope: "builtin", source: "Grok CLI", command: "/hooks-list", template: "/hooks-list" },
  { id: "grok:command:hooks-trust", provider: "grok", kind: "commands", name: "/hooks-trust", label: "/hooks-trust", description: "이 폴더의 훅 실행을 신뢰하도록 등록합니다.", status: "active", scope: "builtin", source: "Grok CLI", command: "/hooks-trust", template: "/hooks-trust" },
  { id: "grok:command:hooks-add", provider: "grok", kind: "commands", name: "/hooks-add", label: "/hooks-add", description: "훅 파일이나 디렉터리를 추가합니다.", status: "active", scope: "builtin", source: "Grok CLI", command: "/hooks-add", template: "/hooks-add " },
  { id: "grok:command:feedback", provider: "grok", kind: "commands", name: "/feedback", label: "/feedback", description: "문제를 신고하거나 피드백을 보냅니다.", status: "active", scope: "builtin", source: "Grok CLI", command: "/feedback", template: "/feedback " },
  { id: "grok:command:exit", provider: "grok", kind: "commands", name: "/exit", label: "/exit", description: "TUI를 종료합니다. Alias: /quit", status: "active", scope: "builtin", source: "Grok CLI", command: "/exit", template: "/exit" },
  { id: "codex:command:model", provider: "codex", kind: "commands", name: "/model", label: "/model", description: "Codex CLI 모델을 선택합니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/model", template: "/model" },
  { id: "codex:command:mcp", provider: "codex", kind: "commands", name: "/mcp", label: "/mcp", description: "연결된 MCP 서버 상태를 확인합니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/mcp", template: "/mcp" },
  { id: "codex:command:plugins", provider: "codex", kind: "commands", name: "/plugins", label: "/plugins", description: "플러그인 브라우저와 marketplace 항목을 엽니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/plugins", template: "/plugins" },
  { id: "codex:command:plan", provider: "codex", kind: "commands", name: "/plan", label: "/plan", description: "계획 모드를 전환합니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/plan", template: "/plan" },
  { id: "codex:command:review", provider: "codex", kind: "commands", name: "/review", label: "/review", description: "현재 변경사항에 대한 코드 리뷰를 시작합니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/review", template: "/review" },
  { id: "codex:command:status", provider: "codex", kind: "commands", name: "/status", label: "/status", description: "Codex CLI 상태와 사용량 정보를 확인합니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/status", template: "/status" },
  { id: "codex:command:init", provider: "codex", kind: "commands", name: "/init", label: "/init", description: "프로젝트 지침 파일 생성을 돕습니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/init", template: "/init" },
  { id: "codex:command:permissions", provider: "codex", kind: "commands", name: "/permissions", label: "/permissions", description: "Codex가 묻지 않고 수행할 수 있는 작업 범위를 조정합니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/permissions", template: "/permissions" },
  { id: "codex:command:ide", provider: "codex", kind: "commands", name: "/ide", label: "/ide", description: "열린 파일, 선택 영역 등 IDE context를 다음 프롬프트에 포함합니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/ide", template: "/ide" },
  { id: "codex:command:keymap", provider: "codex", kind: "commands", name: "/keymap", label: "/keymap", description: "TUI 키보드 단축키를 확인하고 config.toml에 저장합니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/keymap", template: "/keymap" },
  { id: "codex:command:vim", provider: "codex", kind: "commands", name: "/vim", label: "/vim", description: "Composer의 Vim mode를 켜거나 끕니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/vim", template: "/vim" },
  { id: "codex:command:setup-default-sandbox", provider: "codex", kind: "commands", name: "/setup-default-sandbox", label: "/setup-default-sandbox", description: "Windows elevated agent sandbox를 설정합니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/setup-default-sandbox", template: "/setup-default-sandbox" },
  { id: "codex:command:sandbox-add-read-dir", provider: "codex", kind: "commands", name: "/sandbox-add-read-dir", label: "/sandbox-add-read-dir", description: "Windows sandbox에 추가 read directory 접근을 허용합니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/sandbox-add-read-dir", template: "/sandbox-add-read-dir " },
  { id: "codex:command:agent", provider: "codex", kind: "commands", name: "/agent", label: "/agent", description: "활성 subagent thread를 전환합니다. Alias: /subagents", status: "active", scope: "builtin", source: "Codex CLI", command: "/agent", template: "/agent" },
  { id: "codex:command:subagents", provider: "codex", kind: "commands", name: "/subagents", label: "/subagents", description: "활성 subagent thread를 전환합니다. Alias: /agent", status: "active", scope: "builtin", source: "Codex CLI", command: "/subagents", template: "/subagents" },
  { id: "codex:command:apps", provider: "codex", kind: "commands", name: "/apps", label: "/apps", description: "Apps/connectors를 탐색하고 composer에 app mention을 삽입합니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/apps", template: "/apps" },
  { id: "codex:command:hooks", provider: "codex", kind: "commands", name: "/hooks", label: "/hooks", description: "Lifecycle hooks를 확인하고 trust/disable 상태를 관리합니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/hooks", template: "/hooks" },
  { id: "codex:command:clear", provider: "codex", kind: "commands", name: "/clear", label: "/clear", description: "터미널을 지우고 새 task를 시작합니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/clear", template: "/clear" },
  { id: "codex:command:rename", provider: "codex", kind: "commands", name: "/rename", label: "/rename", description: "현재 task/session 이름을 바꿉니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/rename", template: "/rename " },
  { id: "codex:command:archive", provider: "codex", kind: "commands", name: "/archive", label: "/archive", description: "현재 session을 archive하고 Codex를 종료합니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/archive", template: "/archive" },
  { id: "codex:command:delete", provider: "codex", kind: "commands", name: "/delete", label: "/delete", description: "현재 session transcript와 descendant session을 영구 삭제합니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/delete", template: "/delete" },
  { id: "codex:command:compact", provider: "codex", kind: "commands", name: "/compact", label: "/compact", description: "대화 내용을 요약해 context token을 확보합니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/compact", template: "/compact" },
  { id: "codex:command:copy", provider: "codex", kind: "commands", name: "/copy", label: "/copy", description: "최근 완료된 Codex 응답을 복사합니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/copy", template: "/copy" },
  { id: "codex:command:diff", provider: "codex", kind: "commands", name: "/diff", label: "/diff", description: "Git diff와 untracked 변경을 확인합니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/diff", template: "/diff" },
  { id: "codex:command:exit", provider: "codex", kind: "commands", name: "/exit", label: "/exit", description: "Codex CLI를 종료합니다. Alias: /quit", status: "active", scope: "builtin", source: "Codex CLI", command: "/exit", template: "/exit" },
  { id: "codex:command:experimental", provider: "codex", kind: "commands", name: "/experimental", label: "/experimental", description: "Network proxy 등 experimental feature를 전환합니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/experimental", template: "/experimental" },
  { id: "codex:command:approve", provider: "codex", kind: "commands", name: "/approve", label: "/approve", description: "자동 리뷰가 거절한 최근 작업을 한 번 재시도하도록 승인합니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/approve", template: "/approve" },
  { id: "codex:command:memories", provider: "codex", kind: "commands", name: "/memories", label: "/memories", description: "Memory 사용과 생성 여부를 구성합니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/memories", template: "/memories" },
  { id: "codex:command:skills", provider: "codex", kind: "commands", name: "/skills", label: "/skills", description: "Codex skill을 탐색하고 다음 요청에 적용합니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/skills", template: "/skills" },
  { id: "codex:command:import", provider: "codex", kind: "commands", name: "/import", label: "/import", description: "Claude Code 설정, project files, 최근 chats를 Codex로 가져옵니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/import", template: "/import" },
  { id: "codex:command:feedback", provider: "codex", kind: "commands", name: "/feedback", label: "/feedback", description: "로그/진단을 포함해 Codex maintainers에 feedback을 보냅니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/feedback", template: "/feedback" },
  { id: "codex:command:logout", provider: "codex", kind: "commands", name: "/logout", label: "/logout", description: "현재 사용자 session의 로컬 credentials를 지웁니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/logout", template: "/logout" },
  { id: "codex:command:mention", provider: "codex", kind: "commands", name: "/mention", label: "/mention", description: "파일이나 폴더를 대화에 첨부합니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/mention", template: "/mention " },
  { id: "codex:command:fast", provider: "codex", kind: "commands", name: "/fast", label: "/fast", description: "모델 catalog가 제공하는 Fast tier를 켜거나 끕니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/fast", template: "/fast" },
  { id: "codex:command:personality", provider: "codex", kind: "commands", name: "/personality", label: "/personality", description: "friendly/pragmatic/none 등 응답 스타일을 선택합니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/personality", template: "/personality " },
  { id: "codex:command:ps", provider: "codex", kind: "commands", name: "/ps", label: "/ps", description: "Background terminals와 최근 출력을 확인합니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/ps", template: "/ps" },
  { id: "codex:command:stop", provider: "codex", kind: "commands", name: "/stop", label: "/stop", description: "현재 session에서 시작한 background terminal 작업을 멈춥니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/stop", template: "/stop" },
  { id: "codex:command:fork", provider: "codex", kind: "commands", name: "/fork", label: "/fork", description: "현재 task를 새 task로 fork합니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/fork", template: "/fork" },
  { id: "codex:command:app", provider: "codex", kind: "commands", name: "/app", label: "/app", description: "현재 session을 ChatGPT desktop app에서 계속합니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/app", template: "/app" },
  { id: "codex:command:side", provider: "codex", kind: "commands", name: "/side", label: "/side", description: "Main task를 방해하지 않는 temporary side conversation을 시작합니다. Alias: /btw", status: "active", scope: "builtin", source: "Codex CLI", command: "/side", template: "/side " },
  { id: "codex:command:btw", provider: "codex", kind: "commands", name: "/btw", label: "/btw", description: "Temporary side conversation을 시작합니다. Alias: /side", status: "active", scope: "builtin", source: "Codex CLI", command: "/btw", template: "/btw " },
  { id: "codex:command:raw", provider: "codex", kind: "commands", name: "/raw", label: "/raw", description: "Raw scrollback mode를 전환합니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/raw", template: "/raw" },
  { id: "codex:command:resume", provider: "codex", kind: "commands", name: "/resume", label: "/resume", description: "저장된 conversation을 재개합니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/resume", template: "/resume " },
  { id: "codex:command:new", provider: "codex", kind: "commands", name: "/new", label: "/new", description: "같은 CLI session 안에서 새 task를 시작합니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/new", template: "/new" },
  { id: "codex:command:quit", provider: "codex", kind: "commands", name: "/quit", label: "/quit", description: "Codex CLI를 종료합니다. Alias: /exit", status: "active", scope: "builtin", source: "Codex CLI", command: "/quit", template: "/quit" },
  { id: "codex:command:usage", provider: "codex", kind: "commands", name: "/usage", label: "/usage", description: "계정 token usage나 rate-limit reset 정보를 확인합니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/usage", template: "/usage" },
  { id: "codex:command:debug-config", provider: "codex", kind: "commands", name: "/debug-config", label: "/debug-config", description: "Config layer와 policy requirements 진단 정보를 출력합니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/debug-config", template: "/debug-config" },
  { id: "codex:command:statusline", provider: "codex", kind: "commands", name: "/statusline", label: "/statusline", description: "TUI status-line 항목을 구성합니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/statusline", template: "/statusline" },
  { id: "codex:command:title", provider: "codex", kind: "commands", name: "/title", label: "/title", description: "Terminal window/tab title 항목을 구성합니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/title", template: "/title" },
  { id: "codex:command:theme", provider: "codex", kind: "commands", name: "/theme", label: "/theme", description: "Terminal syntax highlighting theme를 선택합니다.", status: "active", scope: "builtin", source: "Codex CLI", command: "/theme", template: "/theme" },
  { id: "codex:command:pets", provider: "codex", kind: "commands", name: "/pets", label: "/pets", description: "TUI pet을 선택하거나 숨깁니다. Alias: /pet", status: "active", scope: "builtin", source: "Codex CLI", command: "/pets", template: "/pets" },
  { id: "codex:command:pet", provider: "codex", kind: "commands", name: "/pet", label: "/pet", description: "TUI pet을 선택하거나 숨깁니다. Alias: /pets", status: "active", scope: "builtin", source: "Codex CLI", command: "/pet", template: "/pet" },
];

const BUNDLED_CLAUDE_SKILLS: ToolItem[] = [
  { id: "claude:skill:bundled:batch", provider: "claude", kind: "skills", name: "batch", label: "batch", description: "대규모 변경을 독립 작업으로 나눠 병렬 실행합니다.", status: "active", scope: "builtin", source: "Claude bundled skill", command: "/batch", template: "/batch " },
  { id: "claude:skill:bundled:claude-api", provider: "claude", kind: "skills", name: "claude-api", label: "claude-api", description: "Claude API 레퍼런스와 마이그레이션 지침을 로드합니다.", status: "active", scope: "builtin", source: "Claude bundled skill", command: "/claude-api", template: "/claude-api " },
  { id: "claude:skill:bundled:code-review", provider: "claude", kind: "skills", name: "code-review", label: "code-review", description: "현재 diff나 PR을 correctness/cleanup 관점으로 리뷰합니다.", status: "active", scope: "builtin", source: "Claude bundled skill", command: "/code-review", template: "/code-review " },
  { id: "claude:skill:bundled:dataviz", provider: "claude", kind: "skills", name: "dataviz", label: "dataviz", description: "차트와 dashboard 시각화 설계를 돕습니다.", status: "active", scope: "builtin", source: "Claude bundled skill", command: "/dataviz", template: "/dataviz " },
  { id: "claude:skill:bundled:debug", provider: "claude", kind: "skills", name: "debug", label: "debug", description: "세션 debug logging을 켜고 runtime issue를 진단합니다.", status: "active", scope: "builtin", source: "Claude bundled skill", command: "/debug", template: "/debug " },
  { id: "claude:skill:bundled:deep-research", provider: "claude", kind: "skills", name: "deep-research", label: "deep-research", description: "웹 검색을 병렬로 수행하고 인용이 있는 리포트를 합성합니다.", status: "active", scope: "builtin", source: "Claude bundled workflow", command: "/deep-research", template: "/deep-research " },
  { id: "claude:skill:bundled:design-sync", provider: "claude", kind: "skills", name: "design-sync", label: "design-sync", description: "React design system을 Claude Design에 동기화합니다.", status: "active", scope: "builtin", source: "Claude bundled skill", command: "/design-sync", template: "/design-sync " },
  { id: "claude:skill:bundled:doctor", provider: "claude", kind: "skills", name: "doctor", label: "doctor", description: "설치, 설정, unused skills/MCP/plugins 등을 진단합니다.", status: "active", scope: "builtin", source: "Claude bundled skill", command: "/doctor", template: "/doctor" },
  { id: "claude:skill:bundled:fewer-permission-prompts", provider: "claude", kind: "skills", name: "fewer-permission-prompts", label: "fewer-permission-prompts", description: "자주 거절되는 read-only 명령을 분석해 권한 프롬프트를 줄입니다.", status: "active", scope: "builtin", source: "Claude bundled skill", command: "/fewer-permission-prompts", template: "/fewer-permission-prompts" },
  { id: "claude:skill:bundled:loop", provider: "claude", kind: "skills", name: "loop", label: "loop", description: "프롬프트를 반복 실행합니다. Alias: /proactive", status: "active", scope: "builtin", source: "Claude bundled skill", command: "/loop", template: "/loop " },
  { id: "claude:skill:bundled:run", provider: "claude", kind: "skills", name: "run", label: "run", description: "앱을 실행하고 브라우저/터미널로 변경을 확인합니다.", status: "active", scope: "builtin", source: "Claude bundled skill", command: "/run", template: "/run " },
  { id: "claude:skill:bundled:run-skill-generator", provider: "claude", kind: "skills", name: "run-skill-generator", label: "run-skill-generator", description: "/run, /verify가 프로젝트 실행법을 알도록 per-project skill을 생성합니다.", status: "active", scope: "builtin", source: "Claude bundled skill", command: "/run-skill-generator", template: "/run-skill-generator" },
  { id: "claude:skill:bundled:security-review", provider: "claude", kind: "skills", name: "security-review", label: "security-review", description: "현재 branch diff에서 보안 취약점을 찾습니다.", status: "active", scope: "builtin", source: "Claude bundled skill", command: "/security-review", template: "/security-review" },
  { id: "claude:skill:bundled:simplify", provider: "claude", kind: "skills", name: "simplify", label: "simplify", description: "변경 코드에서 단순화/재사용/효율 개선점을 찾아 적용합니다.", status: "active", scope: "builtin", source: "Claude bundled skill", command: "/simplify", template: "/simplify " },
  { id: "claude:skill:bundled:verify", provider: "claude", kind: "skills", name: "verify", label: "verify", description: "테스트만이 아니라 앱 실행으로 변경이 맞는지 검증합니다.", status: "active", scope: "builtin", source: "Claude bundled skill", command: "/verify", template: "/verify " },
];

function readFirstHeading(file: string): string | null {
  try {
    const line = fs.readFileSync(file, "utf8").split("\n").find((entry) => entry.trim().startsWith("# "));
    return line?.replace(/^#\s+/, "").trim() || null;
  } catch {
    return null;
  }
}

function listMarkdownCommands(provider: Provider, root: string, scope: ToolScope, sourceLabel: string, baseDir: string): ToolItem[] {
  let files: string[];
  try {
    files = fs.readdirSync(root).filter((file) => file.endsWith(".md"));
  } catch {
    return [];
  }
  return files.map((file) => {
    const fullPath = path.join(root, file);
    const name = `/${path.basename(file, ".md")}`;
    return {
      id: `${provider}:command:${scope}:${fullPath}`,
      provider,
      kind: "commands",
      name,
      label: name,
      description: readFirstHeading(fullPath) ?? `${sourceLabel} custom command`,
      status: "active",
      scope,
      source: path.relative(baseDir, fullPath) || fullPath,
      command: name,
      template: `${name} `,
    };
  });
}

function listClaudeSkills(projectRoot: string): ToolItem[] {
  const dirs = [
    { root: path.join(projectRoot, ".claude", "skills"), scope: "project" as ToolScope, base: projectRoot },
    { root: path.join(os.homedir(), ".claude", "skills"), scope: "user" as ToolScope, base: os.homedir() },
  ];
  const items: ToolItem[] = [];
  for (const dir of dirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir.root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
      continue;
    }
    for (const entry of entries) {
      const skillFile = path.join(dir.root, entry.name, "SKILL.md");
      const exists = fs.existsSync(skillFile);
      const command = `/${entry.name}`;
      items.push({
        id: `claude:skill:${dir.scope}:${path.join(dir.root, entry.name)}`,
        provider: "claude",
        kind: "skills",
        name: entry.name,
        label: entry.name,
        description: exists ? readFirstHeading(skillFile) ?? "Claude skill" : "SKILL.md 파일을 찾을 수 없습니다.",
        status: exists ? "active" : "error",
        scope: dir.scope,
        source: path.relative(dir.base, path.join(dir.root, entry.name)),
        command,
        template: `${command} `,
        details: { skillFile: path.relative(dir.base, skillFile) },
      });
    }
  }
  return items;
}

// 프로젝트 `.mcp.json`을 읽어 Claude MCP 목록을 도구 카탈로그 항목으로 변환한다.
function listClaudeMcp(projectRoot: string): ToolItem[] {
  const projectFile = path.join(projectRoot, ".mcp.json");
  if (!fs.existsSync(projectFile)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(projectFile, "utf8")) as { mcpServers?: Record<string, Record<string, unknown>> };
    return Object.entries(parsed.mcpServers ?? {}).map(([name, config]) => ({
      id: `claude:mcp:project:${name}`,
      provider: "claude" as Provider,
      kind: "mcp" as ToolKind,
      name,
      label: name,
      description: typeof config.command === "string" ? config.command : typeof config.url === "string" ? config.url : "Claude MCP server",
      status: "active" as ToolStatus,
      scope: "project" as ToolScope,
      source: ".mcp.json",
      details: {
        transport: typeof config.type === "string" ? config.type : config.url ? "http" : "stdio",
        envKeys: config.env && typeof config.env === "object" ? Object.keys(config.env) : [],
        headerKeys: config.headers && typeof config.headers === "object" ? Object.keys(config.headers) : [],
        config: sanitizeMcpConfig(config),
      },
    }));
  } catch {
    return [{ id: "claude:mcp:project:parse-error", provider: "claude", kind: "mcp", name: ".mcp.json", label: ".mcp.json", description: "MCP 설정 JSON을 읽을 수 없습니다.", status: "error", scope: "project", source: ".mcp.json" }];
  }
}

// CLI MCP 목록 출력 텍스트를 read-only 카탈로그 항목으로 변환한다.
function parseCliMcpOutput(provider: Provider, command: string, output: string): ToolItem[] {
  return output.split("\n").map((line) => line.trim()).flatMap((line) => {
    if (!line || /^Checking MCP server health/i.test(line) || /^No MCP servers configured/i.test(line)) return [];
    const match = line.match(/^(.+?)(?::\s*(.+?))?\s+-\s+([✔✓!✗x])\s*(.*)$/i);
    if (!match) return [];
    const name = match[1].trim();
    const target = (match[2] || "").trim();
    const marker = match[3];
    const stateText = (match[4] || "").trim();
    const status: ToolStatus = marker === "!" || /auth/i.test(stateText) ? "needs_auth" : marker === "✗" || marker.toLowerCase() === "x" ? "error" : "active";
    return [{
      id: `${provider}:mcp:cli:${name}`,
      provider,
      kind: "mcp" as ToolKind,
      name,
      label: name,
      description: target || `${provider} MCP server`,
      status,
      scope: "global" as ToolScope,
      source: `${command} mcp list`,
      details: { readOnly: true, cliState: stateText || marker, target },
    }];
  });
}

// Claude/Codex CLI가 보여주는 MCP health 목록을 비동기로 조회하고 잠시 캐시한다.
async function listCliMcp(provider: Provider, cwd: string): Promise<ToolItem[]> {
  const key = `${provider}:${cwd}`;
  const now = Date.now();
  const cached = cliMcpCache.get(key);
  if (cached && cached.expiresAt > now) {
    if (cached.items) return cached.items;
    if (cached.promise) return cached.promise;
  }
  // 세 공급자 모두 id가 그대로 CLI 실행 파일 이름이다. 예전의 삼항식은 새로 추가된 공급자가 전부
  // codex로 떨어져 엉뚱한 CLI를 실행했다.
  const command = provider;
  const promise = execFileAsync(command, ["mcp", "list"], { cwd, encoding: "utf8", timeout: 7000, windowsHide: true })
    .then(({ stdout }) => {
      const items = parseCliMcpOutput(provider, command, String(stdout));
      cliMcpCache.set(key, { expiresAt: Date.now() + CLI_MCP_CACHE_MS, items });
      return items;
    })
    .catch(() => {
      cliMcpCache.set(key, { expiresAt: Date.now() + CLI_MCP_ERROR_CACHE_MS, items: [] });
      return [];
    });
  cliMcpCache.set(key, { expiresAt: now + CLI_MCP_CACHE_MS, promise });
  return promise;
}

// 설정 파일 목록에 CLI에서만 보이는 MCP 항목을 중복 없이 병합한다.
function mergeMcpItems(configured: ToolItem[], discovered: ToolItem[]): ToolItem[] {
  const seen = new Set(configured.map((item) => `${item.provider}:${item.name}`));
  return [...configured, ...discovered.filter((item) => {
    const key = `${item.provider}:${item.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  })];
}

// 민감한 env/header 값을 제외하고 웹 편집기에 필요한 MCP 설정만 반환한다.
function sanitizeMcpConfig(config: Record<string, unknown>): Record<string, unknown> {
  return {
    type: typeof config.type === "string" ? config.type : config.url ? "http" : "stdio",
    command: typeof config.command === "string" ? config.command : "",
    args: Array.isArray(config.args) ? config.args.filter((item) => typeof item === "string") : [],
    cwd: typeof config.cwd === "string" ? config.cwd : "",
    url: typeof config.url === "string" ? config.url : "",
    enabled: true,
    envKeys: config.env && typeof config.env === "object" ? Object.keys(config.env) : [],
    headerKeys: config.headers && typeof config.headers === "object" ? Object.keys(config.headers) : [],
  };
}

// Codex 설정 TOML 하나를 읽어 MCP 목록을 도구 카탈로그 항목으로 변환한다.
function listCodexMcpFile(file: string, scope: ToolScope, source: string): ToolItem[] {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return readCodexMcpServers(text).map((server) => {
    const description = server.url || server.command || "Codex MCP server";
    return {
      id: `codex:mcp:user:${server.name}`,
      provider: "codex",
      kind: "mcp",
      name: server.name,
      label: server.name,
      description,
      status: server.enabled === false ? "disabled" : "active",
      scope,
      source,
      details: { transport: server.url ? "http" : "stdio", envKeys: Object.keys(server.env ?? {}), headerKeys: Object.keys(server.headers ?? {}), config: { ...server, env: undefined, headers: undefined, envKeys: Object.keys(server.env ?? {}), headerKeys: Object.keys(server.headers ?? {}) } },
    } as ToolItem;
  });
}

// 사용자/프로젝트 Codex 설정을 함께 읽어 MCP 목록을 만든다.
function listCodexMcp(projectRoot: string): ToolItem[] {
  return [
    ...listCodexMcpFile(path.join(os.homedir(), ".codex", "config.toml"), "user", "~/.codex/config.toml"),
    ...listCodexMcpFile(path.join(projectRoot, ".codex", "config.toml"), "project", ".codex/config.toml"),
  ];
}

function marketplaceItems(): ToolItem[] {
  return [
    { id: "codex:marketplace:plugins", provider: "codex", kind: "marketplace", name: "Codex plugins", label: "Codex plugins", description: "`/plugins` 또는 `codex plugin`으로 설치·삭제·활성 상태를 관리합니다.", status: "active", scope: "marketplace", source: "Codex CLI", command: "/plugins", template: "/plugins" },
    { id: "codex:marketplace:sources", provider: "codex", kind: "marketplace", name: "Marketplace sources", label: "Marketplace sources", description: "`codex plugin marketplace`로 marketplace 소스를 추가·목록·업그레이드·제거합니다.", status: "active", scope: "marketplace", source: "Codex CLI" },
    { id: "claude:marketplace:plugins", provider: "claude", kind: "marketplace", name: "Claude plugins", label: "Claude plugins", description: "Claude Code plugins는 skills, agents, hooks, MCP servers를 marketplace로 배포할 수 있습니다.", status: "active", scope: "marketplace", source: "Claude Code" },
  ];
}

// 요청 본문의 JSON 객체 필드를 문자열 key/value 맵으로 검증한다.
function parseJsonMap(value: unknown, label: string): Record<string, string> | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value === "object" && !Array.isArray(value)) {
    const result: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (!key || typeof entry !== "string") throw new Error(`${label} 값은 문자열 key/value 객체여야 합니다.`);
      result[key] = entry;
    }
    return result;
  }
  throw new Error(`${label} 값은 객체여야 합니다.`);
}

// 문자열 또는 배열 입력을 MCP args 문자열 배열로 정규화한다.
function parseStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (typeof value === "string") return value.split(/\s+/).map((item) => item.trim()).filter(Boolean);
  return [];
}

// MCP 생성/수정 요청 본문과 라우트 파라미터를 내부 입력 구조로 검증한다.
function parseMcpInput(body: Record<string, unknown>, providerParam?: string, projectIdParam?: number, nameParam?: string): McpInput {
  const provider = (providerParam ?? body.provider) as Provider;
  if (!["claude", "codex"].includes(provider)) throw new Error("지원하지 않는 MCP 공급자입니다.");
  const name = String(nameParam ?? body.name ?? "").trim();
  if (!MCP_NAME_PATTERN.test(name)) throw new Error("MCP 이름은 영문, 숫자, 하이픈, 밑줄만 사용할 수 있습니다.");
  const transport = String(body.transport ?? body.type ?? (body.url ? "http" : "stdio")) as McpInput["transport"];
  if (!["stdio", "http", "sse", "ws"].includes(transport)) throw new Error("지원하지 않는 MCP transport입니다.");
  const projectId = Number(projectIdParam ?? body.projectId);
  return {
    provider,
    projectId: Number.isInteger(projectId) && projectId > 0 ? projectId : undefined,
    name,
    transport,
    command: typeof body.command === "string" ? body.command.trim() : undefined,
    args: parseStringList(body.args),
    cwd: typeof body.cwd === "string" ? body.cwd.trim() : undefined,
    url: typeof body.url === "string" ? body.url.trim() : undefined,
    enabled: body.enabled !== false,
    env: parseJsonMap(body.env, "env"),
    headers: parseJsonMap(body.headers, "headers"),
  };
}

// 공급자 설정 파일에 저장할 MCP 서버 설정을 입력값과 기존 비밀 필드로 조합한다.
function mcpConfigFromInput(input: McpInput, existing?: Record<string, unknown>): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  config.type = input.transport === "http" ? "http" : input.transport;
  if (input.transport === "stdio") {
    if (!input.command) throw new Error("stdio MCP에는 command가 필요합니다.");
    config.command = input.command;
    if (input.args?.length) config.args = input.args;
    if (input.cwd) config.cwd = input.cwd;
  } else {
    if (!input.url) throw new Error("원격 MCP에는 URL이 필요합니다.");
    config.url = input.url;
    if (input.headers) config.headers = input.headers;
    else if (existing?.headers) config.headers = existing.headers;
  }
  if (input.env) config.env = input.env;
  else if (existing?.env) config.env = existing.env;
  if (input.provider === "codex" && input.enabled === false) config.enabled = false;
  return config;
}

// MCP 프로젝트 범위를 위해 활성 프로젝트의 검증된 루트 경로를 찾는다.
function projectRootFor(database: AppDatabase, projectId: number | undefined): string {
  if (!projectId) throw new Error("프로젝트가 필요합니다.");
  const row = database.prepare("SELECT path FROM projects WHERE id = ? AND active = 1").get(projectId) as { path: string } | undefined;
  if (!row) throw new Error("프로젝트를 찾을 수 없습니다.");
  return resolveProjectPath(row.path, ".", true);
}

// Claude 프로젝트 MCP 파일을 읽고 없으면 빈 mcpServers 구조를 준비한다.
function readClaudeMcpFile(projectRoot: string): { file: string; data: { mcpServers: Record<string, Record<string, unknown>> } } {
  const file = path.join(projectRoot, ".mcp.json");
  if (!fs.existsSync(file)) return { file, data: { mcpServers: {} } };
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { mcpServers?: Record<string, Record<string, unknown>> };
  return { file, data: { ...parsed, mcpServers: parsed.mcpServers ?? {} } };
}

// Claude 프로젝트 `.mcp.json`에 MCP 서버 설정을 저장한다.
function writeClaudeMcp(database: AppDatabase, input: McpInput, replaceName?: string): void {
  const { file, data } = readClaudeMcpFile(projectRootFor(database, input.projectId));
  const targetName = replaceName ?? input.name;
  const existing = data.mcpServers[targetName];
  data.mcpServers[targetName] = mcpConfigFromInput(input, existing);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

// Claude 프로젝트 `.mcp.json`에서 MCP 서버 설정을 삭제한다.
function deleteClaudeMcp(database: AppDatabase, projectId: number | undefined, name: string): void {
  const { file, data } = readClaudeMcpFile(projectRootFor(database, projectId));
  delete data.mcpServers[name];
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

// Claude 공식 MCP 설정에 없는 enabled 토글 요청을 명시적으로 거부한다.
function toggleClaudeMcp(database: AppDatabase, projectId: number | undefined, name: string, enabled: boolean): void {
  void database; void projectId; void name; void enabled;
  throw new Error("Claude MCP는 공식 설정에서 enabled 토글을 지원하지 않습니다. 삭제 후 필요할 때 다시 추가하세요.");
}

interface CodexMcpServer {
  name: string;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  enabled?: boolean;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

// 단순 TOML 문자열 값을 내부 문자열로 복원한다.
function unquoteToml(value: string): string {
  return value.trim().replace(/^"|"$/g, "").replace(/\\"/g, "\"");
}

// MCP TOML 블록에 쓸 문자열 값을 이스케이프한다.
function quoteToml(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

// 단순 TOML 문자열 배열을 args 배열로 파싱한다.
function parseTomlArray(value: string): string[] {
  const body = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!body.trim()) return [];
  return body.split(",").map((item) => unquoteToml(item.trim())).filter(Boolean);
}

// 단순 TOML inline table을 문자열 key/value 맵으로 파싱한다.
function parseTomlInlineMap(value: string): Record<string, string> {
  const body = value.trim().replace(/^\{/, "").replace(/\}$/, "");
  const result: Record<string, string> = {};
  if (!body.trim()) return result;
  for (const part of body.split(",")) {
    const [key, ...rest] = part.split("=");
    if (!key || !rest.length) continue;
    result[key.trim().replace(/^"|"$/g, "")] = unquoteToml(rest.join("=").trim());
  }
  return result;
}

// Codex config.toml에서 mcp_servers 블록들을 추출한다.
function readCodexMcpServers(text: string): CodexMcpServer[] {
  const lines = text.split("\n");
  const servers: CodexMcpServer[] = [];
  let current: CodexMcpServer | null = null;
  let currentSubtable: "env" | "headers" | null = null;
  for (const line of lines) {
    const section = line.match(/^\s*\[mcp_servers\.("?[^"\]]+"?)(?:\.(env|http_headers))?\]\s*$/);
    if (section) {
      const name = section[1].replace(/^"|"$/g, "");
      current = servers.find((item) => item.name === name) ?? { name };
      if (!servers.includes(current)) servers.push(current);
      currentSubtable = section[2] === "env" ? "env" : section[2] === "http_headers" ? "headers" : null;
      continue;
    }
    if (!current || /^\s*(#|$)/.test(line)) continue;
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2];
    if (currentSubtable === "env") { current.env = { ...(current.env ?? {}), [key]: unquoteToml(value) }; continue; }
    if (currentSubtable === "headers") { current.headers = { ...(current.headers ?? {}), [key]: unquoteToml(value) }; continue; }
    if (key === "command") current.command = unquoteToml(value);
    if (key === "cwd") current.cwd = unquoteToml(value);
    if (key === "url") current.url = unquoteToml(value);
    if (key === "enabled") current.enabled = value.trim() !== "false";
    if (key === "args") current.args = parseTomlArray(value);
    if (key === "env") current.env = parseTomlInlineMap(value);
    if (key === "http_headers") current.headers = parseTomlInlineMap(value);
  }
  return servers;
}

// Codex 사용자 설정 파일 경로를 만들고 상위 디렉터리를 보장한다.
function codexConfigFile(): string {
  const dir = path.join(os.homedir(), ".codex");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, "config.toml");
}

// Codex MCP 서버 설정 하나를 TOML 블록으로 직렬화한다.
function codexServerBlock(server: CodexMcpServer): string {
  const lines = [`[mcp_servers.${quoteToml(server.name)}]`];
  if (server.url) lines.push(`url = ${quoteToml(server.url)}`);
  if (server.command) lines.push(`command = ${quoteToml(server.command)}`);
  if (server.args?.length) lines.push(`args = [${server.args.map(quoteToml).join(", ")}]`);
  if (server.cwd) lines.push(`cwd = ${quoteToml(server.cwd)}`);
  if (server.enabled === false) lines.push("enabled = false");
  if (server.env && Object.keys(server.env).length) lines.push(`env = { ${Object.entries(server.env).map(([key, value]) => `${key} = ${quoteToml(value)}`).join(", ")} }`);
  if (server.headers && Object.keys(server.headers).length) lines.push(`http_headers = { ${Object.entries(server.headers).map(([key, value]) => `${key} = ${quoteToml(value)}`).join(", ")} }`);
  return lines.join("\n");
}

// 기존 Codex MCP 서버 블록을 이름 기준으로 제거한다.
function removeCodexServerBlock(text: string, name: string): string {
  const lines: string[] = [];
  let skipping = false;
  for (const line of text.split("\n")) {
    const section = line.match(/^\s*\[mcp_servers\.("?[^"\]]+"?)(?:\.(env|http_headers))?\]\s*$/);
    if (section && section[1].replace(/^"|"$/g, "") === name) {
      skipping = true;
      continue;
    }
    if (skipping && /^\s*\[/.test(line)) skipping = false;
    if (!skipping) lines.push(line);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

// Codex config.toml에 MCP 서버 설정을 추가하거나 갱신한다.
function writeCodexMcp(input: McpInput, replaceName?: string): void {
  const file = codexConfigFile();
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const existing = readCodexMcpServers(text).find((server) => server.name === (replaceName ?? input.name));
  const server: CodexMcpServer = {
    name: replaceName ?? input.name,
    command: input.transport === "stdio" ? input.command : undefined,
    args: input.args,
    cwd: input.cwd,
    url: input.transport !== "stdio" ? input.url : undefined,
    enabled: input.enabled,
    env: input.env ?? existing?.env,
    headers: input.headers ?? existing?.headers,
  };
  if (!server.command && !server.url) throw new Error("MCP에는 command 또는 URL이 필요합니다.");
  const without = removeCodexServerBlock(text, server.name);
  fs.writeFileSync(file, `${without ? `${without}\n\n` : ""}${codexServerBlock(server)}\n`, { mode: 0o600 });
}

// Codex config.toml에서 MCP 서버 설정을 삭제한다.
function deleteCodexMcp(name: string): void {
  const file = codexConfigFile();
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  fs.writeFileSync(file, `${removeCodexServerBlock(text, name)}\n`, { mode: 0o600 });
}

// Codex MCP 서버의 enabled 플래그를 갱신한다.
function toggleCodexMcp(name: string, enabled: boolean): void {
  const file = codexConfigFile();
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const server = readCodexMcpServers(text).find((item) => item.name === name);
  if (!server) throw new Error("MCP 서버를 찾을 수 없습니다.");
  server.enabled = enabled;
  const without = removeCodexServerBlock(text, name);
  fs.writeFileSync(file, `${without ? `${without}\n\n` : ""}${codexServerBlock(server)}\n`, { mode: 0o600 });
}

async function catalog(projectRoot: string): Promise<ToolItem[]> {
  const configuredMcp = [
    ...listClaudeMcp(projectRoot),
    ...listCodexMcp(projectRoot),
  ];
  const [claudeCliMcp, codexCliMcp] = await Promise.all([
    listCliMcp("claude", projectRoot),
    listCliMcp("codex", projectRoot),
  ]);
  const discoveredMcp = [...claudeCliMcp, ...codexCliMcp];
  return [
    ...BUILTIN_COMMANDS,
    ...BUNDLED_CLAUDE_SKILLS,
    ...listMarkdownCommands("claude", path.join(projectRoot, ".claude", "commands"), "project", "Claude", projectRoot),
    ...listMarkdownCommands("claude", path.join(os.homedir(), ".claude", "commands"), "user", "Claude", os.homedir()),
    ...listMarkdownCommands("codex", path.join(os.homedir(), ".codex", "prompts"), "user", "Codex", os.homedir()),
    ...listClaudeSkills(projectRoot),
    ...mergeMcpItems(configuredMcp, discoveredMcp),
    ...marketplaceItems(),
  ];
}

export function createToolRouter(database: AppDatabase): Router {
  const router = Router();
  router.get("/tools/catalog", async (request, response, next) => {
    try {
      const projectId = Number(request.query.projectId);
      const row = Number.isInteger(projectId) && projectId > 0
        ? database.prepare("SELECT path FROM projects WHERE id = ? AND active = 1").get(projectId) as { path: string } | undefined
        : undefined;
      const projectRoot = row ? resolveProjectPath(row.path, ".", true) : process.cwd();
      response.json({ items: await catalog(projectRoot) });
    } catch (error) {
      next(error);
    }
  });
  router.post("/tools/mcp", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      const input = parseMcpInput(request.body ?? {});
      if (input.provider === "claude") writeClaudeMcp(database, input);
      else writeCodexMcp(input);
      writeAudit(database, request.authUser!.id, "mcp.save", "mcp", `${input.provider}:${input.name}`, { provider: input.provider, projectId: input.projectId, transport: input.transport, hasEnv: !!input.env, hasHeaders: !!input.headers });
      response.status(201).json({ saved: true });
    } catch (error) {
      next(error);
    }
  });
  router.put("/tools/mcp/:provider/:scope/:name", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      const name = String(request.params.name);
      const providerParam = String(request.params.provider);
      const input = parseMcpInput(request.body ?? {}, providerParam, Number(request.body?.projectId), name);
      if (input.provider === "claude") writeClaudeMcp(database, input, name);
      else writeCodexMcp(input, name);
      writeAudit(database, request.authUser!.id, "mcp.update", "mcp", `${input.provider}:${name}`, { provider: input.provider, projectId: input.projectId, transport: input.transport, hasEnv: !!input.env, hasHeaders: !!input.headers });
      response.json({ saved: true });
    } catch (error) {
      next(error);
    }
  });
  router.post("/tools/mcp/:provider/:scope/:name/toggle", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      const provider = String(request.params.provider) as Provider;
      if (!["claude", "codex"].includes(provider)) throw new Error("지원하지 않는 MCP 공급자입니다.");
      const enabled = request.body?.enabled !== false;
      const name = String(request.params.name);
      if (!MCP_NAME_PATTERN.test(name)) throw new Error("유효하지 않은 MCP 이름입니다.");
      const projectId = Number(request.body?.projectId);
      if (provider === "claude") toggleClaudeMcp(database, Number.isInteger(projectId) ? projectId : undefined, name, enabled);
      else toggleCodexMcp(name, enabled);
      writeAudit(database, request.authUser!.id, "mcp.toggle", "mcp", `${provider}:${name}`, { provider, projectId: Number.isInteger(projectId) ? projectId : null, enabled });
      response.json({ saved: true });
    } catch (error) {
      next(error);
    }
  });
  router.delete("/tools/mcp/:provider/:scope/:name", requireAdmin, requireTrustedNetwork, (request: AuthenticatedRequest, response, next) => {
    try {
      const provider = String(request.params.provider) as Provider;
      if (!["claude", "codex"].includes(provider)) throw new Error("지원하지 않는 MCP 공급자입니다.");
      const name = String(request.params.name);
      if (!MCP_NAME_PATTERN.test(name)) throw new Error("유효하지 않은 MCP 이름입니다.");
      const projectId = Number(request.query.projectId);
      if (provider === "claude") deleteClaudeMcp(database, Number.isInteger(projectId) ? projectId : undefined, name);
      else deleteCodexMcp(name);
      writeAudit(database, request.authUser!.id, "mcp.delete", "mcp", `${provider}:${name}`, { provider, projectId: Number.isInteger(projectId) ? projectId : null });
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });
  return router;
}
