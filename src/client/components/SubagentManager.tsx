import React, { useEffect, useState } from "react";
import { Bot, ExternalLink, LoaderCircle, Pause, Play, Plus, Send, Square, X } from "lucide-react";
import { api } from "../api";
import type { Json } from "../types";
import { useDialogHistory } from "../lib/dialog-history";
import { createClientUuid } from "../lib/client-uuid";
import { ApprovalCard } from "./ApprovalCard";

interface SubagentManagerProps {
  project: Json;
  selectedChat: Json;
  providers: Json[];
  chats: Json[];
  setSelectedChat: (chat: Json) => void;
  refreshChats: () => Promise<void>;
  interrupt: (chatId: number) => Promise<void>;
  stop: (chatId: number) => Promise<void>;
  startChat: (chatId: number) => Promise<void>;
  approvals: Json[];
  decide: (id: string, decision: string, answer?: string) => Promise<void>;
  onClose: () => void;
}

// 채팅 목록 배지는 초 단위가 필요 없고, 열린 패널(3초)보다 드물게 같은 위임 API를 친다.
export const CHAT_SUBAGENT_BADGE_POLL_MS = 15_000;

// 대상 채팅의 실제 실행 상태를 사람이 읽을 수 있는 서브 에이전트 상태로 변환한다.
export function delegationActivity(item: Json): { label: string; className: string } {
  if (item.status === "failed" || item.target_status === "error") return { label: "오류", className: "error" };
  if (item.status === "completed") return { label: "완료", className: "completed" };
  if (item.target_busy) return { label: "작업 중", className: "working" };
  if (["stopped", "error"].includes(item.target_status)) return { label: "종료됨", className: "stopped" };
  if (["starting", "resuming"].includes(item.target_status)) return { label: "시작 중", className: "working" };
  return { label: "대기 중", className: "idle" };
}

// 부모 채팅이 없는 CLI·MCP 직접 실행 위임인지 판정한다.
export function isParentlessDelegation(item: Json): boolean {
  return item.source_chat_id == null;
}

// 지금 열린 채팅이 부모인 위임만 남긴다.
export function isDelegationForChat(item: Json, chatId: number): boolean {
  return !isParentlessDelegation(item) && Number(item.source_chat_id) === Number(chatId);
}

// 패널 범위에 맞는 위임만 남긴다. 이 채팅 보기에서는 부모 없는 위임을 숨긴다.
export function filterDelegationsForScope(delegations: Json[], selectedChatId: number, showProjectWide: boolean): Json[] {
  if (showProjectWide) return delegations;
  return delegations.filter((item) => isDelegationForChat(item, selectedChatId));
}

// 전체 보기에서 부모 있는 위임과 직접 실행 위임을 나눈다.
export function groupDelegationsForProjectView(delegations: Json[]): { parented: Json[]; parentless: Json[] } {
  const parented: Json[] = [];
  const parentless: Json[] = [];
  for (const item of delegations) {
    if (isParentlessDelegation(item)) parentless.push(item);
    else parented.push(item);
  }
  return { parented, parentless };
}

// 채팅별 진행 중 서브에이전트 수를 센다. 부모가 없는 위임은 배지에 넣지 않는다.
export function workingSubagentCountsBySourceChat(delegations: Json[]): Record<number, number> {
  const counts: Record<number, number> = {};
  for (const item of delegations) {
    if (isParentlessDelegation(item) || delegationActivity(item).className !== "working") continue;
    const sourceId = Number(item.source_chat_id);
    counts[sourceId] = (counts[sourceId] ?? 0) + 1;
  }
  return counts;
}

// 서버 시각을 관리 목록에 맞는 짧은 로컬 시각으로 표시한다.
function formatDelegationTime(value: string | null | undefined): string {
  if (!value) return "";
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

// 비보안 HTTP 환경에서도 작업 중복 방지용 요청 키를 생성한다.
function delegationRequestKey(): string {
  return createClientUuid();
}

// 다른 채팅의 살아있는 PTY를 끊기 전에 대상 번호를 보여 확인받는다.
export function subagentStopConfirmMessage(chatId: number): string {
  return `채팅 #${chatId} 터미널을 종료할까요?\n\n진행 중인 작업이 끊깁니다.`;
}

// 프로젝트의 자식 에이전트 생성과 실행 상태 관리를 한 패널에서 제공한다.
export function SubagentManager({
  project,
  selectedChat,
  providers,
  chats,
  setSelectedChat,
  refreshChats,
  interrupt,
  stop,
  startChat,
  approvals,
  decide,
  onClose,
}: SubagentManagerProps): React.ReactElement {
  const dismiss = useDialogHistory(true, onClose, "subagent-manager");
  // 브리지가 어댑터 등록 여부로 위임 대상을 판정하므로 여기서 공급자를 따로 좁히지 않는다.
  const availableProviders = providers;
  const [provider, setProvider] = useState(() => availableProviders.some((item) => item.id === selectedChat.provider) ? selectedChat.provider : availableProviders[0]?.id || "codex");
  const [prompt, setPrompt] = useState("");
  const [delegations, setDelegations] = useState<Json[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [actingChatId, setActingChatId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [showProjectWide, setShowProjectWide] = useState(false);

  // 현재 프로젝트의 위임 기록과 대상 채팅 상태를 다시 읽는다.
  async function refresh(): Promise<void> {
    const data = await api(`/projects/${project.id}/agent-delegations`);
    setDelegations(data.delegations || []);
  }

  useEffect(() => {
    let active = true;
    const poll = (): void => {
      void api(`/projects/${project.id}/agent-delegations`).then((data) => {
        if (active) {
          setDelegations(data.delegations || []);
          setLoading(false);
        }
      }).catch((caught) => {
        if (active) {
          setError(caught instanceof Error ? caught.message : "서브 에이전트 상태를 불러오지 못했습니다.");
          setLoading(false);
        }
      });
    };
    poll();
    const timer = window.setInterval(poll, 3_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [project.id]);

  // 현재 채팅을 부모로 삼아 지정 공급자의 새 자식 채팅을 만들고 작업을 전달한다.
  async function createSubagent(): Promise<void> {
    const task = prompt.trim();
    if (!task || creating) return;
    setCreating(true);
    setError("");
    try {
      await api("/agent-delegations", {
        method: "POST",
        body: JSON.stringify({
          sourceChatId: selectedChat.id,
          projectId: project.id,
          provider,
          prompt: task,
          createNew: true,
          idempotencyKey: delegationRequestKey(),
        }),
      });
      setPrompt("");
      setCreateOpen(false);
      await Promise.all([refreshChats(), refresh()]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "서브 에이전트를 만들지 못했습니다.");
    } finally {
      setCreating(false);
    }
  }

  // 대상 서브 에이전트 채팅을 최신 정보로 선택하고 관리 패널을 닫는다.
  async function openTargetChat(chatId: number): Promise<void> {
    setError("");
    try {
      const known = chats.find((item) => item.id === chatId);
      const target = known || (await api(`/chats/${chatId}`)).chat;
      setSelectedChat(target);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "대상 채팅을 열지 못했습니다.");
    }
  }

  // 대상 채팅의 중단·종료·재시작 명령을 실행한 뒤 목록 상태를 동기화한다.
  async function runChatAction(chatId: number, action: () => Promise<void>): Promise<void> {
    setActingChatId(chatId);
    setError("");
    try {
      await action();
      await Promise.all([refreshChats(), refresh()]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "서브 에이전트 상태를 변경하지 못했습니다.");
    } finally {
      setActingChatId(null);
    }
  }

  const visibleDelegations = filterDelegationsForScope(delegations, selectedChat.id, showProjectWide);
  const grouped = showProjectWide
    ? groupDelegationsForProjectView(visibleDelegations)
    : { parented: visibleDelegations, parentless: [] as Json[] };
  const workingCount = visibleDelegations.filter((item) => delegationActivity(item).className === "working").length;
  const pendingApprovalCount = (chatId: number): number => approvals.filter((item) => item.status === "pending" && Number(item.chat_id) === Number(chatId)).length;
  const attentionCount = visibleDelegations.filter((item) => delegationActivity(item).className === "error" || pendingApprovalCount(item.target_chat_id) > 0).length;
  const emptyLabel = showProjectWide ? "서브 에이전트가 없습니다." : "이 채팅의 서브 에이전트가 없습니다.";

  // 위임 한 건의 상태·동작 버튼을 그린다.
  function renderDelegationItem(item: Json): React.ReactElement {
    const itemApprovals = approvals.filter((approval) => approval.status === "pending" && Number(approval.chat_id) === Number(item.target_chat_id));
    const activity = itemApprovals.length ? { label: "권한 요청", className: "needs-approval" } : delegationActivity(item);
    const stopped = ["stopped", "error"].includes(item.target_status);
    const acting = actingChatId === item.target_chat_id;
    return <article className={`subagent-item ${activity.className}`} key={item.id}>
      <div className="subagent-item-head">
        <div className="subagent-item-identity">
          <span className={`provider ${item.target_provider}`}>{item.target_provider}</span>
          <strong>{item.target_title || `채팅 #${item.target_chat_id}`}</strong>
          <span className="chat-id">#{item.target_chat_id}</span>
        </div>
        <span className={`activity-chip ${activity.className}`}>{activity.label}</span>
      </div>
      <p className="subagent-item-task">{item.prompt}</p>
      <div className="subagent-item-meta">
        <span>최근 업데이트</span><time dateTime={item.updated_at}>{formatDelegationTime(item.updated_at)}</time>
      </div>
      {item.error && <div className="subagent-item-error">{item.error}</div>}
      {!!itemApprovals.length && <div className="subagent-item-approvals">
        <strong>이 서브 에이전트가 권한 결정을 기다리고 있습니다.</strong>
        {itemApprovals.map((approval) => <ApprovalCard key={approval.id} item={approval} decide={decide} />)}
      </div>}
      <div className="subagent-item-actions">
        <button type="button" aria-label={`채팅 #${item.target_chat_id} 열기`} onClick={() => void openTargetChat(item.target_chat_id)}><ExternalLink size={15} aria-hidden="true" />채팅 열기</button>
        {!!item.target_busy && <button type="button" aria-label={`채팅 #${item.target_chat_id} 응답 중단`} disabled={acting} onClick={() => void runChatAction(item.target_chat_id, () => interrupt(item.target_chat_id))}><Pause size={15} aria-hidden="true" />응답 중단</button>}
        {stopped
          ? <button type="button" aria-label={`채팅 #${item.target_chat_id} 터미널 시작`} disabled={acting} onClick={() => void runChatAction(item.target_chat_id, () => startChat(item.target_chat_id))}><Play size={15} aria-hidden="true" />터미널 시작</button>
          : <button type="button" className="danger" aria-label={`채팅 #${item.target_chat_id} 터미널 종료`} disabled={acting} onClick={() => { if (!window.confirm(subagentStopConfirmMessage(item.target_chat_id))) return; void runChatAction(item.target_chat_id, () => stop(item.target_chat_id)); }}><Square size={14} aria-hidden="true" />터미널 종료</button>}
      </div>
    </article>;
  }

  return <>
    <button type="button" className="subagent-backdrop" aria-label="서브 에이전트 관리 닫기" onClick={() => dismiss()} />
    <aside className="subagent-manager" role="dialog" aria-modal="true" aria-labelledby="subagent-manager-title">
      <div className="subagent-manager-head">
        <div className="subagent-manager-title">
          <span className="subagent-manager-icon"><Bot size={18} aria-hidden="true" /></span>
          <div><h2 id="subagent-manager-title">서브 에이전트</h2><span>{project.name}</span></div>
        </div>
        <button type="button" className="icon-button" aria-label="서브 에이전트 관리 닫기" title="닫기" onClick={() => dismiss()}><X size={18} aria-hidden="true" /></button>
      </div>
      <div className="subagent-overview">
        <div className="subagent-overview-copy">
          <strong>{visibleDelegations.length}개 에이전트</strong>
          <span>{showProjectWide ? "프로젝트 전체" : `이 채팅 #${selectedChat.id}`} · {workingCount ? `${workingCount}개 작업 중` : "실행 중인 작업 없음"}{attentionCount ? ` · 확인 필요 ${attentionCount}` : ""}</span>
        </div>
        <div className="subagent-overview-actions">
          <div className="subagent-scope" role="group" aria-label="서브 에이전트 목록 범위">
            <button type="button" aria-pressed={!showProjectWide} onClick={() => setShowProjectWide(false)}>이 채팅</button>
            <button type="button" aria-pressed={showProjectWide} onClick={() => setShowProjectWide(true)}>프로젝트 전체</button>
          </div>
          <button type="button" className={createOpen ? "" : "primary"} aria-expanded={createOpen} onClick={() => setCreateOpen((open) => !open)}>
            {createOpen ? <X size={15} aria-hidden="true" /> : <Plus size={15} aria-hidden="true" />}
            {createOpen ? "취소" : "새 작업"}
          </button>
        </div>
      </div>
      {createOpen && <form className="subagent-create" onSubmit={(event) => { event.preventDefault(); void createSubagent(); }}>
        <div className="subagent-create-head">
          <div><strong>작업 위임</strong><span>부모 채팅 #{selectedChat.id} · {selectedChat.title}</span></div>
        </div>
        <label className="subagent-create-label">실행 에이전트</label>
        <div className="subagent-provider" role="group" aria-label="서브 에이전트 공급자">
          {availableProviders.map((item) => <button key={item.id} type="button" aria-pressed={provider === item.id} onClick={() => setProvider(item.id)}>{item.label}</button>)}
        </div>
        <textarea autoFocus aria-label="서브 에이전트 작업" rows={3} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="에이전트에게 전달할 작업을 입력하세요" />
        <div className="subagent-create-actions">
          <button type="submit" className="primary subagent-submit" disabled={creating || !prompt.trim()}>
            {creating ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}
            {creating ? "생성 중" : "작업 시작"}
          </button>
        </div>
      </form>}
      {error && <div className="subagent-error" role="alert">{error}</div>}
      <div className="subagent-list-head">
        <div><h3>작업 목록</h3><span>{visibleDelegations.length}</span></div>
        {!loading && <small>{workingCount ? "실시간 갱신 중" : "3초마다 상태 갱신"}</small>}
      </div>
      <div className="subagent-list" aria-live="polite">
        {loading && <div className="subagent-empty"><LoaderCircle className="spin" size={18} aria-hidden="true" />불러오는 중</div>}
        {!loading && !visibleDelegations.length && <div className="subagent-empty">{emptyLabel}</div>}
        {grouped.parented.map(renderDelegationItem)}
        {showProjectWide && grouped.parentless.length > 0 && <>
          <div className="subagent-group-head">
            <h4>직접 실행(CLI·MCP)</h4>
            <span>{grouped.parentless.length}</span>
          </div>
          {grouped.parentless.map(renderDelegationItem)}
        </>}
      </div>
    </aside>
  </>;
}
