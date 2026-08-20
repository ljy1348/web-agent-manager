import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ApprovalHint, HistoryMessage, HistorySyncContext, HistorySyncDecision, HistorySession, HistoryTokenUsage, ModelChoice, ModelOptions, ProviderAdapter, ProviderLaunch, TmuxIO } from "./provider";
import type { UsageRecord, UsageWindow } from "../../shared/types";
import { extractContent, fallbackId } from "./history-utils";
import { stripAnsi } from "../core/security";
import { isExpiredResetTime } from "./usage-utils";

// Grok은 세션 하나를 파일이 아니라 디렉터리로 저장한다(`<기록루트>/<URL인코딩 cwd>/<세션UUID>/`).
// 대화 본문은 chat_history.jsonl, 턴 종료는 events.jsonl, 턴 토큰은 updates.jsonl에 있으므로
// 셋을 같은 세션의 입구로 받아들인다(아래 parseHistoryFile 주석 참고).
const CHAT_HISTORY_FILE = "chat_history.jsonl";
const EVENTS_FILE = "events.jsonl";
const UPDATES_FILE = "updates.jsonl";

// 사용자가 실제로 친 메시지만 이 태그로 감싸여 들어온다. 같은 user 레코드로 들어오는 <user_info>,
// <git_status>, <system-reminder> 같은 자동 주입 블록을 사람 발화로 오인하지 않기 위한 구분자다.
const USER_QUERY_PATTERN = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/;

// 승인 화면 푸터에만 나오는 선택 안내("1/4:select"). 제목·선택지 문구는 도구마다 달라지지만 이 푸터는
// 공통이라, 코드·문서 출력에 섞인 비슷한 문장을 승인 요청으로 오탐하지 않는 기준으로 쓴다.
const APPROVAL_FOOTER_PATTERN = /^\s*\d+\/\d+:select\b/;

// 승인 화면의 라디오 선택지 한 줄(예: "┃  2 (○) Yes, allow all edits during this session").
const APPROVAL_OPTION_PATTERN = /^\s*[┃|]?\s*(\d+)\s*\(\s*[●○]\s*\)\s*(.+?)\s*$/;

// 입력창 아래 상태줄. 응답 생성 중에만 취소 안내가 함께 뜬다.
const STATUS_BAR_PATTERN = /(?:^|\s)Shift\+Tab:mode\b/;
const BUSY_STATUS_PATTERN = /(?:^|\s)Esc:cancel(?:\s|$)/;

// 입력창 아래 테두리 오른쪽에 항상 붙는 "Grok 4.6 (high) · auto" 꼬리. 모델·추론강도·권한 모드를
// 한 줄에서 같이 읽는다. 시작 배너와 달리 대화가 길어져도 화면에서 사라지지 않는다.
const MODEL_TAG_PATTERN = /─\s*(Grok\s+[^()·─]+?)\s*\(([^)]+)\)\s*(?:·\s*([a-z-]+)\s*)?─/i;

// 세션 디렉터리의 summary.json을 읽는다. 제목·모델·시각의 1차 출처다.
function readSessionSummary(directory: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(directory, "summary.json"), "utf8"));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

// events.jsonl에서 가장 마지막 turn_ended 시각을 읽는다. Grok은 chat_history.jsonl에 stop_reason 같은
// 턴 종료 표시를 남기지 않아, "응답이 실제로 끝났는지"를 알 수 있는 곳은 이 이벤트뿐이다.
function readLastTurnEndedAt(directory: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(directory, EVENTS_FILE), "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line || !line.includes("turn_ended")) continue;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record.type === "turn_ended" && typeof record.ts === "string") return record.ts;
    } catch {
      continue;
    }
  }
  return null;
}

// Grok 숫자 필드가 유한한 0 이상일 때만 채팅 공통 usage로 가져온다.
function grokUsageNumber(usage: Record<string, unknown>, key: string): number {
  const value = usage[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

// turn_completed.usage를 Claude·Codex와 같은 HistoryTokenUsage로 바꾼다.
// 실측상 inputTokens에 캐시 읽기가 포함되고 totalTokens = input + output이라 Codex처럼 부분집합으로 둔다.
function parseGrokTurnUsage(update: Record<string, unknown>): HistoryTokenUsage | undefined {
  if (update.sessionUpdate !== "turn_completed" || !update.usage || typeof update.usage !== "object") return undefined;
  const usage = update.usage as Record<string, unknown>;
  const inputTokens = grokUsageNumber(usage, "inputTokens");
  const cachedInputTokens = grokUsageNumber(usage, "cachedReadTokens");
  const cacheCreationInputTokens = grokUsageNumber(usage, "cacheCreationTokens");
  const outputTokens = grokUsageNumber(usage, "outputTokens");
  const reasoningOutputTokens = grokUsageNumber(usage, "reasoningTokens");
  const totalTokens = grokUsageNumber(usage, "totalTokens") || inputTokens + outputTokens;
  if (!totalTokens) return undefined;
  return { inputTokens, cachedInputTokens, cacheCreationInputTokens, cacheReadInputTokens: 0, outputTokens, reasoningOutputTokens, totalTokens };
}

// updates.jsonl의 turn_completed를 기록된 순서대로 읽는다. 대화 본문에는 usage가 없다.
function readGrokTurnUsages(directory: string): HistoryTokenUsage[] {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(directory, UPDATES_FILE), "utf8");
  } catch {
    return [];
  }
  const usages: HistoryTokenUsage[] = [];
  for (const line of raw.split("\n")) {
    // updates.jsonl에는 턴 중 도구 진행·사고 조각이 계속 쌓여(실측 410줄 중 turn_completed는 4줄)
    // 모든 줄을 JSON으로 풀면 파싱 비용이 대부분 버려진다. 필요한 줄만 먼저 걸러낸다.
    if (!line.includes("turn_completed")) continue;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      const params = record.params && typeof record.params === "object" ? record.params as Record<string, unknown> : null;
      const update = params?.update && typeof params.update === "object" ? params.update as Record<string, unknown> : null;
      const tokenUsage = update ? parseGrokTurnUsage(update) : undefined;
      if (tokenUsage) usages.push(tokenUsage);
    } catch {
      continue;
    }
  }
  return usages;
}

// 턴 단위 usage를 그 턴의 마지막 내용 있는 assistant에만 붙인다. Codex token_count 연결과 같다.
function attachGrokTurnUsages(messages: HistoryMessage[], usages: HistoryTokenUsage[]): void {
  const userIndexes: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index].role === "user") userIndexes.push(index);
  }
  for (let turn = 0; turn < usages.length; turn += 1) {
    const start = userIndexes[turn];
    if (start === undefined) break;
    const end = userIndexes[turn + 1] ?? messages.length;
    for (let index = end - 1; index > start; index -= 1) {
      if (messages[index].role !== "assistant") continue;
      messages[index] = { ...messages[index], tokenUsage: usages[turn] };
      break;
    }
  }
}

// user 레코드에서 사람이 실제로 친 발화만 꺼낸다. 자동 주입 블록만 들어있으면 null이라 목록·제목에
// <system-reminder> 같은 내용이 새어나가지 않는다.
function extractUserQuery(content: string): string | null {
  const match = content.match(USER_QUERY_PATTERN);
  if (match) return match[1].trim() || null;
  // 태그가 없는 user 레코드는 전부 CLI가 만든 컨텍스트 주입이다(<user_info>, <git_status>,
  // <system-reminder>, MCP 연결 안내 등). 사람 발화로 세지 않는다.
  return null;
}

// Grok chat_history.jsonl 레코드 하나를 공통 메시지 형태로 변환한다.
function parseGrokMessage(record: Record<string, unknown>, line: string, index: number): HistoryMessage | null {
  const type = String(record.type ?? "");
  // reasoning은 모델의 내부 사고 요약이라 채팅 본문에 섞지 않는다. backend_tool_call·system도 마찬가지로
  // 사람이 읽을 대화가 아니다.
  if (!["user", "assistant", "tool_result"].includes(type)) return null;
  const rawContent = record.content;
  const content = extractContent(rawContent);
  if (type === "user") {
    const query = extractUserQuery(content);
    if (!query) return null;
    return {
      id: String(record.prompt_index !== undefined ? `prompt-${String(record.prompt_index)}` : fallbackId(`${index}:${line}`)),
      role: "user",
      kind: "text",
      content: query,
      createdAt: new Date().toISOString(),
    };
  }
  if (type === "tool_result") {
    if (!content) return null;
    return {
      id: String(record.tool_call_id ?? fallbackId(`${index}:${line}`)),
      role: "tool",
      kind: "tool_result",
      content,
      createdAt: new Date().toISOString(),
    };
  }
  // assistant 레코드는 도구를 호출하기 직전의 설명 문장으로도 남고(내용 있음), 도구만 부르고 지나가는
  // 빈 문자열로도 남는다. 빈 것은 화면에 띄울 게 없으니 버린다.
  if (!content) return null;
  return {
    id: fallbackId(`${index}:${line}`),
    role: "assistant",
    kind: "text",
    content,
    createdAt: new Date().toISOString(),
  };
}

// chat_history.jsonl 전체를 읽어 공통 세션 형태로 만든다.
function parseGrokHistory(directory: string): HistorySession | null {
  const historyFile = path.join(directory, CHAT_HISTORY_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(historyFile, "utf8");
  } catch {
    return null;
  }
  const summary = readSessionSummary(directory);
  const info = summary?.info && typeof summary.info === "object" ? summary.info as Record<string, unknown> : {};
  const cwd = typeof info.cwd === "string" ? info.cwd : "";
  if (!cwd) return null;
  const sessionId = typeof info.id === "string" ? info.id : path.basename(directory);
  const messages: HistoryMessage[] = [];
  const lines = raw.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const message = parseGrokMessage(record, line, index);
    if (message) messages.push(message);
  }
  attachGrokTurnUsages(messages, readGrokTurnUsages(directory));
  const createdAt = typeof summary?.created_at === "string" ? summary.created_at : new Date().toISOString();
  const updatedAt = typeof summary?.updated_at === "string" ? summary.updated_at : createdAt;
  const firstUser = messages.find((message) => message.role === "user");
  const generatedTitle = typeof summary?.generated_title === "string" ? summary.generated_title.trim() : "";
  const sessionSummary = typeof summary?.session_summary === "string" ? summary.session_summary.trim() : "";
  return {
    provider: "grok",
    sessionId,
    cwd,
    title: (firstUser?.content ?? generatedTitle ?? "").slice(0, 80) || "Grok 세션",
    historyFile,
    createdAt,
    updatedAt,
    messages,
    model: typeof summary?.current_model_id === "string" ? summary.current_model_id : null,
    turnEndedAt: readLastTurnEndedAt(directory),
    displayTitle: generatedTitle || sessionSummary || null,
  };
}

// 사람이 실제로 친 발화가 한 번이라도 있는 기록인지 확인한다. 사용량 조회 전용 PTY도 grok 세션
// 디렉터리를 만들지만 슬래시 명령만 보내서 <user_query>가 하나도 남지 않는다.
function hasGrokUserQuery(chatHistoryFile: string): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(chatHistoryFile, "utf8");
  } catch {
    return false;
  }
  for (const line of raw.split("\n")) {
    if (!line.includes("<user_query>")) continue;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record.type !== "user") continue;
      if (extractUserQuery(extractContent(record.content))) return true;
    } catch {
      continue;
    }
  }
  return false;
}

// 화면에서 ANSI를 걷어내고 끝의 빈 줄을 없앤 줄 배열을 만든다. tmux는 pane 높이만큼 캡처해서 실제
// 내용 아래에 빈 줄이 잔뜩 붙는데, 그대로 "마지막 N줄"을 보면 내용을 통째로 놓친다.
function grokScreenLines(output: string): string[] {
  return stripAnsi(output).replace(/\s+$/, "").split("\n");
}

// 승인 화면의 선택지 목록을 번호·문구 쌍으로 읽는다.
function parseApprovalOptions(lines: string[]): Array<{ index: string; label: string }> {
  const options: Array<{ index: string; label: string }> = [];
  for (const line of lines) {
    const match = line.match(APPROVAL_OPTION_PATTERN);
    if (match) options.push({ index: match[1], label: match[2] });
  }
  return options;
}

// 승인 화면이 지금 실제로 떠 있는지 확인한다. 푸터가 화면 맨 아래쪽에 있어야 하고 선택지도 함께 보여야
// 한다 — 승인 문구가 도구 출력·문서로 지나간 화면을 승인 요청으로 오탐하지 않기 위한 조건이다.
function approvalScreenIndex(lines: string[]): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!APPROVAL_FOOTER_PATTERN.test(lines[index])) continue;
    // 푸터 위쪽에 라디오 선택지가 실제로 그려져 있어야 진짜 승인 화면이다.
    return parseApprovalOptions(lines.slice(Math.max(0, index - 12), index)).length >= 2 ? index : -1;
  }
  return -1;
}

// 사용량 모달은 테두리 문자(│)로 감싸여 그려진다. 파싱 전에 테두리를 걷어내고 줄 단위로 정리한다.
function grokUsageLines(text: string): string[] {
  return text.split("\n").map((line) => line.replace(/[│┃|]/g, " ").replace(/\s+$/, "").trim());
}

// 진행 막대와 퍼센트만 있는 줄("█████░░░░  16%"). 사용량 창을 찾는 앵커다.
const USAGE_BAR_PATTERN = /^[█▓▒░\s]*?(\d+(?:\.\d+)?)\s*%$/;

// 사용량 창을 제목이 아니라 막대·퍼센트 줄을 앵커로 찾는다. 제목("Weekly limit (SuperGrok)")은 플랜마다
// 다른 데다, tmux 화면 캡처가 간헐적으로 글자를 흘려("Weekly  imit") 제목을 조건으로 걸면 그 주기의
// 사용량이 통째로 파싱 실패로 떨어진다(실측). 숫자와 "Resets:" 키워드는 훨씬 안정적이라 그것으로 찾고,
// 제목은 표시용으로만 위쪽에서 주워온다.
function parseGrokWindows(text: string): UsageWindow[] {
  const lines = grokUsageLines(text);
  const windows: UsageWindow[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const percent = lines[index].match(USAGE_BAR_PATTERN);
    if (!percent) continue;
    const resets = lines.slice(index + 1, index + 4).map((line) => line.match(/^Resets:\s*(.+)$/i)).find(Boolean);
    // 막대 위쪽에서 가장 가까운 실제 텍스트 줄이 그 창의 제목이다(구분선·빈 줄은 건너뛴다).
    let label = "";
    for (let above = index - 1; above >= 0 && above >= index - 4; above -= 1) {
      const candidate = lines[above];
      if (!candidate || /^[─━=_-]+$/.test(candidate)) continue;
      label = candidate.replace(/\s+/g, " ").trim();
      break;
    }
    const usedPercent = Number(percent[1]);
    // 제목에서 "limit"이 통째로 성하지 않으면 캡처가 글자를 흘린 것으로 본다. 그대로 화면에 내보내면
    // 사용자에게는 오타로 보이므로 대표 창에 한해 표시명만 보정하고, 플랜 이름은 화면에서 읽은 값을 쓴다.
    const plan = label.match(/\(([^)]*)\)/)?.[1]?.trim();
    const displayLabel = /limit/i.test(label) ? label : `Weekly limit${plan ? ` (${plan})` : ""}`;
    windows.push({
      // 대표 창 id는 usageWindowId와 같아야 초기화 알림 등이 이어진다. 화면에 창이 하나뿐이라 첫 번째를
      // 대표로 두고, 나중에 창이 늘어나면 제목 슬러그로 구분한다.
      id: windows.length === 0 ? "weekly" : label.toLowerCase().replace(/[^a-z0-9]+/g, "_") || `window_${windows.length}`,
      label: windows.length === 0 ? displayLabel : label || "Weekly limit",
      usedPercent,
      remainingPercent: 100 - usedPercent,
      resetAt: resets ? resets[1].trim() : null,
    });
  }
  return windows;
}

// "Session usage" 블록의 토큰·호출·비용 줄을 그대로 활동 목록으로 남긴다(한도가 아니라 참고 수치라
// 퍼센트 창으로 만들지 않는다).
function parseGrokSessionUsage(text: string): string[] {
  const lines = grokUsageLines(text);
  const start = lines.findIndex((line) => /^Session usage\b/i.test(line));
  if (start < 0) return [];
  const header = lines[start];
  // 모델 호출이 아직 없으면 한 줄로만 표시된다("Session usage: no model calls yet in this session.").
  if (/no model calls/i.test(header)) return [header];
  const details: string[] = [];
  for (const line of lines.slice(start + 1, start + 8)) {
    if (!line) break;
    if (!/^(Input tokens|Output tokens|Total tokens|Model calls|Cost)\b/i.test(line)) break;
    details.push(line);
  }
  return details;
}

export class GrokAdapter implements ProviderAdapter {
  readonly id = "grok" as const;
  readonly displayLabel = "Grok";
  // /usage show가 보여주는 한도는 플랜 주간 창 하나뿐이다(예: "Weekly limit (SuperGrok)").
  readonly usageWindowId = "weekly";
  readonly cliVersionCommand = { command: "grok", args: ["--version"] };
  readonly historyRoot = path.join(os.homedir(), ".grok", "sessions");

  // GROK_HOME을 지정하면 grok이 그 폴더 아래에 sessions/를 새로 만들어 기록을 남긴다.
  historyRootFor(configDir: string | null): string {
    return configDir ? path.join(configDir, "sessions") : this.historyRoot;
  }

  // `/usage`만 보내면 show(사용량 보기)/manage(결제 관리) 하위 선택이 뜨고 거기서 멈춘다. 인자까지
  // 붙여 보내면 자동완성이 show로 확정돼 Enter 한 번에 사용량 화면이 열린다.
  readonly usageCommands = ["/usage show"];

  // 사용량 화면은 입력창을 덮는 모달이라, 파싱 뒤 닫지 않으면 다음 주기의 조회 명령이 입력창이 아니라
  // 모달의 단축키(Tab 전환·c 세션ID 복사 등)로 먹혀버린다.
  readonly usageScreenCloseInput = "\u001b";

  // 숨김 판정 결과 캐시. 판정에 본문 파일을 읽어야 해서(내용 기반) 매 스캔마다 다시 읽지 않도록,
  // 사람 대화가 확인된 파일은 영구히 노출로 확정하고 아직 빈 기록만 mtime이 바뀔 때 다시 본다.
  private readonly hiddenHistoryVerdicts = new Map<string, { mtimeMs: number; hidden: boolean }>();

  readonly promptQuirks = {
    // 긴 bracketed-paste를 TUI가 반영할 시간을 준 뒤 실제 제출 상태까지 확인한다(Claude와 같은 이유).
    pasteSubmitDelayMs: 160,
    verifyPromptSubmission: true,
    // `/model`은 선택 메뉴가 아니라 인자 입력 대기로 들어간다. 목록은 CLI 고정값과 화면 테두리의 현재
    // 값으로 만들 수 있으므로 명령을 보내지 않는다.
    modelOptionsWithoutMenu: true,
  };

  // 새 Grok TUI 또는 저장된 세션 resume 명령을 구성한다.
  createLaunch(_cwd: string, resumeSessionId?: string): ProviderLaunch {
    const args: string[] = [];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    return { command: "grok", args };
  }

  // Grok 세션 기록을 공통 세션 형태로 변환한다.
  //
  // 입구를 chat_history.jsonl·events.jsonl·updates.jsonl로 여는 이유: 대화 본문은 chat_history.jsonl,
  // 턴 종료는 events.jsonl의 turn_ended, 턴 토큰은 updates.jsonl의 turn_completed에만 있다.
  // chat_history.jsonl의 mtime만 보면 마지막 assistant 직후 turn_ended를 놓치거나, 턴이 끝난 뒤
  // 붙는 usage를 캐시된 본문만 읽고 놓친다. 어느 쪽으로 들어와도 historyFile은 chat_history.jsonl로
  // 고정해 DB에 저장되는 경로가 갈리지 않게 한다.
  parseHistoryFile(file: string): HistorySession | null {
    const name = path.basename(file);
    if (name !== CHAT_HISTORY_FILE && name !== EVENTS_FILE && name !== UPDATES_FILE) return null;
    return parseGrokHistory(path.dirname(file));
  }

  // 대화·턴 종료·턴 토큰과 무관한 Grok 내부 기록은 채팅 목록에 올리지 않는다(prompt_history.jsonl,
  // rewind_points.jsonl, hunk_records.jsonl 등).
  //
  // 파일 이름만으로는 부족하다. 사용량 조회 전용 PTY도 일반 세션 디렉터리를 만드는데, 거기엔 슬래시
  // 명령만 오가서 사람 발화가 한 줄도 남지 않는다 — 그대로 두면 조회가 돌 때마다(서버 재시작마다 새
  // 세션) "Grok 세션"이 채팅 목록에 쌓인다(실측 7개). Claude와 같은 방식으로 실제 사용자 대화가 있는
  // 기록만 노출한다. 사이드카로 들어와도 판정 기준은 본문 파일 하나로 통일한다.
  isHiddenHistoryFile(file: string): boolean {
    const name = path.basename(file);
    if (name !== CHAT_HISTORY_FILE && name !== EVENTS_FILE && name !== UPDATES_FILE) return true;
    const chatHistory = path.join(path.dirname(file), CHAT_HISTORY_FILE);
    const cached = this.hiddenHistoryVerdicts.get(chatHistory);
    // 한 번이라도 사람 대화가 확인된 기록은 이후 그 대화가 사라질 수 없으므로 영구히 노출로 확정한다.
    if (cached && !cached.hidden) return false;
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(chatHistory).mtimeMs;
    } catch {
      return false;
    }
    if (cached && cached.mtimeMs === mtimeMs) return cached.hidden;
    const hidden = !hasGrokUserQuery(chatHistory);
    this.hiddenHistoryVerdicts.set(chatHistory, { mtimeMs, hidden });
    return hidden;
  }

  // Grok은 도구 호출 직전에도 설명 문장을 assistant 메시지로 남겨서, "내용 있는 assistant 메시지"를
  // 완료로 보면 턴 중간마다 완료 알림이 나간다. 실제 완료는 events.jsonl의 turn_ended뿐이라 그것만
  // 완료로 인정한다.
  evaluateHistorySync(context: HistorySyncContext): HistorySyncDecision {
    const markBusy = context.newMessages.some((message) => message.role === "user")
      || context.newMessages.some((message) => message.role === "tool");
    return { markBusy: markBusy && !context.isTurnEnd, clearBusy: context.isTurnEnd, notifyCompletion: context.isTurnEnd };
  }

  // Grok TUI가 입력 가능한 상태인지 판정한다. 승인 화면에는 입력창이 없고, 응답 생성 중에는 상태줄에
  // 취소 안내(Esc:cancel)가 함께 뜬다.
  isReady(output: string): boolean {
    const lines = grokScreenLines(output);
    if (approvalScreenIndex(lines) >= 0) return false;
    const tail = lines.slice(-4).join("\n");
    if (!STATUS_BAR_PATTERN.test(tail) || BUSY_STATUS_PATTERN.test(tail)) return false;
    // 입력창에 미전송 초안이 남아 있으면 "비어 있는 입력창"이 아니다(제출 확인이 이 성질에 의존한다).
    return this.readPromptDraft(output) === "";
  }

  // Grok TUI가 응답 생성 중인지 판정한다.
  isBusy(output: string): boolean {
    const tail = grokScreenLines(output).slice(-4).join("\n");
    return BUSY_STATUS_PATTERN.test(tail);
  }

  // 입력창에 남은 미전송 텍스트를 읽는다. 승인 화면처럼 입력창 자체가 없는 화면이면 null.
  readPromptDraft(output: string): string | null {
    const lines = grokScreenLines(output);
    if (approvalScreenIndex(lines) >= 0) return null;
    // 입력창은 테두리 안에 "│ ❯ <내용>" 형태로 그려진다. 상태줄 위쪽에서 가장 마지막 것을 본다.
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const match = lines[index].match(/^\s*[│|]\s*❯\s?(.*?)\s*[│|]\s*$/);
      if (match) return match[1].trim();
    }
    return null;
  }

  // `/usage show` 화면에서 한도 창과 이번 세션 사용량을 읽는다.
  parseUsage(output: string, now: Date = new Date()): Partial<UsageRecord> {
    const text = stripAnsi(output);
    const authRequired = /not authenticated|not logged in|로그인/i.test(text);
    const windows = parseGrokWindows(text);
    const primary = windows[0];
    const success = windows.length > 0 && !authRequired;
    const stale = success && windows.some((window) => !!window.resetAt && isExpiredResetTime(window.resetAt, now));
    return {
      provider: "grok",
      summary: success ? [...windows.map((window) => `${window.label}: ${window.usedPercent}% used`), ...parseGrokSessionUsage(text)].join("\n") : null,
      used_percent: primary?.usedPercent ?? null,
      remaining_percent: primary?.remainingPercent ?? null,
      reset_at: primary?.resetAt ?? null,
      details_json: success ? JSON.stringify({ windows, activity: parseGrokSessionUsage(text) }) : null,
      data_status: !success ? "unavailable" : stale ? "stale" : "fresh",
      error_code: authRequired ? "auth_required" : success ? null : "parse_failed",
    };
  }

  // 도구 실행 승인 화면을 감지한다. 제목("Allow Edit to ...?")과 선택지 문구는 도구마다 달라지므로,
  // 화면 맨 아래 푸터("1/4:select")와 라디오 선택지가 함께 있는 경우만 실제 승인 요청으로 본다.
  detectApproval(output: string): ApprovalHint | null {
    const lines = grokScreenLines(output);
    const index = approvalScreenIndex(lines);
    if (index < 0) return null;
    return { requestType: "tool_permission_prompt", summary: lines.slice(Math.max(0, index - 12), index + 1).join("\n").trim() };
  }

  // Grok 승인 화면의 선택지 구성은 도구·상황에 따라 달라져 고정 번호 매핑이 성립하지 않는다. 실제 판정은
  // 전부 아래 resolveApprovalInput(화면 기반)이 하고, 여기서는 빈 문자열을 돌려줘 호출부가 아무 키도
  // 보내지 않게 한다 — 번호를 추측해 보내면 엉뚱한 선택지를 누르거나, 승인 화면이 아닌 입력창에 그 숫자가
  // 그대로 채팅 메시지로 전송돼버린다.
  approvalInput(_decision: "accept" | "acceptForSession" | "decline" | "cancel", _requestType: string): string {
    return "";
  }

  // 실제 화면의 선택지 문구를 보고 보낼 키를 정한다. 확신할 수 없으면 null을 반환해 아무 키도 보내지
  // 않게 한다(승인 화면이 아닌 곳에 숫자를 보내면 그대로 채팅 메시지가 되어버린다).
  resolveApprovalInput(decision: "accept" | "acceptForSession" | "decline" | "cancel", _requestType: string, output: string): string | null {
    const lines = grokScreenLines(output);
    const index = approvalScreenIndex(lines);
    if (index < 0) return null;
    const options = parseApprovalOptions(lines.slice(Math.max(0, index - 12), index));
    const find = (pattern: RegExp): string | null => options.find((option) => pattern.test(option.label))?.index ?? null;
    if (decision === "decline" || decision === "cancel") return find(/^No\b/i);
    // "Yes, and don't ask again for anything"은 세션이 아니라 always-approve 모드 자체를 켜버리므로
    // acceptForSession에 매핑하지 않는다. 그 범위를 원하면 사용자가 CLI에서 직접 켜야 한다.
    if (decision === "acceptForSession") return find(/during this session/i) ?? find(/^Yes\s*$/i);
    return find(/^Yes\s*$/i);
  }

  // 입력창 테두리 오른쪽 꼬리에서 현재 모델명을 읽는다.
  detectModel(output: string): string | null {
    const match = stripAnsi(output).match(MODEL_TAG_PATTERN);
    return match ? match[1].trim() : null;
  }

  // 같은 꼬리에서 권한 모드를 읽는다. 기본(default) 모드에서는 아무 표시도 붙지 않는다.
  detectPermissionMode(output: string): string | null {
    const match = stripAnsi(output).match(MODEL_TAG_PATTERN);
    if (!match) return null;
    return match[3]?.trim() || "default";
  }

  // Grok은 모델·추론강도를 메뉴 탐색 없이 `/model <모델> [강도]` 한 줄로 바꿀 수 있다. 방향키로 메뉴를
  // 훑는 방식은 항목 순서가 바뀌면 엉뚱한 걸 고르지만 이 명령은 대상을 이름으로 지정해 그 위험이 없다.
  async applyModelSelection(io: TmuxIO, _modelIndex: number, effortId: string | null, modelId?: string | null): Promise<void> {
    if (!modelId) return;
    io.sendText(`/model ${modelId}${effortId ? ` ${effortId}` : ""}`);
    await io.wait(120);
    io.sendEnter();
  }

  // 화면 파싱 없이 CLI가 실제로 제공하는 모델·추론강도 목록을 그대로 돌려준다.
  parseModelOptions(output: string): ModelOptions {
    const currentModel = this.detectModel(output);
    const currentEffort = stripAnsi(output).match(MODEL_TAG_PATTERN)?.[2]?.trim() ?? null;
    const models: ModelChoice[] = GROK_MODELS.map((model, index) => ({
      index,
      id: model.id,
      label: model.label,
      description: model.description,
      current: !!currentModel && model.label.toLowerCase() === currentModel.toLowerCase(),
    }));
    const efforts: ModelChoice[] = GROK_EFFORTS.map((effort, index) => ({
      index,
      id: effort,
      label: effort,
      current: effort === currentEffort,
    }));
    return { provider: "grok", currentModel, currentEffort, models, efforts };
  }
}

// grok CLI가 제공하는 모델. `grok models`가 돌려주는 값과 같은 ID를 쓴다.
const GROK_MODELS: Array<{ id: string; label: string; description: string }> = [
  { id: "grok-4.6", label: "Grok 4.6", description: "SpaceXAI's latest frontier model" },
  { id: "grok-4.5", label: "Grok 4.5", description: "이전 세대 모델" },
];

// `--reasoning-effort`가 받는 값(grok 1.0.5 문서 기준).
const GROK_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
