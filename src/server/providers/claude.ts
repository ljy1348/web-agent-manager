import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ApprovalHint, HistoryMessage, HistorySyncContext, HistorySyncDecision, HistorySession, HistoryTokenUsage, ModelChoice, ModelOptions, ProviderAdapter, ProviderLaunch, TmuxIO } from "./provider";
import type { UsageRecord, UsageWindow } from "../../shared/types";
import { extractContent, fallbackId } from "./history-utils";
import { stripAnsi } from "../core/security";
import { isExpiredResetTime } from "./usage-utils";
import { USAGE_KEEPALIVE_PROMPT } from "../../shared/usage-keepalive";

// Claude API 프로토콜은 도구 실행 결과를 "user" 역할 턴으로 되돌려주므로,
// 사람이 입력한 메시지와 구분하기 위해 tool_result만 담긴 턴인지 확인한다.
function isToolResultOnly(rawContent: unknown): boolean {
  if (!Array.isArray(rawContent) || !rawContent.length) return false;
  return rawContent.every((item) => !!item && typeof item === "object" && (item as Record<string, unknown>).type === "tool_result");
}

// assistant 메시지에 실제 도구 호출 블록이 들어있는지 확인한다.
function hasToolUseBlock(rawContent: unknown): boolean {
  return Array.isArray(rawContent) && rawContent.some((item) => !!item && typeof item === "object" && (item as Record<string, unknown>).type === "tool_use");
}

// /exit, /clear 같은 로컬 슬래시 명령은 모델로 전달되지 않고 CLI가 직접 처리하지만, 그 실행 자체와
// 결과 출력도 "user" 역할 턴으로 JSONL에 남는다(웹에서 "터미널 종료" 시 보내는 /exit도 동일). 실제
// 사람의 대화 내용이 아니라 명령 실행 로그이므로 일반 채팅 말풍선으로 보이면 혼란스러워 시스템 항목으로 뺀다.
const LOCAL_COMMAND_PATTERN = /<(command-name|command-message|command-args|local-command-stdout|local-command-stderr)>/;
// 실제 CLI의 /model 화면 effort 게이지는 Low·Medium·High·xHigh·Max 5단계이고 xHigh와 Max는 서로 다른
// 위치(Max만 별도 경고 문구 있음)라, 예전에 xHigh를 max로 합쳐 4단계로 취급하던 코드는 화살표 이동
// 칸수 계산이 실제 게이지와 어긋나 엉뚱한 단계에 저장되는 문제가 있었다(실제 CLI로 재현·확인함).
const CLAUDE_EFFORTS: ModelChoice[] = [
  { index: 1, id: "low", label: "Low" },
  { index: 2, id: "medium", label: "Medium" },
  { index: 3, id: "high", label: "High" },
  { index: 4, id: "xhigh", label: "xHigh" },
  { index: 5, id: "max", label: "Max" },
];

// Claude effort 라벨을 API에서 쓰는 안정 ID로 정규화한다.
function claudeEffortId(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.toLowerCase().replace(/\s+/g, "");
  if (["low", "medium", "high", "xhigh", "max"].includes(normalized)) return normalized;
  return null;
}

// Claude 모델 ID·라벨을 메뉴 순서와 무관한 모델군 이름으로 정규화한다.
function claudeModelFamily(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").toLowerCase();
  for (const family of ["default", "opus", "sonnet", "fable", "haiku"]) {
    if (normalized.includes(family)) return family;
  }
  return null;
}

// Claude 화면 스크롤백에 남은 예전 effort 결과보다 가장 최근 effort 표시를 우선한다.
function lastClaudeEffortId(text: string, pattern: RegExp): string | null {
  const matches = [...text.matchAll(pattern)];
  return claudeEffortId(matches.at(-1)?.[1]);
}

function isLocalCommand(content: string): boolean {
  return LOCAL_COMMAND_PATTERN.test(content);
}

// 백그라운드 서브에이전트(Task 도구)·백그라운드 명령이 끝나면 그 결과가 "user" 역할 턴으로 주입된다
// (실제 사람이 입력한 게 아니라 하네스가 비동기로 알려주는 완료 통지). 이것도 사람이 친 것처럼
// 채팅 말풍선에 뜨면 혼란스러워, local-command와 같은 방식으로 시스템 항목으로 뺀다.
const TASK_NOTIFICATION_PATTERN = /^\s*<task-notification>/;
function isTaskNotification(content: string): boolean {
  return TASK_NOTIFICATION_PATTERN.test(content);
}

// JSONL의 원본 모델 id("claude-sonnet-5")를 기존 배너 표시 형식("Sonnet 5")과 맞춘다.
function formatModelId(id: string): string {
  return id.replace(/^claude-/, "").split("-").map((part) => /^\d+$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

// Claude assistant 레코드의 API usage를 채팅 공통 토큰 수치로 변환한다.
function parseClaudeTokenUsage(value: unknown): HistoryTokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const number = (key: string): number => typeof usage[key] === "number" && Number.isFinite(usage[key]) && Number(usage[key]) >= 0 ? Number(usage[key]) : 0;
  const inputTokens = number("input_tokens");
  const cacheCreationInputTokens = number("cache_creation_input_tokens");
  const cacheReadInputTokens = number("cache_read_input_tokens");
  const outputTokens = number("output_tokens");
  const totalTokens = inputTokens + cacheCreationInputTokens + cacheReadInputTokens + outputTokens;
  if (!totalTokens) return undefined;
  return { inputTokens, cachedInputTokens: 0, cacheCreationInputTokens, cacheReadInputTokens, outputTokens, reasoningOutputTokens: 0, totalTokens };
}

// Claude JSONL 레코드에서 대화 메시지를 공통 형태로 변환한다.
function parseClaudeMessage(record: Record<string, unknown>, line: string): HistoryMessage | null {
  const type = String(record.type ?? "");
  if (!['user', 'assistant', 'system'].includes(type)) return null;
  const message = record.message && typeof record.message === "object" ? record.message as Record<string, unknown> : {};
  const rawContent = message.content ?? record.content;
  const content = extractContent(rawContent);
  if (!content) return null;
  const isToolResult = type === "user" && isToolResultOnly(rawContent);
  const isTaskNotif = type === "user" && !isToolResult && isTaskNotification(content);
  const isLocalCmd = type === "user" && !isToolResult && !isTaskNotif && isLocalCommand(content);
  // /compact(또는 컨텍스트 한도로 인한 자동 압축)가 실행되면 CLI가 그 요약 전체를 "user" 역할 턴으로
  // 주입한다(API 프로토콜상 다음 턴을 이어가려면 user 턴이 필요해서다) — 그래서 이 필드가 없으면 실제
  // 사람이 그 긴 요약문 전체를 직접 친 것처럼 채팅 말풍선에 보였다(실사용 보고로 확인). CLI가 정확히
  // 이런 합성 턴을 구분하려고 남기는 isCompactSummary 플래그로 걸러 시스템 항목으로 뺀다.
  const isCompactSummary = type === "user" && !isToolResult && record.isCompactSummary === true;
  const role = type === "assistant" ? "assistant" : isToolResult ? "tool" : isTaskNotif || isLocalCmd || isCompactSummary ? "system" : type === "user" ? "user" : "system";
  // stop_reason이 "tool_use"면 도구 호출을 위해 멈춘 중간 턴이라 실제 응답 완료가 아니다.
  // 이 구분이 없으면 도구를 여러 번 호출하는 동안 매번 "응답 완료"로 오인해 작업중 표시가 풀렸다.
  const stopReason = typeof message.stop_reason === "string" ? message.stop_reason : "";
  const hasToolUse = type === "assistant" && hasToolUseBlock(rawContent);
  const isToolCallStep = type === "assistant" && (stopReason === "tool_use" || hasToolUse);
  const isTurnEndStep = type === "assistant" && stopReason === "end_turn" && !hasToolUse;
  return {
    id: String(record.uuid ?? record.messageId ?? message.id ?? fallbackId(line)),
    role,
    kind: isToolResult ? "tool_result" : isTaskNotif ? "task_notification" : isLocalCmd ? "local_command" : isCompactSummary ? "compact_summary" : isToolCallStep ? "tool_call" : isTurnEndStep ? "turn_end" : String(record.subtype ?? "text"),
    content,
    createdAt: String(record.timestamp ?? new Date().toISOString()),
    tokenUsage: type === "assistant" ? parseClaudeTokenUsage(message.usage) : undefined,
  };
}

interface ClaudeHistoryState {
  sessionId: string;
  cwd: string;
  model: string | null;
  aiTitle: string | null;
  messages: HistoryMessage[];
}

// Claude JSONL 레코드 하나를 누적 세션 상태에 반영한다.
function applyClaudeHistoryRecord(state: ClaudeHistoryState, record: Record<string, unknown>, line: string): void {
  state.sessionId = String(record.sessionId ?? state.sessionId);
  state.cwd = String(record.cwd ?? state.cwd);
  const messageObject = record.message && typeof record.message === "object" ? record.message as Record<string, unknown> : null;
  const modelId = record.type === "assistant" && messageObject && typeof messageObject.model === "string" ? messageObject.model : null;
  if (modelId) state.model = formatModelId(modelId);
  if (typeof record.aiTitle === "string" && record.aiTitle.trim()) state.aiTitle = record.aiTitle.trim();
  const message = parseClaudeMessage(record, line);
  if (message) state.messages.push(message);
}

// Claude Code는 실행(했던) 세션마다 ~/.claude/sessions/<pid>.json에 표시 이름을 남긴다 — claude --resume
// 화면·`claude agents --json`이 보여주는 것과 같은 소스다(공식 문서화된 파일은 아니라 버전이 바뀌면
// 형식이 달라질 수 있어 실패하면 조용히 무시한다). 같은 세션이 여러 번 실행되면 프로세스마다 파일이
// 남으므로 sessionId별로 가장 최근 updatedAt만 취하고, 백그라운드 작업(kind:"bg")의 name은 세션
// 이름이 아니라 작업 설명이라 제외한다.
// nameSource:"derived"는 사람이 지은 이름이 아니라 "작업디렉터리명-무작위2자"(예: myagent-50) 형태의
// 자동 기본값이다 — 실제로 /rename을 실행하면 이 필드 자체가 사라지는 것으로 확인됐다(2026-07-11).
// 폴더명 반복 표시가 지저분하다는 피드백으로, 자동 기본값은 여기서 걸러내고 진짜 /rename된 것만 쓴다.
function readClaudeSessionDisplayNames(): Map<string, string> {
  const dir = path.join(os.homedir(), ".claude", "sessions");
  const latest = new Map<string, number>();
  const result = new Map<string, string>();
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return result;
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as Record<string, unknown>;
      const sessionId = typeof data.sessionId === "string" ? data.sessionId : null;
      const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : null;
      const updatedAt = typeof data.updatedAt === "number" ? data.updatedAt : 0;
      if (!sessionId || !name || data.kind === "bg" || data.nameSource === "derived") continue;
      if (updatedAt >= (latest.get(sessionId) ?? -1)) {
        latest.set(sessionId, updatedAt);
        result.set(sessionId, name);
      }
    } catch {
      // 손상되거나 형식이 다른 파일은 건너뛴다.
    }
  }
  return result;
}

// Claude 세션 JSONL을 프로젝트 메타데이터와 메시지로 해석한다.
function parseClaudeHistory(file: string): HistorySession | null {
  let lines: string[];
  try {
    lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  } catch {
    return null;
  }
  const state: ClaudeHistoryState = {
    sessionId: path.basename(file, ".jsonl"),
    cwd: "",
    model: null,
    aiTitle: null,
    messages: [],
  };
  for (const line of lines) {
    try {
      applyClaudeHistoryRecord(state, JSON.parse(line) as Record<string, unknown>, line);
    } catch {
      // 기록 중인 마지막 불완전 레코드는 다음 동기화에서 다시 읽는다.
    }
  }
  if (!state.sessionId || !state.cwd) return null;
  const stat = fs.statSync(file);
  const firstUser = state.messages.find((message) => message.role === "user")?.content;
  if (!firstUser) return null;
  // claude --resume 화면·claude agents --json이 실제로 보여주는 이름(자동 생성 기본값이든 /rename으로
  // 직접 바꾼 값이든)을 최우선으로 쓴다 — 사람이 실제 CLI에서 보는 것과 web-agent-manager 화면을 일치시키는 게
  // 목적이라, 대화 내용 기반 요약일 뿐인 aiTitle보다 이 값을 우선한다. 이 이름이 아직 없는 세션(방금
  // 시작해 프로세스 레지스트리 파일이 없거나 유실된 경우)만 aiTitle로, 그마저 없으면 원래 제목을 쓴다.
  const displayTitle = readClaudeSessionDisplayNames().get(state.sessionId) ?? state.aiTitle;
  return {
    provider: "claude",
    sessionId: state.sessionId,
    cwd: state.cwd,
    title: firstUser?.slice(0, 80) || path.basename(state.cwd),
    historyFile: file,
    createdAt: stat.birthtime.toISOString(),
    updatedAt: stat.mtime.toISOString(),
    messages: state.messages,
    model: state.model,
    displayTitle,
  };
}

// 새로 추가된 Claude JSONL 줄만 기존 세션 결과에 누적한다.
function appendClaudeHistory(file: string, previous: HistorySession, lines: string[]): HistorySession | undefined {
  const state: ClaudeHistoryState = {
    sessionId: previous.sessionId,
    cwd: previous.cwd,
    model: previous.model ?? null,
    aiTitle: null,
    messages: [...previous.messages],
  };
  try {
    for (const line of lines) applyClaudeHistoryRecord(state, JSON.parse(line) as Record<string, unknown>, line);
  } catch {
    return undefined;
  }
  const renamedTitle = readClaudeSessionDisplayNames().get(state.sessionId);
  return {
    ...previous,
    sessionId: state.sessionId,
    cwd: state.cwd,
    updatedAt: fs.statSync(file).mtime.toISOString(),
    messages: state.messages,
    model: state.model,
    displayTitle: renamedTitle ?? state.aiTitle ?? previous.displayTitle ?? null,
  };
}

// 실제 user 턴이 없거나 사용량 창 활성화 프롬프트뿐인 Claude 내부 기록은 웹 채팅 목록에서 숨긴다.
function isClaudeInternalOnlyHistory(file: string): boolean {
  let lines: string[];
  try {
    lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  } catch {
    return false;
  }
  if (!lines.length) return false;
  let sawClaudeRecord = false;
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      sawClaudeRecord = sawClaudeRecord || typeof record.type === "string";
      const message = parseClaudeMessage(record, line);
      if (message?.role === "user" && message.content !== USAGE_KEEPALIVE_PROMPT) return false;
    } catch {
      return false;
    }
  }
  return sawClaudeRecord;
}

// 뒤에서부터 검사해 패턴에 맞는 마지막 줄의 인덱스를 찾는다("지금 화면에 실제로 떠 있는 최신 상태"만
// 보려면 스크롤백에 여러 번 나올 수 있는 문구 중 가장 최근 것만 봐야 한다).
function lastMatchIndex(lines: string[], pattern: RegExp): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (pattern.test(lines[index])) return index;
  }
  return -1;
}

// Claude 선택 메뉴 뒤에 실제 새 출력이 이어졌는지 판정한다.
function hasLivePromptOnlyAfter(lines: string[], anchorIndex: number): boolean {
  for (const line of lines.slice(anchorIndex + 1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/esc to interrupt/i.test(trimmed)) return false;
    if (isClaudePromptLine(trimmed)) return false;
    if (/^(?:[⏵⏴].*)?auto mode on\b/i.test(trimmed)) continue;
    if (/^[-─]+$/.test(trimmed)) continue;
    return false;
  }
  return true;
}

// 세션 리밋 배너 뒤에 새 대화 없이 Claude의 유휴 프롬프트와 상태줄만 남았는지 판정한다.
function hasOnlyIdleChromeAfter(lines: string[], anchorIndex: number): boolean {
  let sawPrompt = false;
  for (const line of lines.slice(anchorIndex + 1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (isClaudePromptLine(line)) {
      sawPrompt = true;
      continue;
    }
    if (/^Worked for\b/i.test(trimmed)) continue;
    if (/^~?\d+[kmg]?\s+(?:un)?cached\b/i.test(trimmed)) continue;
    if (/^(?:[⏵⏴⏸].*)?(?:(?:auto|manual|plan) mode on|accept edits on)\b/i.test(trimmed)) continue;
    if (/^[-─]+$/.test(trimmed)) continue;
    return false;
  }
  return sawPrompt;
}

// Claude 브라우저 도구 권한 선택 메뉴가 지금 화면 하단에 떠 있는지 판정한다.
function browserPermissionPromptIndex(lines: string[]): number {
  const option1Index = lines.findIndex((line) => /^\s*[›❯>]?\s*1[.)]\s+Install extension\b/i.test(line));
  const option2Index = lines.findIndex((line, index) => index > option1Index && /^\s*2[.)]\s+Not now\b/i.test(line));
  const option3Index = lines.findIndex((line, index) => index > option2Index && /^\s*3[.)]\s+Don'?t ask again\b/i.test(line));
  if (option1Index < 0 || option2Index < 0 || option3Index < 0) return -1;
  const footerIndex = Math.max(lastMatchIndex(lines, /Enter selection \[1-3\]/i), lastMatchIndex(lines, /Enter to confirm\s*·\s*Esc to cancel/i));
  if (footerIndex < option3Index && !/^\s*[›❯>]\s*1[.)]\s+Install extension\b/i.test(lines[option1Index])) return -1;
  const anchorIndex = footerIndex > option3Index ? footerIndex : option3Index;
  return hasLivePromptOnlyAfter(lines, anchorIndex) ? anchorIndex : -1;
}

// 최신 Claude 리미트 메뉴의 제목·두 선택지·공통 푸터가 한 화면 하단에 함께 있는지 판정한다.
function rateLimitPromptIndex(lines: string[]): number {
  const titleIndex = lastMatchIndex(lines, /^\s*What do you want to do\?\s*$/i);
  if (titleIndex < 0) return -1;
  const footerIndex = Math.max(
    lastMatchIndex(lines, /Enter selection \[1-2\]/i),
    lastMatchIndex(lines, /Enter to confirm\s*·\s*Esc to cancel/i),
  );
  if (footerIndex <= titleIndex || footerIndex - titleIndex > 8) return -1;
  const menuLines = lines.slice(titleIndex + 1, footerIndex);
  const waitIndex = menuLines.findIndex((line) => /^\s*[›❯>]?\s*\d+[.)]\s+Stop and wait for limit to reset\b/i.test(line));
  const upgradeIndex = menuLines.findIndex((line) => /^\s*[›❯>]?\s*\d+[.)]\s+Upgrade your plan\b/i.test(line));
  if (waitIndex < 0 || upgradeIndex < 0) return -1;
  return hasLivePromptOnlyAfter(lines, footerIndex) ? footerIndex : -1;
}

// Claude가 dim 스타일로 채운 다음 질문 제안인지 판정한다.
function isClaudeSuggestedPromptLine(line: string): boolean {
  const normalized = line.replace(/\u00a0/g, " ");
  const sgrPattern = /\u001B\[([0-9;:]*)m/g;
  for (const match of normalized.matchAll(sgrPattern)) {
    if (!match[1].split(/[;:]/).includes("2")) continue;
    const beforeSuggestion = stripAnsi(normalized.slice(0, match.index)).trim();
    const suggestion = stripAnsi(normalized.slice((match.index ?? 0) + match[0].length)).trim();
    if (/^[›❯>]\s*$/.test(beforeSuggestion) && suggestion) return true;
  }
  return false;
}

// Claude 일반 TUI와 screen-reader 모드의 입력 대기 프롬프트를 함께 판정한다.
function isClaudePromptLine(line: string): boolean {
  const normalized = stripAnsi(line).replace(/\u00a0/g, " ").trim();
  return /^\$\s*$/.test(normalized)
    || /^[›❯>]\s*$/.test(normalized)
    || /^[›❯>]\s+Try\s+"/i.test(normalized)
    || isClaudeSuggestedPromptLine(line);
}

// ANSI 스타일을 보존한 채 tmux 화면 끝의 빈 행만 제거한다.
function claudeScreenLines(output: string): string[] {
  const lines = output.replace(/\r/g, "").split("\n");
  while (lines.length && !stripAnsi(lines.at(-1) ?? "").trim()) lines.pop();
  return lines;
}

// Claude 화면의 shell 스타일 입력 프롬프트가 현재 줄에 있고 생성 중 표시가 없는지 판정한다.
// tmux pane은 항상 고정 행 수로 캡처되어 실제 내용이 짧으면 끝에 빈 줄이 남는데, promptIndex를
// 못 찾을 때(생성 중엔 입력창 자체가 안 보이는 경우가 있음) 그 빈 줄들이 "마지막 N줄"로 잡혀
// 위쪽의 실제 상태 표시를 놓쳤다(작업중인데도 안 바뀌는 문제로 실제 재현됨) — split 전에
// 끝의 공백부터 제거해야 한다(detectApproval 등 다른 판정 함수와 동일한 처리).
// 최신 TUI는 작업 중에도 입력창(❯)이 계속 떠 있고, "esc to interrupt" 상태줄이 그 위가 아니라
// "아래"(입력창 테두리 다음 줄)에 오는 레이아웃도 실제로 확인됐다. 프롬프트 줄까지만 보고 자르면
// (promptIndex + 1) 그 아래 상태줄을 놓쳐 작업중인데도 준비 상태로 오판한다 — Codex 판정처럼
// 프롬프트 위쪽 몇 줄부터 화면 끝까지 전부 봐야 한다.
function isClaudeReady(output: string): boolean {
  const lines = claudeScreenLines(output);
  let promptIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (isClaudePromptLine(lines[index])) { promptIndex = index; break; }
  }
  if (promptIndex < 0) return false;
  const activeArea = stripAnsi(lines.slice(Math.max(0, promptIndex - 3)).join("\n"));
  return !/esc to interrupt/i.test(activeArea);
}

// Claude 화면 하단 입력창에 남아 있는 미전송 텍스트를 돌려준다(입력창이 비어 있으면 빈 문자열).
// 입력창이 아예 없는 화면(승인·선택 메뉴 등)이면 null을 돌려 그런 화면에 채팅 입력을 흘려보내지 않게 한다.
// 선택 메뉴의 커서 줄("❯ 1. Yes")은 입력창이 아니므로 제외하고, dim 스타일 자동 제안과 "Try ..." 안내는
// 실제로 입력된 글자가 아니라 지울 대상이 없으므로 빈 문자열로 본다.
function readClaudePromptDraft(output: string): string | null {
  const lines = claudeScreenLines(output);
  for (let index = lines.length - 1; index >= 0 && index >= lines.length - 6; index -= 1) {
    const line = lines[index];
    const match = stripAnsi(line).replace(/ /g, " ").trim().match(/^(?:[›❯>]|\$)\s*(.*)$/);
    if (!match) continue;
    const draft = match[1].trim();
    if (/^\d+[.)]\s/.test(draft)) return null;
    if (!draft || isClaudeSuggestedPromptLine(line) || /^Try\s+"/i.test(draft)) return "";
    return draft;
  }
  return null;
}

// Claude 화면의 응답 생성 중 상태 표시를 감지한다.
// isClaudeReady와 같은 이유로 끝의 빈 줄을 먼저 제거하고, 프롬프트 줄 아래쪽 상태줄도 놓치지 않게
// 화면 끝까지 본다(위 isClaudeReady 주석 참고).
function isClaudeBusy(output: string): boolean {
  const lines = claudeScreenLines(output);
  let promptIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (isClaudePromptLine(lines[index])) { promptIndex = index; break; }
  }
  const activeArea = stripAnsi(lines.slice(Math.max(0, promptIndex >= 0 ? promptIndex - 3 : lines.length - 6)).join("\n"));
  return /esc to interrupt/i.test(activeArea);
}

// 지정 레이블 다음 줄에서 Claude 사용률과 초기화 시각을 추출한다.
function parseClaudeWindow(text: string, id: string, label: string): UsageWindow | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`${escaped}\\s*\\n[^\\n]*?(\\d+(?:\\.\\d+)?)%[^\\n]*used\\s*\\n\\s*Resets\\s+([^\\n]+)`, "i"));
  if (!match) return null;
  const usedPercent = Number(match[1]);
  return { id, label, usedPercent, remainingPercent: 100 - usedPercent, resetAt: match[2].trim() };
}

// Claude 화면의 고정 구간과 현재 모델별 주간 구간을 모두 추출한다.
function parseClaudeWindows(text: string): UsageWindow[] {
  const windows = [
    parseClaudeWindow(text, "session", "Current session"),
    parseClaudeWindow(text, "weekly_all", "Current week (all models)"),
  ].filter(Boolean) as UsageWindow[];
  const labels = [...text.matchAll(/^Current week \((?!all models\))([^\n]+)\)$/gim)].map((match) => `Current week (${match[1]})`);
  for (const label of new Set(labels)) {
    const window = parseClaudeWindow(text, `weekly_${label.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`, label);
    if (window) windows.push(window);
  }
  return windows;
}

// Claude 실행·기록·승인 동작을 공급자 공통 인터페이스로 제공한다.
export class ClaudeAdapter implements ProviderAdapter {
  readonly id = "claude" as const;
  readonly displayLabel = "Claude";
  readonly usageWindowId = "session";
  readonly usageResetWindowIds = ["session", "weekly_all"];
  readonly cliVersionCommand = { command: "claude", args: ["--version"] };
  readonly historyRoot = path.join(os.homedir(), ".claude", "projects");

  // CLAUDE_CONFIG_DIR를 지정하면 Claude가 그 폴더 아래에 projects/를 새로 만들어 기록을 남긴다.
  historyRootFor(configDir: string | null): string {
    return configDir ? path.join(configDir, "projects") : this.historyRoot;
  }
  readonly usageCommands = ["/usage"];
  // 긴 bracketed-paste를 TUI가 반영할 시간을 준 뒤 실제 제출 상태까지 확인한다.
  readonly promptQuirks = {
    pasteSubmitDelayMs: 160,
    verifyPromptSubmission: true,
    usageCommandDelayMs: 8_000,
    modelMenuInitialTimeoutMs: 6_000,
  };

  // 숨김 판정 결과 캐시. isHiddenHistoryFile은 파일 전체를 읽어야 해서(내용 기반 판정) 채팅 목록
  // 조회(GET /chats)마다 모든 채팅의 JSONL을 다시 읽으면 큰 세션(수십 MB) 하나에 100ms 이상씩
  // 이벤트 루프가 막혔다(실측 27MB 113ms). 실제 사용자 대화가 한 번이라도 확인된 파일은 이후에
  // 지워질 수 없으므로 영구히 false로 확정하고, 숨김 파일만 mtime이 바뀌었을 때 다시 검사한다.
  private readonly hiddenHistoryVerdicts = new Map<string, { mtimeMs: number; hidden: boolean }>();

  constructor(private readonly settingsFile: string, private readonly hookEnvironment: Record<string, string>) {}

  // 새 Claude TUI 또는 저장된 세션 resume 명령을 구성한다.
  createLaunch(_cwd: string, resumeSessionId?: string): ProviderLaunch {
    const args = ["--settings", this.settingsFile];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    return { command: "claude", args, env: this.hookEnvironment };
  }

  // 상태 조회는 인증·내장 명령만 유지하고 훅·MCP·플러그인과 장식 렌더링을 생략한다.
  createMonitorLaunch(_cwd: string): ProviderLaunch {
    return { command: "claude", args: ["--safe-mode", "--ax-screen-reader"] };
  }

  // Claude 세션 기록 파일을 공통 세션 형태로 변환한다.
  parseHistoryFile(file: string): HistorySession | null {
    return parseClaudeHistory(file);
  }

  // 변경된 Claude JSONL 레코드만 캐시된 세션에 합친다.
  appendHistoryLines(file: string, previous: HistorySession, lines: string[]): HistorySession | undefined {
    return appendClaudeHistory(file, previous, lines);
  }

  // Claude JSONL의 stop_reason=end_turn assistant만 실제 완료로 보아 중간 조각 알림을 막는다.
  evaluateHistorySync(context: HistorySyncContext): HistorySyncDecision {
    const markBusy = context.newMessages.some((message) => message.role === "user" && message.kind !== "tool_result")
      || context.newMessages.some((message) => message.role === "assistant" && message.kind === "tool_call");
    const notifyCompletion = context.newMessages.some((message) => message.role === "assistant" && message.kind === "turn_end");
    return { markBusy, clearBusy: notifyCompletion || context.isTurnEnd, notifyCompletion };
  }

  // 실제 사용자 대화가 없는 Claude 내부 기록인지 판정한다.
  isHiddenHistoryFile(file: string): boolean {
    const cached = this.hiddenHistoryVerdicts.get(file);
    if (cached && !cached.hidden) return false;
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      return false;
    }
    if (cached && cached.mtimeMs === mtimeMs) return cached.hidden;
    const hidden = isClaudeInternalOnlyHistory(file);
    this.hiddenHistoryVerdicts.set(file, { mtimeMs, hidden });
    return hidden;
  }

  // Claude TUI가 입력 가능한 상태인지 판정한다.
  isReady(output: string): boolean {
    return isClaudeReady(output);
  }

  // Claude TUI가 응답 생성 중인지 판정한다.
  isBusy(output: string): boolean {
    return isClaudeBusy(output);
  }

  // Claude 입력창에 남은 미전송 텍스트를 읽는다(입력창이 없는 화면이면 null).
  readPromptDraft(output: string): string | null {
    return readClaudePromptDraft(output);
  }

  // Claude /usage 화면에서 사용량 상태를 구조화한다.
  parseUsage(output: string, now: Date = new Date()): Partial<UsageRecord> {
    const text = stripAnsi(output);
    const authRequired = /(sign in|login required|not authenticated|로그인)/i.test(text);
    const windows = parseClaudeWindows(text);
    const primary = windows[0];
    const success = windows.length > 0 && !authRequired;
    const stale = success && windows.some((window) => !!window.resetAt && isExpiredResetTime(window.resetAt, now));
    return {
      provider: "claude",
      summary: success ? windows.map((window) => `${window.label}: ${window.usedPercent}% used`).join("\n") : null,
      used_percent: primary?.usedPercent ?? null,
      remaining_percent: primary?.remainingPercent ?? null,
      reset_at: primary?.resetAt ?? null,
      details_json: success ? JSON.stringify({ windows, activity: [] }) : null,
      data_status: !success ? "unavailable" : stale ? "stale" : "fresh",
      error_code: authRequired ? "auth_required" : success ? null : "parse_failed",
    };
  }

  // Claude 훅 밖에서 TUI가 직접 묻는 rate limit 선택 화면을 감지한다.
  // "You've hit your session limit"은 상태 배너라 화면이 넘어간 뒤에도 스크롤백에 한참 남아있어,
  // 그것만으로 판단하면 이미 지나간 화면을 오탐하게 된다. "Enter to confirm · Esc to cancel"
  // 푸터는 세션 한도 화면 말고도 디렉터리 신뢰 확인(y/n) 등 다른 여러 프롬프트에서 똑같이 뜨는
  // 공통 문구라 이것만으로는 실제로 오탐했다(디렉터리 신뢰 화면이 한도 선택으로 잘못 표시됨).
  // 한도 선택 화면에서만 뜨는 "Enter selection [1-2]"가 있을 때만 승인 요청으로 본다.
  // "Enter y/n:"은 디렉터리 신뢰 확인처럼 Claude가 y/n 하나로만 답을 요구하는 화면에서 뜨는 표시라
  // confirm_yn으로 따로 감지한다 — 안 그러면 그 화면에서 웹으로 응답할 방법이 아예 없어 세션이
  // 그대로 막힌다(원본 터미널을 직접 열어야만 y/n을 입력할 수 있었음).
  // captureSnapshot()은 tmux pane 전체 높이를 캡처하는데, 실제 프롬프트가 화면 위쪽에 있고 커서까지
  // 빈 줄이 남아있으면(예: 35줄 pane에 내용은 10줄뿐) 그 빈 줄들이 그대로 "마지막 N줄"이 되어 실제
  // 내용을 통째로 놓친다 — 줄로 자르기 전에 끝의 빈 줄부터 먼저 제거해야 한다.
  // 터미널을 껐다 켜서 세션을 재개할 때(`claude --resume`), 저장된 기록이 크면 Claude가 "Resume from
  // summary / Resume full session as-is / Don't ask me again" 3지선다를 띄우고 그대로 입력을 기다린다.
  // rate_limit_options와 같은 "Enter selection [N-N]" 푸터를 쓰지만 옵션 개수가 달라 별도
  // requestType(resume_session_prompt)으로 감지해야 웹 승인카드로 전환된다.
  // 이 화면은 Claude가 전체 화면을 지우지 않고 그 아래에 이어서 그리는 경우가 있어, 사용자가 이미
  // (원본 터미널 등에서) 답하고 응답 생성("esc to interrupt")이나 대기 상태("$")로 넘어갔는데도
  // 지나간 프롬프트 문구가 스냅샷에 같이 남아 계속 승인 요청으로 오검출됐다(닫기도 "아직 응답을
  // 기다리는 중"이라며 막힘). 그래서 "Enter selection [1-3]:" 줄이 화면에서 가장 최근 것인지, 즉
  // 그 뒤에 응답 생성/대기 표시가 없는지까지 확인해야 지금도 실제로 떠 있는 프롬프트로 본다.
  detectApproval(output: string): ApprovalHint | null {
    const lines = stripAnsi(output).replace(/\s+$/, "").split("\n");
    const tailText = lines.slice(-18).join("\n");
    // "Enter y/n:"만 단순히 화면에 있는지 봐서는 안 된다 — 이 문구 자체가 이 기능을 설명하는 우리
    // 코드 주석·문서·커밋 메시지에 리터럴로 들어있어서, 이 채팅 안에서 grep/cat/git show로 그 내용을
    // 출력하거나 이 기능을 설명하는 답변을 쓰기만 해도(둘 다 Bash 도구 출력·assistant 텍스트로 같은
    // tmux 화면에 그대로 찍힘) 실제 프롬프트가 아닌데도 confirm_yn으로 오탐되는 걸 실제로 겪었다.
    // resume_session_prompt·generic_permission_prompt·rate_limit_options와 같은 방식으로, 그 뒤에
    // 응답 생성("esc to interrupt")이나 대기 상태("$")로 이미 넘어갔는지까지 확인해야 지금 실제로
    // 떠 있는 프롬프트로 본다. 이 판정은 여러 후보 화면에 공통이라 한 번만 계산해 재사용한다.
    // 그런데도 실제로 또 오탐이 났다 — CODETREE.md의 표 한 줄(claude.ts 설명)이 원래 수천 자짜리라
    // 넓은 pane에서도 여러 줄로 접혀 나오는데, 그 안에 "Enter y/n:"이 포함돼 있어서 git diff/cat으로
    // 그 줄을 띄우면 staleIndex보다 뒤로 밀려 오탐이 재현됐다(실사용 중 확인, 2026-07-11). 진짜 확인
    // 화면은 "Enter y/n:"가 그 줄에 단독으로(앞뒤에 다른 문장 없이) 찍히는데(아래 테스트 fixture 참고),
    // 우리가 이 기능을 설명할 때는 항상 긴 문장 중간에 인용부호로 끼워 넣으므로 그 줄 전체가 이
    // 문구만은 아니다 — "그 줄이 이 문구 자체인지"까지 요구해 훨씬 좁힌다.
    const staleIndex = Math.max(lastMatchIndex(lines, /esc to interrupt/i), lastMatchIndex(lines, /^\s*\$\s*$/i), (() => {
      for (let index = lines.length - 1; index >= 0; index -= 1) if (isClaudePromptLine(lines[index])) return index;
      return -1;
    })());
    const confirmIndex = lastMatchIndex(lines, /^\s*Enter y\/n:\s*$/i);
    if (confirmIndex >= 0 && staleIndex < confirmIndex) return { requestType: "confirm_yn", summary: tailText.trim() };
    const resumeFooterIndex = Math.max(lastMatchIndex(lines, /Enter selection \[1-3\]/i), lastMatchIndex(lines, /Enter to confirm\s*·\s*Esc to cancel/i));
    if (resumeFooterIndex >= 0 && staleIndex < resumeFooterIndex && /Resume from summary/i.test(tailText)) {
      return { requestType: "resume_session_prompt", summary: tailText.trim() };
    }
    // claude-in-chrome 등 브라우저 도구 권한 화면은 제목 문구가 바뀌거나 footer 없이 선택지 3줄만
    // 떠 있을 수 있다. 제목 대신 실제 선택지 구조와 화면 하단 위치를 확인해, assistant 답변·도구
    // 출력에 포함된 설명 문구를 승인 요청으로 오탐하지 않게 한다.
    const browserPermissionIndex = browserPermissionPromptIndex(lines);
    if (browserPermissionIndex >= 0 && staleIndex < browserPermissionIndex) {
      return { requestType: "browser_permission_prompt", summary: tailText.trim() };
    }
    // PermissionRequest 훅이 어떤 이유로든(계획 모드의 내장 편집 제한, 훅 호출 실패 등) 이 화면을
    // 못 가로채면, 웹 승인 카드 없이 원본 터미널에만 이 네이티브 1/2/3 프롬프트가 뜬 채로 막힌다
    // (실제로 겪음). "Enter selection [1-3], or Escape to cancel:"이 resume_session_prompt의
    // "Enter selection [1-3]:"과 겹치는 범위라, 콤마+"or Escape to cancel" 꼬리와 "Permission
    // Required:" 헤더를 같이 요구해 구분한다.
    const permissionFooterIndex = lastMatchIndex(lines, /Enter selection \[1-3\], or Escape to cancel:/i);
    if (permissionFooterIndex >= 0 && staleIndex < permissionFooterIndex && /Permission Required:/i.test(tailText)) {
      return { requestType: "generic_permission_prompt", summary: tailText.trim() };
    }
    // 최신 Claude는 예전 전용 푸터 "Enter selection [1-2]"를 없애고 여러 메뉴가 공유하는
    // "Enter to confirm · Esc to cancel"만 표시한다. 공통 푸터 단독 판정은 오탐 위험이 있으므로 제목과
    // wait/upgrade 두 선택지 구조가 가까이 함께 있는지 확인하고, 이미 응답 생성·idle로 넘어간 화면도
    // staleIndex와 화면 하단 검사로 제외한다.
    const structuredRateLimitIndex = rateLimitPromptIndex(lines);
    if (structuredRateLimitIndex >= 0 && staleIndex < structuredRateLimitIndex) {
      return { requestType: "rate_limit_options", summary: tailText.trim() };
    }
    // 예전 screen-reader 형식처럼 전용 푸터만 확실히 제공하는 화면도 계속 지원한다.
    const rateLimitFooterIndex = lastMatchIndex(lines, /Enter selection \[1-2\]/i);
    if (rateLimitFooterIndex >= 0 && staleIndex < rateLimitFooterIndex) {
      return { requestType: "rate_limit_options", summary: tailText.trim() };
    }
    // 선택 메뉴 없이 "한도에 걸렸다"는 배너만 지나가듯 뜨고 곧바로 idle 프롬프트로 돌아가는 경우가
    // 있다(예: "⎿  You've hit your session limit · resets 7:10pm (Asia/Seoul)"). 이 배너는 응답을
    // 막고 있는 게 아니라서 위 프롬프트들과 달리 뒤에 idle이 있는 게 정상이다. 다만 세션을 재개하면
    // 기록 중간의 예전 배너도 현재 pane에 다시 그려질 수 있으므로, 배너 뒤에는 유휴 프롬프트·상태줄만
    // 있어야 한다. 사용자 입력·도구 결과·후속 답변이 하나라도 이어졌으면 이미 해소된 배너다. 문구도
    // 실제 배너처럼 줄 맨 앞(공백 제외)이 "⎿"로 시작하는 경우만 받아 코드·문서 출력 오탐을 막는다.
    const sessionLimitIndex = lastMatchIndex(lines, /^\s*⎿\s+You(?:'|’)ve hit your session limit\b/i);
    if (sessionLimitIndex >= 0 && hasOnlyIdleChromeAfter(lines, sessionLimitIndex)) {
      return { requestType: "session_limit_notice", summary: lines[sessionLimitIndex].trim() };
    }
    return null;
  }

  // rate limit 선택 화면은 실제로 "1. 재설정까지 대기 / 2. 플랜 업그레이드" 두 개뿐이라 그대로 매핑하고,
  // y/n 확인 화면은 실제 문자 그대로 y/n을 보낸다(Esc는 답하지 않고 화면만 취소해 세션이 계속
  // 막힌 채로 남으므로 여기선 쓰지 않는다). 그 외 유형은 accept 계열을 1번으로 보수적으로 처리하고
  // 거부·취소는 Esc로 메뉴를 닫는다.
  approvalInput(decision: "accept" | "acceptForSession" | "decline" | "cancel", requestType: string): string {
    if (requestType === "confirm_yn") return decision === "decline" || decision === "cancel" ? "n\r" : "y\r";
    // 세션 재개 3지선다는 Esc로 취소할 수 없는 화면이라, "거부"도 실제 3번(다시 안 물어봄) 선택으로 보낸다.
    if (requestType === "resume_session_prompt") {
      if (decision === "acceptForSession") return "2\r";
      if (decision === "decline" || decision === "cancel") return "3\r";
      return "1\r";
    }
    if (requestType === "browser_permission_prompt") {
      if (decision === "acceptForSession") return "3\r";
      if (decision === "decline" || decision === "cancel") return "2\r";
      return "1\r";
    }
    if (decision === "decline" || decision === "cancel") return "\u001b";
    if (requestType === "rate_limit_options") return decision === "acceptForSession" ? "2\r" : "1\r";
    return "1\r";
  }

  // rate_limit_options 자동 처리 전용. "대기"가 항상 1번이라는 보장이 없어(문구·순서가 버전마다 바뀔 수
  // 있음), 화면에 실제로 뜬 선택지 문구에서 "wait"(대기)/"upgrade"(업그레이드) 키워드로 번호를 찾는다.
  // 못 찾으면 null을 반환해 approvalInput의 고정 매핑으로 추측해 보내지 않게 한다.
  resolveRateLimitInput(decision: "accept" | "acceptForSession", output: string): string | null {
    const lines = stripAnsi(output).replace(/\s+$/, "").split("\n").slice(-18);
    const keyword = decision === "acceptForSession" ? /upgrade/i : /wait/i;
    const line = lines.find((candidate) => /^\s*[›❯>]?\s*\d+[.)]\s+/.test(candidate) && keyword.test(candidate));
    const match = line?.match(/^\s*[›❯>]?\s*(\d+)[.)]/);
    return match ? `${match[1]}\r` : null;
  }

  // 시작 배너 "Sonnet 5 · Claude Pro · ..."에서 모델명을 읽는다. 이 배너는 세션 시작 시 한 번만
  // 그려지고 이후 상단 상태줄에 다시 나오지 않아, 대화가 길어지면 tmux capture-pane이 보는 현재
  // 화면(스크롤백 전체가 아님) 밖으로 밀려나 사라진다 — 그러면 모델을 바꿔도 배너로는 더 이상 감지가
  // 안 돼 웹에 표시되는 현재 모델이 갱신되지 않았다. /model로 모델을 바꾸면 그 직후 "Set model to
  // X ..." 확인 메시지가 방금 출력된 줄로 화면 맨 아래(항상 현재 화면 안)에 뜨므로, 배너를 못 찾을
  // 때는 이 확인 메시지에서 모델명을 읽는다. 같은 화면에 이전 변경 메시지가 여러 개 남아있을 수
  // 있어 가장 마지막(최신) 것만 쓴다.
  detectModel(output: string): string | null {
    const text = stripAnsi(output);
    const plainBanner = text.match(/(?:^|\s{2,})([A-Za-z][A-Za-z0-9 ._-]*?)\s+with\s+(?:low|medium|high|xhigh|max)\s+effort\s*·\s*Claude\b/m);
    if (plainBanner) return plainBanner[1].trim();
    const banner = text.match(/^([^\n·]+?)\s*·\s*Claude\b/m);
    if (banner) return banner[1].trim();
    const confirmations = [...text.matchAll(/Set model to (.+?)\s+(?:and saved as your default for new sessions|for this session only)\b/g)];
    return confirmations.length ? confirmations[confirmations.length - 1][1].trim() : null;
  }

  // Claude /model 화면에서 선택 가능한 모델과 현재 effort 값을 읽는다.
  parseModelOptions(output: string): ModelOptions {
    const text = stripAnsi(output);
    let currentEffort: string | null = null;
    const parsedEfforts = text.split("\n").flatMap((line): ModelChoice[] => {
      const match = line.trim().match(/^(?:[›❯>]\s*)?(?:(\d+)[.)]\s+)?(?:(?:\((?:selected|current)\)|[✓*○●◐◑◒◓])\s*)?(Low|Medium|High|xHigh|Max)\s+effort\b(.*)$/i);
      if (!match) return [];
      const id = claudeEffortId(match[2]);
      if (!id) return [];
      const selected = /\((?:selected|current)\)|[✓*○●◐◑◒◓]/i.test(line);
      if (selected) currentEffort = id;
      return [{ index: Number(match[1] ?? (CLAUDE_EFFORTS.find((effort) => effort.id === id)?.index ?? 0)), id, label: CLAUDE_EFFORTS.find((effort) => effort.id === id)?.label ?? match[2], description: match[3]?.replace(/\((?:selected|current)\)/i, "").trim(), current: selected }];
    });
    currentEffort ??= lastClaudeEffortId(text, /\bcurrent\s+effort\s*[:：]\s*(Low|Medium|High|xHigh|Max)\b/gi);
    currentEffort ??= lastClaudeEffortId(text, /\beffort\s*[:：]\s*(Low|Medium|High|xHigh|Max)\b/gi);
    currentEffort ??= lastClaudeEffortId(text, /[●○◐◑◒◓]\s*(Low|Medium|High|xHigh|Max)\s*·\s*\/effort\b/gi);
    // 지금 CLI는 목록이 아니라 "●/○ 단계 effort ←/→ to adjust" 같은 게이지 한 줄만 보여준다(번호·
    // (selected) 표시가 없어 위 매치들이 다 실패함). 이 한 줄이 현재 값 그 자체이므로 그대로 읽는다.
    currentEffort ??= lastClaudeEffortId(text, /\b(Low|Medium|High|xHigh|Max)\s+effort\b/gi);
    currentEffort ??= lastClaudeEffortId(text, /\beffort\s+level\s+to\s+(Low|Medium|High|xHigh|Max)\b/gi);
    const models = text.split("\n").flatMap((line): ModelChoice[] => {
      const trimmed = line.trim();
      const dashed = trimmed.match(/^(?:[›❯>]\s*)?(\d+)[.)]\s+(?:(\((?:selected|current)\)|[✓*])\s+)?(.+?)(?:\s+\((?:selected|current)\))?\s+—\s+(.+)$/i);
      const columns = trimmed.match(/^(?:[›❯>]\s*)?(\d+)[.)]\s+(.+?)\s{2,}(.+)$/i);
      const match = dashed ?? columns;
      if (!match) return [];
      const label = (dashed ? match[3] : match[2]).replace(/[✓✔*]/g, "").trim();
      const description = (dashed ? match[4] : match[3]).trim();
      return [{
        index: Number(match[1]),
        id: label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || String(match[1]),
        label,
        description,
        current: !!dashed?.[2] || /\((?:selected|current)\)|[✓✔*]|^\s*[›❯>]/i.test(line),
      }];
    });
    const selectedModel = models.find((model) => model.current);
    const selectedModelName = selectedModel?.description?.split("·")[0]?.trim() || selectedModel?.label || null;
    const efforts = CLAUDE_EFFORTS.map((effort) => ({ ...effort, current: effort.id === currentEffort }));
    for (const parsed of parsedEfforts) {
      const index = efforts.findIndex((effort) => effort.id === parsed.id);
      if (index >= 0) efforts[index] = { ...efforts[index], index: parsed.index || efforts[index].index, description: parsed.description, current: parsed.current || efforts[index].current };
    }
    return {
      provider: "claude",
      currentModel: this.detectModel(text) ?? selectedModelName,
      currentEffort,
      models,
      efforts,
    };
  }

  // Claude /model 단일 화면의 모델 목록 또는 effort 게이지가 실제로 열렸는지 판정한다.
  isModelMenu(output: string, part: "models" | "efforts"): boolean {
    if (part === "models") return this.parseModelOptions(output).models.length > 0;
    return /^\s*[›❯>]?\s*(?:\d+[.)]\s+)?(?:\((?:selected|current)\)|[✓*○●◐◑◒◓])?\s*(Low|Medium|High|xHigh|Max)\s+effort\b/im.test(stripAnsi(output));
  }

  // Claude 실제 /model 화면에서 안정 ID와 같은 모델을 다시 찾아 현재 번호로 선택한다.
  async applyModelSelection(io: TmuxIO, _modelIndex: number, _effortId: string | null, modelId?: string | null): Promise<void> {
    if (!await io.waitForModelMenu("models", 2_500)) throw new Error("Claude 모델 선택 화면을 찾지 못했습니다.");
    const targetFamily = claudeModelFamily(modelId);
    if (!targetFamily) throw new Error("유효하지 않은 Claude 모델 선택입니다.");
    const models = this.parseModelOptions(io.snapshot()).models;
    const exact = models.find((model) => model.id === modelId);
    const target = exact ?? models.find((model) => claudeModelFamily(`${model.id} ${model.label}`) === targetFamily);
    if (!target) throw new Error("Claude 현재 모델 메뉴에서 선택 항목을 찾지 못했습니다.");
    io.sendText(String(target.index));
    io.sendEnter();
  }

  // Claude 최신 TUI는 추론 강도를 /effort <id> slash 명령으로 직접 바꾼다.
  effortCommand(effortId: string): string | null {
    return claudeEffortId(effortId) ? `/effort ${effortId}` : null;
  }

  // 하단 상태줄 문구("auto mode on (shift+tab to cycle)", "manual mode on · ...", "accept edits on
  // (shift+tab to cycle)", "plan mode on (shift+tab to cycle)")에서 현재 권한 모드를 읽는다. 버전에
  // 따라 문구가 바뀔 수 있어 고정된 이름으로 번역하지 않고 CLI가 실제로 보여주는 문구를 그대로 쓴다.
  detectPermissionMode(output: string): string | null {
    const lines = stripAnsi(output).replace(/\s+$/, "").split("\n");
    for (const line of lines.slice(-6).reverse()) {
      const match = line.match(/\b([a-z][a-z ]*?\b(?:mode|edits|permissions) on)\b/i);
      if (match) return match[1].trim().replace(/\s+/g, " ");
    }
    return null;
  }
}
