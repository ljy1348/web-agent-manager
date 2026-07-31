import type { Provider, UsageRecord } from "../../shared/types";

export interface ProviderLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface HistoryMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  kind: string;
  content: string;
  createdAt: string;
}

export interface HistorySession {
  provider: Provider;
  sessionId: string;
  cwd: string;
  title: string;
  historyFile: string;
  createdAt: string;
  updatedAt: string;
  messages: HistoryMessage[];
  // JSONL 자체에 기록된 실제 모델명(있다면). 터미널 배너 화면 파싱은 타이밍에 의존적이라 한 번 놓치면
  // 재시도가 없었는데, 이 값은 새 메시지가 기록될 때마다 갱신되므로 훨씬 안정적인 소스다.
  model?: string | null;
  // 가장 최근 턴이 끝난 시각(있다면). 사용량 한도 등으로 assistant 메시지 없이 턴이 끝나도 이 값은
  // 갱신되므로, "새 assistant 메시지" 유무와 무관하게 작업중 표시를 정리하는 데 쓸 수 있다.
  turnEndedAt?: string | null;
  // 공급자가 자체적으로 만들어주는, 첫 메시지 그대로보다 짧고 읽기 좋은 세션 제목(있다면). Claude는
  // 대화가 진행되며 JSONL에 aiTitle로 계속 갱신해 기록한다 — 사람이 CLI에서 /rename으로 직접 바꾼
  // 것과는 다르지만, 아직 아무도 이름을 안 바꾼 채팅에 한해 이 값으로 자동 업그레이드하면 web-agent-manager
  // 자체 제목(첫 메시지 80자 절단)보다 훨씬 낫다.
  displayTitle?: string | null;
}

export interface HistorySyncContext {
  session: HistorySession;
  last?: HistoryMessage;
  newMessages: HistoryMessage[];
  isTurnEnd: boolean;
}

export interface HistorySyncDecision {
  markBusy: boolean;
  clearBusy: boolean;
  notifyCompletion: boolean;
}

export interface ApprovalHint {
  requestType: string;
  summary: string;
}

export interface ModelChoice {
  index: number;
  id: string;
  label: string;
  description?: string;
  current?: boolean;
}

export interface ModelOptions {
  provider: Provider;
  currentModel?: string | null;
  currentEffort?: string | null;
  models: ModelChoice[];
  efforts: ModelChoice[];
}

export interface TmuxIO {
  tmuxName: string;
  sendText(value: string): void;
  sendEnter(): void;
  sendLeft(): void;
  sendRight(): void;
  wait(milliseconds: number): Promise<void>;
  snapshot(): string;
  waitForModelMenu(part: "models" | "efforts", timeoutMs: number): Promise<boolean>;
}

export interface ProviderAdapter {
  id: Provider;
  displayLabel: string;
  usageWindowId: string;
  cliVersionCommand: ProviderLaunch;
  historyRoot: string;
  promptQuirks?: {
    slashCommandConfirmDelayMs?: number;
    usageCommandDelayMs?: number;
    modelMenuInitialTimeoutMs?: number;
    modelMenuConfirmDelayMs?: number;
    modelOptionsReadsEffortScreen?: boolean;
  };
  createLaunch(cwd: string, resumeSessionId?: string): ProviderLaunch;
  parseHistoryFile(file: string): HistorySession | null;
  // append-only JSONL의 새 레코드만 기존 파싱 결과에 합친다. 불완전하면 undefined로 전체 재파싱을 요청한다.
  appendHistoryLines?(file: string, previous: HistorySession, lines: string[]): HistorySession | undefined;
  evaluateHistorySync(context: HistorySyncContext): HistorySyncDecision;
  isReady(output: string): boolean;
  isBusy(output: string): boolean;
  parseUsage(output: string, now?: Date): Partial<UsageRecord>;
  detectApproval(output: string): ApprovalHint | null;
  detectModel(output: string): string | null;
  parseModelOptions?(output: string): ModelOptions;
  isModelMenu?(output: string, part: "models" | "efforts"): boolean;
  // 실제 모델 메뉴에서 선택값을 적용한다. modelId는 캐시 번호가 바뀌어도 대상을 다시 찾기 위한 안정 ID다.
  applyModelSelection?(io: TmuxIO, modelIndex: number, effortId: string | null, modelId?: string | null): Promise<void>;
  // 모델 메뉴 밖에서 추론 강도를 별도 slash 명령으로 바꾸는 공급자가 쓰는 선택 훅이다.
  effortCommand?(effortId: string): string | null;
  // 하단 상태줄의 권한 모드 문구(예: "auto mode on")를 그대로 읽어온다. 지원하지 않는 공급자는 생략 가능.
  detectPermissionMode?(output: string): string | null;
  approvalInput(decision: "accept" | "acceptForSession" | "decline" | "cancel", requestType: string): string;
  // rate_limit_options에서 "대기"/"업그레이드"가 실제로 몇 번인지(또는 애초에 선택 메뉴가 뜨긴 한 건지)
  // 화면 내용을 보고 판단한다. 확신할 수 없으면 null을 반환해 아무 키도 보내지 않아야 한다 — 고정 번호를
  // 추측해 보내면 선택 메뉴가 없는 화면에서 그 숫자가 그대로 채팅 메시지로 전송돼버릴 수 있다.
  resolveRateLimitInput?(decision: "accept" | "acceptForSession", output: string): string | null;
  usageCommands: string[];
  // 공급자 내부 작업용 기록처럼 웹 채팅 목록에 노출하지 않을 기록 파일인지 확인한다.
  isHiddenHistoryFile?(file: string): boolean;
}
