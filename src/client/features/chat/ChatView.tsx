import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Bot } from "lucide-react";
import { api } from "../../api";
import { SubagentManager } from "../../components/SubagentManager";
import { GitBranchControl } from "../../components/GitBranchControl";
import { TerminalPanel } from "../terminal/TerminalPanel";
import { splitMessageContent } from "../../message-display";
import { chatActivity } from "../../lib/approvals";
import { ApprovalCard } from "../../components/ApprovalCard";
import { usageWindows } from "../../lib/format";
import { attachmentUrl, isImagePath, MessageBody } from "../../lib/attachments";
import { DiffView, looksLikeDiff } from "../../lib/diff-view";
import type { Json } from "../../types";

// 맨 위에서 이 픽셀 이내로 스크롤하면 이전 대화를 더 불러온다.
const TOP_LOAD_THRESHOLD_PX = 200;
// 공급자별 TUI가 쓰는 추론 강도 라벨을 API의 안정 ID로 정규화한다.
const EFFORT_LABELS_BY_PROVIDER: Record<string, Record<string, string>> = {
  codex: { low: "low", medium: "medium", high: "high", "extra high": "extra-high", "extra-high": "extra-high" },
  claude: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
};

// 모델 라벨 비교용으로 추론 강도 접미사를 제거한다.
function normalizeModelLabel(value: string | null | undefined): string {
  return String(value ?? "").toLowerCase().replace(/\b(extra[- ]high|xhigh|max|high|medium|low)\b/g, "").replace(/[^a-z0-9.]+/g, "");
}

// 저장된 채팅 모델명에서 추론 강도 ID를 추출한다.
function effortFromModelLabel(provider: string | null | undefined, value: string | null | undefined): string | null {
  const text = String(value ?? "").toLowerCase();
  const match = text.match(/\b(extra[- ]high|xhigh|max|high|medium|low)\b/);
  const labels = EFFORT_LABELS_BY_PROVIDER[String(provider ?? "")] ?? {};
  return match ? labels[match[1].replace(/\s+/, " ")] ?? labels[match[1]] ?? null : null;
}

// 모델 옵션 중 선택된 채팅의 저장 모델명과 가장 잘 맞는 항목을 고른다.
function preferredModelOption(options: Json, selectedChat: Json): Json | null {
  const models = options.models ?? [];
  const chatModel = normalizeModelLabel(selectedChat?.model);
  return models.find((item: Json) => chatModel && normalizeModelLabel(item.label) === chatModel)
    || models.find((item: Json) => item.current)
    || models[0]
    || null;
}

// 추론 강도 옵션 중 선택된 채팅의 저장 모델명을 우선해 고른다.
function preferredEffortOption(options: Json, selectedChat: Json): Json | null {
  const efforts = options.efforts ?? [];
  const chatEffort = effortFromModelLabel(selectedChat?.provider, selectedChat?.model);
  return efforts.find((item: Json) => chatEffort && item.id === chatEffort)
    || efforts.find((item: Json) => item.current)
    || efforts[0]
    || null;
}

// 일반 응답은 바로 표시하고 도구·diff 상세는 접힌 상태로 렌더링한다. 본문에 첨부 표시가 있으면
// 사람이 올렸든(파일 첨부) 세션이 검증용으로 남겼든 구분 없이 실제 이미지 썸네일로 바꿔 보여준다.
function MessageCard({ message, showDetails, project, onOpenProjectFile }: { message: Json; showDetails: boolean; project?: Json; onOpenProjectFile?: (path: string) => void }): React.ReactElement | null {
  const display = splitMessageContent(message);
  if (!display.primary && !display.details.length) return null;
  if (!display.primary && !showDetails) return null;
  return <article className={`message ${message.role} ${display.primary ? "" : "message-detail-only"}`}>
    <small>{message.role}</small>
    {display.primary && <MessageBody content={display.primary} projectId={project?.id} projectPath={project?.path} onOpenProjectFile={onOpenProjectFile} />}
    {/* 체크박스는 "이 상세들이 존재한다는 걸 보여줄지"만 결정한다. 전부 강제로 펼치면(open 고정)
        diff가 많은 대화에서 스크롤이 감당 안 돼서, 각 항목은 기본 접힘 상태로 두고 클릭해서
        개별로 펼치게 한다(<details>는 비제어 요소라 클릭 상태를 브라우저가 알아서 기억한다). */}
    {showDetails && display.details.map((detail, index) => <details className="message-details" key={`${message.id}:detail:${index}`}><summary>{display.detailLabel}</summary>{looksLikeDiff(detail) ? <DiffView diff={detail} /> : <pre>{detail}</pre>}</details>)}
  </article>;
}

// 채팅 내역, 입력창, 실제 터미널, 종료·승인 동작을 제공한다.
export function ChatView({ user, chatViewMode, changeChatViewMode, providers, accounts, project, projects, setProject, addProject, deleteProject, chats, selectedChat, setSelectedChat, refreshChats, createChat, send, stop, interrupt, cycleMode, startChat, messages, hasMoreMessages, loadMoreMessages, usage, busy, socket, approvals, decide, scrollState, sessionBackups, backupChat, deleteChat, restoreBackup, deleteBackup, onOpenProjectFile }: Json): React.ReactElement {
  const [text, setText] = useState("");
  // 업로드한 이미지 첨부를 전송 전 입력창 위에 썸네일로 미리 보여준다.
  const [attachmentPreviews, setAttachmentPreviews] = useState<Array<{ path: string; name: string }>>([]);
  const [viewModeSaving, setViewModeSaving] = useState(false);
  const [subagentOpen, setSubagentOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [attachmentStatus, setAttachmentStatus] = useState("");
  const [sendError, setSendError] = useState("");
  const [sessionActionStatus, setSessionActionStatus] = useState("");
  // 백업 목록은 평소엔 숨겨두고, 사용자가 "백업 목록" 버튼을 눌렀을 때만 펼쳐서 보여준다(항상
  // 보이면 목록이 길어질수록 정작 자주 쓰는 채팅 목록·전송창을 가린다).
  const [showBackups, setShowBackups] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  // Shift+Tab 전송 중 버튼 연타로 중복 요청이 나가지 않도록 잠깐 비활성화한다.
  const [cyclingMode, setCyclingMode] = useState(false);
  const [modelOptions, setModelOptions] = useState<Json | null>(null);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelApplying, setModelApplying] = useState(false);
  const [modelRefreshing, setModelRefreshing] = useState(false);
  const [selectedModelIndex, setSelectedModelIndex] = useState("");
  const [selectedEffortId, setSelectedEffortId] = useState("");
  // 모델·사용량·모델 전환 등을 담은 상태바가 좁은 화면(≤700px)에서는 컨트롤이 많아 여러 줄로 밀려
  // 채팅 내용이 나오기도 전에 화면 대부분을 차지했다 — 모바일에서는 기본적으로 한 줄 요약만 보여주고,
  // 눌러야 기존 전체 컨트롤이 펼쳐지게 한다(데스크톱은 이 상태와 무관하게 항상 펼쳐져 있음).
  const [modelBarExpanded, setModelBarExpanded] = useState(false);
  // Claude·Codex 둘 다 CLI 자체 /rename 명령을 지원해, 채팅 제목을 눌러 바로 그 명령을 보낼 수 있게 한다.
  const [editingTitle, setEditingTitle] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [commandItems, setCommandItems] = useState<Json[]>([]);
  const [commandIndex, setCommandIndex] = useState(0);
  const [dismissedCommandText, setDismissedCommandText] = useState("");
  useEffect(() => { setEditingTitle(false); }, [selectedChat?.id]);
  const modelOptionsCache = useRef<Record<number, Json>>({});
  // 중지 시 방금 보낸 질문을 입력창에 복구해주기 위해 채팅별로 마지막 전송 텍스트를 기억해둔다.
  const [lastSentByChatId, setLastSentByChatId] = useState<Record<number, string>>({});
  // 도구·diff 상세 표시 여부는 다음 방문에도 유지되도록 localStorage에 저장한다.
  const [showToolDetails, setShowToolDetails] = useState(() => (localStorage.getItem("web_agent_manager_show_tool_details") ?? localStorage.getItem("myagent_show_tool_details")) === "1");
  useEffect(() => { localStorage.setItem("web_agent_manager_show_tool_details", showToolDetails ? "1" : "0"); }, [showToolDetails]);
  // 작업중 상태가 풀리면(응답 완료 또는 중단 확인) 중지 버튼의 진행 표시도 함께 정리한다.
  useEffect(() => { if (!busy) setInterrupting(false); }, [busy]);
  // 채팅을 전환하면 이전 채팅에서 입력하던 글·오류바·첨부 상태가 새 채팅에 그대로 남아 보이던 문제를
  // 막기 위해, 선택된 채팅이 바뀔 때마다 composer의 임시 상태를 초기화한다.
  useEffect(() => { setText(""); setAttachmentPreviews([]); setAttachmentStatus(""); setSendError(""); setSessionActionStatus(""); setShowBackups(false); }, [selectedChat?.id]);
  useEffect(() => {
    let active = true;
    const params = project?.id ? `?projectId=${project.id}` : "";
    void api(`/tools/catalog${params}`).then((data) => {
      if (active) setCommandItems((data.items || []).filter((item: Json) => ["commands", "skills"].includes(item.kind) && item.command));
    }).catch(() => { if (active) setCommandItems([]); });
    return () => { active = false; };
  }, [project?.id]);
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  // placeholder 문구 때문에 빈 입력창이 항상 여러 줄 자리를 차지하지 않도록, 안내문은 짧게 두고 대신
  // 실제로 입력한 내용 길이에 맞춰 높이를 늘리고 줄인다(최대 높이는 CSS max-height가 그대로 제한).
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    // box-sizing: border-box라 scrollHeight(테두리 제외)를 그대로 height에 넣으면 테두리 두께만큼
    // 안쪽 표시 영역이 모자라진다 — 테두리 두께를 더해야 실제 내용이 잘리지 않는다.
    const borderWidth = element.offsetHeight - element.clientHeight;
    element.style.height = `${element.scrollHeight + borderWidth}px`;
  }, [text]);
  const scrollParent = useRef<HTMLDivElement>(null);
  // scrollState는 App이 들고 있는 객체라 이 컴포넌트가 언마운트(다른 탭 이동)됐다 다시 마운트돼도 유지된다.
  // 로컬 useRef로 두면 탭을 벗어났다 돌아올 때마다 "채팅이 바뀐 것"으로 오인해 매번 처음부터 다시 정렬하고,
  // 그 과정에서 자동 이전 메시지 로드가 재발동해 스크롤이 과거 쪽으로 튀는 문제가 있었다.
  const prevFirstId = { get current(): string | null { return scrollState.prevFirstId; }, set current(value: string | null) { scrollState.prevFirstId = value; } };
  const prevChatId = { get current(): number | null { return scrollState.prevChatId; }, set current(value: number | null) { scrollState.prevChatId = value; } };
  // approvals는 App이 프로젝트 구분 없이 전역으로 불러온 목록이라, 그대로 쓰면 다른 프로젝트 채팅의
  // 승인 요청까지 여기 섞여 보였다(사용자가 실제로 겪음 — 다른 프로젝트 승인 카드를 이 프로젝트
  // 것으로 착각해 잘못 응답하면서 의도치 않은 세션에 입력이 들어감). chats는 이미 현재 프로젝트로
  // 필터된 목록이므로 그 chat_id 집합으로 한 번 더 좁힌다.
  const projectChatIds = useMemo(() => new Set(chats.map((item: Json) => item.id)), [chats]);
  // 채팅을 작업공간별로 묶는다. 프로젝트 공유 checkout 채팅과 worktree별 채팅을 따로 보기 위함이다.
  const chatGroups = useMemo(() => {
    const groups = new Map<string, { key: string; label: string; branch: string | null; worktreePath: string | null; chats: Json[] }>();
    for (const item of chats as Json[]) {
      const worktreePath = item.worktree_path || null;
      const key = worktreePath ?? "__project__";
      const label = worktreePath ? `${item.git_branch || "worktree"} 워크트리` : "프로젝트 채팅";
      const group = groups.get(key) ?? { key, label, branch: (item.git_branch || null) as string | null, worktreePath, chats: [] as Json[] };
      group.chats.push(item);
      groups.set(key, group);
    }
    // 프로젝트 채팅을 항상 위에 두고 worktree는 브랜치 이름순으로 정렬한다.
    return [...groups.values()].sort((a, b) => {
      if (!a.worktreePath) return -1;
      if (!b.worktreePath) return 1;
      return a.label.localeCompare(b.label);
    });
  }, [chats]);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [groupBusy, setGroupBusy] = useState("");

  // 묶음에서 채팅을 시작한다. worktree 묶음이면 같은 폴더를 쓰는 채팅으로 만든다.
  async function createChatInGroup(group: { branch: string | null; worktreePath: string | null }, provider: string, accountId?: number | null): Promise<void> {
    if (!project) return;
    if (!group.worktreePath) { await createChat(provider, accountId); return; }
    setGroupBusy(`${provider}:${group.worktreePath}`);
    try {
      const data = await api("/chats/worktree", {
        method: "POST",
        body: JSON.stringify({ projectId: project.id, provider, accountId: accountId ?? null, branch: group.branch, create: false, title: `${group.branch} 작업` }),
      });
      await refreshChats();
      if (data.chat) setSelectedChat(data.chat);
    } catch (error: any) {
      window.alert(error?.message || "채팅을 시작하지 못했습니다.");
    } finally {
      setGroupBusy("");
    }
  }

  // 채팅이 쓸 인증 계정을 바꾼다. 계정마다 세션 기록이 따로라 기존 대화는 재개할 수 없고,
  // 서버도 실행 중인 채팅은 거부하므로 정지 상태에서만 노출한다.
  async function changeAccount(accountId: number): Promise<void> {
    if (!selectedChat) return;
    if (!window.confirm("계정을 바꾸면 이 채팅의 지난 대화는 이어서 재개할 수 없고, 다음 시작부터 새 대화로 진행됩니다.\n(대화 기록 자체는 지워지지 않아 계정을 되돌리면 다시 이어갈 수 있습니다.)\n\n계속할까요?")) return;
    try {
      await api(`/chats/${selectedChat.id}/account`, { method: "PUT", body: JSON.stringify({ accountId }) });
      await refreshChats();
    } catch (error: any) {
      window.alert(error?.message || "계정을 바꾸지 못했습니다.");
    }
  }

  const pendingApprovals = approvals.filter((item: Json) => item.status === "pending" && projectChatIds.has(item.chat_id));
  const selectedApprovals = pendingApprovals.filter((item: Json) => item.chat_id === selectedChat?.id);
  // 모바일 메뉴 목록은 선택된 채팅 것을 빼서 보여준다 — 그건 이미 대화창 안(inline-approvals)에 떠
  // 있어서 메뉴에도 또 나오면 같은 카드가 두 번 보였다(모바일에서 "2장씩" 보고된 원인).
  const otherPendingApprovals = pendingApprovals.filter((item: Json) => item.chat_id !== selectedChat?.id);
  const selectedActivity = selectedChat ? chatActivity(selectedChat, pendingApprovals) : null;
  const providerList = Array.isArray(providers) ? providers : [];
  const providerMeta = (provider: string | null | undefined): Json => providerList.find((item: Json) => item.id === provider) || { id: provider, label: provider, usageWindowId: "session", supportsPermissionMode: false };
  // 새 채팅 만들기 선택지. 인증 계정이 하나뿐인 공급자는 지금까지처럼 버튼 하나("+ Claude")로 두고,
  // 계정이 여럿이면 계정별로 나눠 어떤 인증으로 시작할지 고를 수 있게 한다.
  const accountList: Json[] = Array.isArray(accounts) ? accounts : [];
  type CreateTarget = { key: string; provider: string; accountId: number | null; label: string };
  const createTargets: CreateTarget[] = providerList.flatMap((provider: Json): CreateTarget[] => {
    const own = accountList.filter((account: Json) => account.provider === provider.id);
    if (own.length < 2) return [{ key: provider.id, provider: provider.id, accountId: null, label: provider.label }];
    return own.map((account: Json) => ({ key: `${provider.id}:${account.id}`, provider: provider.id, accountId: account.id as number, label: `${provider.label} · ${account.label}` }));
  });
  const accountLabel = (chat: Json | null): string => {
    const account = accountList.find((item: Json) => item.id === chat?.account_id);
    return account && !account.is_default ? account.label : "";
  };
  const selectedProvider = providerMeta(selectedChat?.provider);
  // 선택된 채팅 공급자의 대표 사용량 구간은 서버가 내려준 공급자 메타 기준으로 찾는다.
  const usageRecord = usage.find((item: Json) => item.provider === selectedChat?.provider);
  const primaryUsageWindow = usageRecord && usageWindows(usageRecord).find((window: Json) => window.id === selectedProvider.usageWindowId);
  useEffect(() => {
    let active = true;
    if (!selectedChat?.provider) {
      setModelOptions(null);
      setSelectedModelIndex("");
      setSelectedEffortId("");
      return;
    }
    // 캐시 또는 새 조회 결과를 현재 채팅 모델명 기준 선택값으로 반영한다.
    const applyOptions = (options: Json): void => {
      if (!active || options?.provider !== selectedChat.provider) return;
      setModelOptions(options);
      const currentModel = preferredModelOption(options, selectedChat);
      const currentEffort = preferredEffortOption(options, selectedChat);
      setSelectedModelIndex(currentModel ? String(currentModel.index) : "");
      setSelectedEffortId(currentEffort?.id || "");
    };
    const cached = modelOptionsCache.current[selectedChat.id];
    if (cached) applyOptions(cached);
    else {
      setModelOptions(null);
      setSelectedModelIndex("");
      setSelectedEffortId("");
    }
    setModelLoading(true);
    void api(`/models/${selectedChat.provider}`).then((data) => {
      const options = data.options;
      if (!active || options?.provider !== selectedChat.provider) return;
      if (options?.models?.length || options?.efforts?.length) {
        modelOptionsCache.current[selectedChat.id] = options;
        applyOptions(options);
      } else if (cached) applyOptions(cached);
    }).catch(() => undefined).finally(() => { if (active) setModelLoading(false); });
    return () => { active = false; };
  }, [selectedChat?.id, selectedChat?.provider, selectedChat?.model]);
  // 사용자가 직접 눌렀을 때만 상태 조회용 CLI에 /model을 다시 보내 목록을 갱신한다(그 외엔 서버가
  // 시작할 때 한 번 캐시해둔 값만 읽는다).
  async function refreshModelOptions(): Promise<void> {
    if (!selectedChat?.provider) return;
    setModelRefreshing(true);
    try {
      const data = await api(`/models/${selectedChat.provider}/refresh`, { method: "POST" });
      const options = data.options;
      if (options?.provider !== selectedChat.provider) return;
      modelOptionsCache.current[selectedChat.id] = options;
      setModelOptions(options);
      const currentModel = preferredModelOption(options, selectedChat);
      const currentEffort = preferredEffortOption(options, selectedChat);
      setSelectedModelIndex(currentModel ? String(currentModel.index) : "");
      setSelectedEffortId(currentEffort?.id || "");
    } catch (error: any) {
      window.alert(error?.message || "모델 목록 새로고침에 실패했습니다.");
    } finally {
      setModelRefreshing(false);
    }
  }
  // 선택한 모델의 안정 ID와 추론 강도를 실제 채팅 TUI의 /model 메뉴에 적용한다.
  async function applyModelSelection(): Promise<void> {
    if (!selectedChat || !selectedModelIndex) return;
    const selectedModel = modelOptions?.models?.find((item: Json) => String(item.index) === selectedModelIndex);
    if (!selectedModel?.id) return;
    setModelApplying(true);
    try {
      await api(`/chats/${selectedChat.id}/model`, { method: "POST", body: JSON.stringify({ modelIndex: Number(selectedModelIndex), modelId: selectedModel.id, effortId: selectedEffortId || null }) });
    } catch (error: any) {
      window.alert(error?.message || "모델 변경에 실패했습니다.");
    } finally {
      setModelApplying(false);
    }
  }
  // 입력한 이름을 실제 CLI의 /rename 명령으로 보낸다(Claude·Codex 둘 다 지원). 성공하면 서버가
  // chats.title도 함께 갱신해 웹소켓으로 알려주므로, 여기서는 별도로 로컬 상태를 앞서 바꾸지 않는다.
  async function submitRename(): Promise<void> {
    if (!selectedChat || !renameValue.trim()) return;
    setRenaming(true);
    try {
      await api(`/chats/${selectedChat.id}/rename`, { method: "POST", body: JSON.stringify({ name: renameValue.trim() }) });
      setEditingTitle(false);
    } catch (error: any) {
      window.alert(error?.message || "이름 변경에 실패했습니다.");
    } finally {
      setRenaming(false);
    }
  }
  // 백업 시각을 사이드바에 들어갈 짧은 표시로 변환한다.
  function formatBackupTime(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  }
  // 선택된 채팅의 현재 JSONL 기록을 백업한다.
  async function handleBackup(): Promise<void> {
    if (!selectedChat) return;
    setSessionActionStatus("백업 중…");
    try {
      await backupChat(selectedChat.id);
      setSessionActionStatus("백업했습니다.");
    } catch (error: any) {
      setSessionActionStatus(error?.message || "백업에 실패했습니다.");
    }
  }
  // 선택된 채팅을 백업 없이 앱과 공급자 기록에서 삭제한다.
  async function handleDeleteOnly(): Promise<void> {
    if (!selectedChat || !window.confirm(deleteConfirmMessage("이 세션을 백업 없이 삭제할까요? 실행 중이면 먼저 종료됩니다."))) return;
    setSessionActionStatus("삭제 중…");
    try {
      const result = await deleteChat(selectedChat.id, false);
      setSessionActionStatus(result?.workspace?.worktreeRemoved ? "세션과 작업공간을 삭제했습니다." : "세션을 삭제했습니다.");
    } catch (error: any) {
      setSessionActionStatus(error?.message || "삭제에 실패했습니다.");
    }
  }
  // 선택된 채팅을 백업한 뒤 앱과 공급자 기록에서 삭제한다.
  // 삭제하려는 채팅이 그 worktree를 쓰는 마지막 채팅이면 폴더까지 정리된다.
  // 되돌릴 수 없는 일이라 지우기 전에 그 사실을 확인 문구에 함께 보여준다.
  function deleteConfirmMessage(base: string): string {
    const worktreePath = selectedChat?.worktree_path;
    if (!worktreePath) return base;
    const sharing = (chats as Json[]).filter((item: Json) => item.worktree_path === worktreePath).length;
    if (sharing > 1) return `${base}\n\n이 작업공간은 다른 채팅 ${sharing - 1}개도 함께 쓰고 있어 폴더는 그대로 남습니다.`;
    return `${base}\n\n이 채팅이 작업공간을 쓰는 마지막 채팅이라, 삭제하면 작업공간 폴더도 함께 정리됩니다.\n${selectedChat?.git_branch || ""}\n${worktreePath}\n\n커밋하지 않은 변경이 있으면 삭제가 취소됩니다.`;
  }

  async function handleDelete(): Promise<void> {
    if (!selectedChat || !window.confirm(deleteConfirmMessage("이 세션을 백업한 뒤 삭제할까요? 실행 중이면 먼저 종료됩니다."))) return;
    setSessionActionStatus("백업 후 삭제 중…");
    try {
      const result = await deleteChat(selectedChat.id);
      setSessionActionStatus(result?.workspace?.worktreeRemoved ? "세션과 작업공간을 삭제했습니다." : "세션을 삭제했습니다.");
    } catch (error: any) {
      setSessionActionStatus(error?.message || "삭제에 실패했습니다.");
    }
  }
  // 백업된 JSONL을 원래 공급자 기록 저장소에 되돌리고 채팅을 복원한다.
  async function handleRestore(backupId: string): Promise<void> {
    if (!window.confirm("이 백업을 복원할까요? 같은 원본 파일이 있으면 별도 복원 파일을 만듭니다.")) return;
    setSessionActionStatus("복원 중…");
    try {
      await restoreBackup(backupId);
      setSessionActionStatus("복원했습니다.");
      setMenuOpen(false);
    } catch (error: any) {
      setSessionActionStatus(error?.message || "복원에 실패했습니다.");
    }
  }
  // 백업 사본만 지운다(원본 채팅·공급자 기록은 그대로) — 되돌릴 수 없어 먼저 확인받는다.
  async function handleDeleteBackup(backupId: string): Promise<void> {
    if (!window.confirm("이 백업을 삭제할까요? 되돌릴 수 없습니다.")) return;
    setSessionActionStatus("백업 삭제 중…");
    try {
      await deleteBackup(backupId);
      setSessionActionStatus("백업을 삭제했습니다.");
    } catch (error: any) {
      setSessionActionStatus(error?.message || "백업 삭제에 실패했습니다.");
    }
  }
  // 도구·상세 전용 메시지는 showToolDetails가 꺼져 있으면 아예 렌더링되지 않는데(MessageCard가 null 반환),
  // 이런 항목까지 가상 스크롤 카운트에 포함되면 실제로는 화면에 없는 항목이 추정 높이(90px)만큼 전체 높이를
  // 부풀려 "맨 아래로" 이동이 중간에서 멈추는 원인이 된다. 렌더링될 항목만 미리 걸러 카운트를 맞춘다.
  const visibleMessages = useMemo(() => messages.filter((message: Json) => {
    const display = splitMessageContent(message);
    return !!display.primary || (showToolDetails && display.details.length > 0);
  }), [messages, showToolDetails]);
  // 대화가 길어져도 렉 없이 화면에 보이는 메시지만 렌더링한다. 실제 높이가 제각각이라 렌더 후 다시 측정한다.
  // id로 키를 잡아야 앞쪽에 이전 메시지가 붙어 인덱스가 밀려도 이미 측정한 높이가 엉키지 않는다.
  const rowVirtualizer = useVirtualizer({
    count: visibleMessages.length,
    getScrollElement: () => scrollParent.current,
    estimateSize: () => 90,
    overscan: 6,
    getItemKey: (index) => visibleMessages[index]?.id ?? index,
  });
  // 이전 메시지 자동 로드는 실제로 사용자가 손으로 위로 스크롤했을 때만 허용한다. 그렇지 않으면 아래
  // "맨 아래 정렬"·"위치 유지"가 실행하는 프로그래밍적 스크롤 중에도 자동 로드가 발동해, 과거 메시지가
  // 앞에 붙어 배열이 바뀌고 다시 로드 조건에 걸리는 무한 로드로 이어졌다.
  // scrollState에 저장해 탭을 벗어났다 돌아와도(컴포넌트 재마운트) 유지되게 한다.
  const programmaticScrollRef = useRef(0);
  // 모바일에서 스크롤하면 브라우저 주소창이 접히며 100dvh 기반 컨테이너 자체가 커지는데(아래 ResizeObserver
  // 참고), 그 순간 "맨 아래였는지"를 판단할 기준이 필요해 매 스크롤마다 갱신해둔다.
  const wasNearBottomRef = useRef(true);
  // 실제 스크롤 입력이 시작되면 진행 중인 하단 정렬을 취소해 사용자가 고른 위치를 우선한다.
  function cancelAutomaticScroll(): void {
    if (programmaticScrollRef.current <= 0) return;
    settleTokenRef.current += 1;
    programmaticScrollRef.current = 0;
  }
  function handleMessagesScroll(): void {
    const element = scrollParent.current;
    if (!element) return;
    scrollState.scrollTop = element.scrollTop;
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    wasNearBottomRef.current = nearBottom;
    if (programmaticScrollRef.current <= 0) {
      // 하단까지 내려온 사용자는 다시 최신 응답 추적 상태로 전환한다. 예전에는 실제 스크롤 이벤트가
      // 한 번이라도 발생하면 영구히 true가 되어, 답변을 기다리며 맨 아래에 있어도 새 응답을 따라가지 않았다.
      scrollState.userScrolled = !nearBottom;
      // 이 채팅이 계속 갱신 중이면 "맨 아래 정렬" 루프가 반복 트리거되는데, 그 루프가 실행되는 도중
      // 사용자가 실제로 스크롤을 시작하면 매 프레임 scrollToOffset이 사용자 스크롤을 계속 밀어내
      // "위로 스크롤해도 한참 안 먹히는" 것처럼 보였다. 사용자 스크롤이 감지되면 진행 중인 정렬을 즉시 취소한다.
      settleTokenRef.current += 1;
      // 맨 위 근처까지 스크롤하면 이전 구간을 커서 기반으로 더 불러온다. 가상 아이템 인덱스(예: "맨 위
      // 노출 인덱스가 2 이하")로 판단하면 메시지 높이가 제각각이라 짧은 메시지가 많을 땐 살짝만
      // 스크롤해도 인덱스가 금방 낮아져 실제로는 맨 위 근처가 아닌데도 너무 일찍 로드가 걸렸다. 실제
      // 스크롤 위치(맨 위에서 남은 픽셀)로 판단해야 체감과 맞는다.
      if (element.scrollTop <= TOP_LOAD_THRESHOLD_PX) triggerLoadMore();
    }
  }
  // rowVirtualizer가 실행하는 스크롤 조작을 "프로그래밍적"으로 표시해 위 onScroll 핸들러가 무시하게 한다.
  function programmaticScroll(action: () => void): void {
    programmaticScrollRef.current += 1;
    action();
    requestAnimationFrame(() => { programmaticScrollRef.current = Math.max(0, programmaticScrollRef.current - 1); });
  }
  // 재마운트(다른 탭 갔다 옴) 직후에는 DOM이 새로 생겨 scrollTop이 0부터 시작한다. 아래 정렬 effect가
  // "채팅도 안 바뀌고 앞에 추가된 것도 없다"고 판단해 아무 스크롤도 하지 않을 조건(사용자가 과거를 보고
  // 있던 경우)에 원래 위치가 유지되도록, paint 전에 저장해둔 위치로 먼저 복원한다.
  useLayoutEffect(() => {
    const element = scrollParent.current;
    if (element && scrollState.userScrolled) element.scrollTop = scrollState.scrollTop;
  }, []);
  // messages는 채팅 전환 직후(이전 채팅 데이터) → API 응답 도착(새 채팅 데이터) 순으로 매우 짧은 간격을 두고
  // 두 번 이상 바뀔 수 있어 이 effect도 연달아 여러 번 실행된다. 각 실행이 독립된 rAF 보정 루프를 새로 시작하면
  // 오래된 루프와 최신 루프가 서로 다른 total을 기준으로 스크롤을 다투게 되어 결과가 실행마다 달라진다.
  // 매 실행마다 토큰을 새로 발급해 이전 루프는 다음 프레임에 스스로 멈추게 한다.
  const settleTokenRef = useRef(0);
  // settleToBottom은 여러 프레임에 걸쳐 반복 스크롤한다. 매 프레임마다 programmaticScroll()로 개별
  // 표시하면, "1 증가 → 액션 → 다음 프레임에 1 감소"와 "다음 settle 프레임의 1 증가"가 경합하면서
  // 카운터가 잠깐 0으로 떨어지는 찰나가 생긴다. 그 순간 실제 브라우저 scroll 이벤트가 끼어들면
  // "사용자가 스크롤함"으로 오인해 자동 이전 메시지 로드가 재발동했다. 루프 전체를 하나의 프로그래밍적
  // 스크롤 구간으로 묶어 이 경합 자체를 없앤다.
  function settleToBottom(): void {
    const token = (settleTokenRef.current += 1);
    programmaticScrollRef.current += 1;
    let attempts = 0;
    let lastTotal = -1;
    let stableStreak = 0;
    const finish = (): void => {
      // 마지막 스크롤에 대한 브라우저 scroll 이벤트가 확실히 지나간 뒤에 표시를 해제한다.
      requestAnimationFrame(() => requestAnimationFrame(() => { programmaticScrollRef.current = Math.max(0, programmaticScrollRef.current - 1); }));
    };
    const settle = (): void => {
      if (settleTokenRef.current !== token) { finish(); return; }
      const total = rowVirtualizer.getTotalSize();
      // scrollTop을 total로 설정하면 브라우저가 자동으로 실제 최대치(scrollHeight - clientHeight)로
      // clamp하므로 항상 "그 시점에 알려진" 끝까지 정확히 이동한다.
      rowVirtualizer.scrollToOffset(total);
      attempts += 1;
      // 실측 반영이 리렌더를 거쳐 한 프레임 늦게 나타날 수 있어, 한 번 변화 없음만으로는 끝난 것으로
      // 보지 않고 연속 여러 프레임 안정된 뒤에만 멈춘다.
      stableStreak = total === lastTotal ? stableStreak + 1 : 0;
      lastTotal = total;
      if (attempts < 60 && stableStreak < 5) { requestAnimationFrame(settle); return; }
      finish();
    };
    requestAnimationFrame(settle);
  }
  // 모바일(삼성 인터넷 등)에서 스크롤 중 브라우저 주소창이 접히거나 나타나면, 채팅 화면이 쓰는
  // 100dvh(동적 뷰포트 높이) 컨테이너 자체의 실제 픽셀 높이가 바뀐다. 이미 "맨 아래"로 스크롤해둔
  // 상태였다면 스크롤 위치(scrollTop)는 그대로인데 컨테이너만 커져서, 그 차이만큼 아래쪽에 빈 여백이
  // 생긴 것처럼 보였다. 컨테이너 크기가 바뀔 때 직전에 맨 아래 근처였다면 다시 맨 아래로 맞춰준다.
  useEffect(() => {
    const element = scrollParent.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (wasNearBottomRef.current) settleToBottom();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // 채팅 전환이면 무조건 맨 아래로. 앞쪽에 메시지가 추가됐으면(위로 스크롤해 이전 메시지를 불러온 경우)
  // 그 위치를 유지. 그 외(뒤쪽에 새 메시지가 붙었거나 아무 변화 없음)에는 직전에 하단을 보고 있었으면
  // 계속 따라가고, 과거를 읽는 중이면 보던 위치를 그대로 둔다(재마운트 시에는 위 useLayoutEffect가
  // 복원해둔 위치가 유지된다).
  useEffect(() => {
    if (!visibleMessages.length) { prevFirstId.current = null; prevChatId.current = selectedChat?.id ?? null; return; }
    const chatChanged = prevChatId.current !== (selectedChat?.id ?? null);
    if (chatChanged) scrollState.userScrolled = false;
    const keptIndex = chatChanged ? -1 : visibleMessages.findIndex((message: Json) => message.id === prevFirstId.current);
    if (!chatChanged && keptIndex > 0) {
      settleTokenRef.current += 1;
      programmaticScroll(() => rowVirtualizer.scrollToIndex(keptIndex, { align: "start" }));
    } else if (chatChanged || wasNearBottomRef.current || !scrollState.userScrolled) {
      settleToBottom();
    }
    prevFirstId.current = visibleMessages[0].id;
    prevChatId.current = selectedChat?.id ?? null;
  }, [visibleMessages, selectedChat?.id, rowVirtualizer]);
  // 로드 직후 "위치 유지" 스크롤(align:start)이 실제 DOM에 반영되기 전에 스크롤 위치가 잠깐 그대로
  // 남아있어, 하나의 스크롤 동작에 짧은 시간 동안 여러 페이지가 연쇄 호출되는 문제가 있었다. 로드
  // 직후 짧게 쉬어 위치가 안정된 뒤에만 다시 트리거되게 한다.
  const loadCooldownRef = useRef(false);
  function triggerLoadMore(): void {
    if (!hasMoreMessages || loadingMore || loadCooldownRef.current) return;
    setLoadingMore(true);
    loadCooldownRef.current = true;
    void loadMoreMessages().finally(() => {
      setLoadingMore(false);
      setTimeout(() => { loadCooldownRef.current = false; }, 250);
    });
  }
  // 도구·diff 상세를 꺼두면 그 메시지들이 visibleMessages에서 아예 빠져, 유저·assistant 대화만으로는
  // 화면을 못 채워 스크롤 자체가 생기지 않는 채팅이 있다. 스크롤이 안 생기면 위 effect가 의존하는 실제
  // 스크롤 이벤트도 영영 안 일어나 이전 메시지를 못 불러오게 되므로, 스크롤이 생길 때까지만 이어서
  // 불러온다 — 화면이 차서 스크롤이 생기거나(scrollHeight > clientHeight), 더 불러올 대화가 없으면
  // (hasMoreMessages는 triggerLoadMore 안에서 확인) 그대로 멈춘다. 전체 히스토리를 무조건 다 끌어오는
  // 게 아니라, 딱 스크롤이 가능해질 때까지만이다.
  useEffect(() => {
    const element = scrollParent.current;
    if (!element || element.scrollHeight > element.clientHeight) return;
    triggerLoadMore();
  }, [visibleMessages, hasMoreMessages, loadingMore, loadMoreMessages]);
  // 채팅에 파일을 업로드해 프로젝트 폴더에 저장하고, 실제 터미널이 읽을 수 있는 상대 경로를 입력창에 덧붙인다.
  // 이미지면 보낸 뒤가 아니라 지금 바로 확인할 수 있도록 입력창 위에 썸네일도 같이 쌓아둔다.
  async function uploadAttachments(files: File[]): Promise<void> {
    if (!selectedChat || !files.length) return;
    setAttachmentStatus(`첨부 업로드 중… (${files.length}개)`);
    try {
      for (const file of files) {
        const form = new FormData();
        form.append("file", file, file.name || "붙여넣기.png");
        const data = await api(`/chats/${selectedChat.id}/attachments`, { method: "POST", body: form });
        const uploaded = data.uploads?.[0]?.path;
        if (uploaded) {
          setText((current: string) => `${current}${current.trim() ? "\n" : ""}[첨부: ${uploaded}]`);
          if (isImagePath(uploaded)) setAttachmentPreviews((current) => [...current, { path: uploaded, name: file.name || uploaded }]);
        }
      }
      setAttachmentStatus("");
    } catch (error: any) {
      setAttachmentStatus(error?.message || "첨부 업로드에 실패했습니다.");
    }
  }
  // 미리보기를 지우면 입력창에 자동으로 덧붙었던 첨부 표시 줄도 같이 걷어낸다.
  function removeAttachmentPreview(path: string): void {
    setAttachmentPreviews((current) => current.filter((item) => item.path !== path));
    setText((current) => current.split("\n").filter((line) => line.trim() !== `[첨부: ${path}]`).join("\n"));
  }
  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>): void {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (!files.length) return;
    event.preventDefault();
    void uploadAttachments(files);
  }
  function handleDrop(event: React.DragEvent<HTMLElement>): void {
    event.preventDefault();
    void uploadAttachments(Array.from(event.dataTransfer?.files ?? []));
  }
  // Alt+Enter 또는 Ctrl+Enter로 줄바꿈 없이 바로 전송한다(Enter는 줄바꿈으로 남겨둔다).
  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (commandMenuOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setCommandIndex((index) => Math.min(index + 1, Math.max(0, filteredCommands.length - 1)));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setCommandIndex((index) => Math.max(index - 1, 0));
        return;
      }
      if (event.key === "Enter" && !event.altKey && !event.ctrlKey) {
        event.preventDefault();
        const selected = filteredCommands[commandIndex] || filteredCommands[0];
        if (selected) insertSlashCommand(selected);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedCommandText(text);
        return;
      }
    }
    if (event.key === "Enter" && (event.altKey || event.ctrlKey)) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }
  function insertSlashCommand(command: Json): void {
    const template = command.template || command.command || command.name;
    setText(template);
    setCommandIndex(0);
    setDismissedCommandText("");
    requestAnimationFrame(() => textarea.current?.focus());
  }
  const commandQuery = text.startsWith("/") && !/\s/.test(text) ? text.slice(1).toLowerCase() : "";
  const commandMenuOpen = !!selectedChat && text.startsWith("/") && !/\s/.test(text) && text !== dismissedCommandText;
  const filteredCommands = useMemo(() => {
    if (!commandMenuOpen) return [];
    const providerCommands = commandItems.filter((item: Json) => item.provider === selectedChat?.provider);
    const needle = commandQuery.trim();
    return providerCommands
      .filter((item: Json) => !needle || String(item.name || item.command || "").toLowerCase().includes(needle) || String(item.description || "").toLowerCase().includes(needle))
      .sort((a: Json, b: Json) => String(a.name || a.command).localeCompare(String(b.name || b.command)))
      .slice(0, 80);
  }, [commandItems, commandMenuOpen, commandQuery, selectedChat?.provider]);
  useEffect(() => { setCommandIndex(0); }, [commandQuery, selectedChat?.provider]);
  // 드롭다운에 표시하는 "(현재)"는 이 채팅의 실제 현재 모델·강도를 기준으로 계산해야 한다 —
  // modelOptions[].current는 채팅과 무관한 공용 상태 조회 PTY의 스냅샷 값이라, 모델을 바꿔도 이
  // 채팅 기준으로는 갱신되지 않고 계속 예전 값을 "(현재)"로 보여줬다(드롭다운이 실제로 어떤 값을
  // 선택해둘지는 이미 preferredModelOption/Effort로 채팅 기준으로 맞춰져 있었는데, 라벨 텍스트만
  // 그걸 안 쓰고 있었음).
  const currentModelOption = modelOptions ? preferredModelOption(modelOptions, selectedChat) : null;
  const currentEffortOption = modelOptions ? preferredEffortOption(modelOptions, selectedChat) : null;
  const terminalMode = chatViewMode === "terminal";
  // 대화/터미널 전환을 계정 기본값으로 저장하되 실패하면 현재 화면을 원래 모드로 되돌린다.
  async function selectViewMode(mode: "chat" | "terminal"): Promise<void> {
    if (mode === chatViewMode || viewModeSaving) return;
    setViewModeSaving(true);
    try {
      await changeChatViewMode(mode);
    } catch (error: any) {
      window.alert(error?.message || "채팅 화면 모드를 저장하지 못했습니다.");
    } finally {
      setViewModeSaving(false);
    }
  }
  return <>
    <section className={`chat-layout${pendingApprovals.length ? " has-approvals" : ""}`}>
    <aside className="chat-list"><div className="list-title"><h3>채팅</h3><div>{createTargets.map((target) => <button key={target.key} onClick={() => createChat(target.provider, target.accountId)}>+ {target.label}</button>)}</div></div>
      {!project && <p className="muted">프로젝트를 먼저 선택하세요.</p>}
      {chatGroups.map((group) => <div className="chat-group" key={group.key}>
        <button type="button" className="chat-group-head" aria-expanded={!collapsedGroups[group.key]} onClick={() => setCollapsedGroups((current) => ({ ...current, [group.key]: !current[group.key] }))}>
          <span className="chat-group-caret">{collapsedGroups[group.key] ? "▸" : "▾"}</span>
          <b>{group.label}</b>
          <span className="chat-group-count">{group.chats.length}</span>
        </button>
        {!collapsedGroups[group.key] && <>
          <div className="chat-group-actions">{createTargets.map((target) => (
            <button key={target.key} disabled={groupBusy === `${target.provider}:${group.worktreePath}`} onClick={() => void createChatInGroup(group, target.provider, target.accountId)}>+ {target.label}</button>
          ))}</div>
          {group.chats.map((chat: Json) => { const activity = chatActivity(chat, pendingApprovals); return <button className={`chat-item ${selectedChat?.id === chat.id ? "active" : ""}`} key={chat.id} onClick={() => setSelectedChat(chat)}>
            <span className={`provider ${chat.provider}`}>{providerMeta(chat.provider).label}</span><strong>{chat.title}</strong><span className="chat-id">#{chat.id}</span><small><span className={`activity-chip ${activity.className}`}>{activity.label}</span><span className="chat-branch">{chat.git_branch || "프로젝트 공유"}</span></small>
          </button>; })}
        </>}
      </div>)}
      {selectedChat && <div className="session-actions"><button onClick={() => void handleBackup()}>세션 백업</button><button className="danger" onClick={() => void handleDeleteOnly()}>삭제</button><button className="danger" onClick={() => void handleDelete()}>백업 후 삭제</button></div>}
      {!!sessionBackups?.length && <button className="backup-toggle" aria-pressed={showBackups} onClick={() => setShowBackups((open) => !open)}>백업 목록 {showBackups ? "숨기기" : `보기 (${sessionBackups.length})`}</button>}
      {sessionActionStatus && <span className="session-action-status">{sessionActionStatus}</span>}
      {showBackups && !!sessionBackups?.length && <div className="backup-list"><h4>백업</h4>{sessionBackups.map((backup: Json) => <article className="backup-item" key={backup.id}><b>{backup.title}</b><span>{providerMeta(backup.provider).label} · {formatBackupTime(backup.backedUpAt)}</span><div className="backup-item-actions"><button disabled={backup.chatExists} onClick={() => void handleRestore(backup.id)}>{backup.chatExists ? "복원됨" : "복원"}</button><button className="danger" onClick={() => void handleDeleteBackup(backup.id)}>삭제</button></div></article>)}</div>}
    </aside>
    <div className={`workspace${terminalMode ? " terminal-mode" : ""}`}><div className="workspace-head"><button className="mobile-menu-button" aria-label="메뉴 열기" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>☰</button><div>
      {editingTitle
        ? <form className="title-edit" onSubmit={(event) => { event.preventDefault(); void submitRename(); }}>
            <input autoFocus aria-label="채팅 이름" value={renameValue} onChange={(event) => setRenameValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setEditingTitle(false); }} />
            <button type="submit" disabled={renaming || !renameValue.trim()}>{renaming ? "저장 중…" : "저장"}</button>
            <button type="button" onClick={() => setEditingTitle(false)}>취소</button>
          </form>
        : <h2><span className="title-text">{selectedChat?.title || "에이전트 채팅"}</span>{selectedChat && <button type="button" className="title-edit-button" aria-label="채팅 이름 변경" title="이름 변경 (CLI /rename)" onClick={() => { setRenameValue(selectedChat.title || ""); setEditingTitle(true); }}>✎</button>}</h2>}
      <div className="workspace-meta"><span>{selectedChat ? `${selectedProvider.label}${accountLabel(selectedChat) ? ` · ${accountLabel(selectedChat)}` : ""} · ${selectedActivity?.label ?? selectedChat.status}` : ""}</span>
      {selectedChat && user?.role === "admin" && accountList.filter((account: Json) => account.provider === selectedChat.provider).length > 1 && ["stopped", "error"].includes(selectedChat.status)
        && <select className="chat-account-select" aria-label="이 채팅의 인증 계정" value={selectedChat.account_id ?? ""} onChange={(event) => void changeAccount(Number(event.target.value))}>
          {accountList.filter((account: Json) => account.provider === selectedChat.provider).map((account: Json) => <option key={account.id} value={account.id}>{account.label}</option>)}
        </select>}
      {selectedChat && project && <GitBranchControl projectId={project.id} chat={selectedChat} canManage={user?.role === "admin"} variant="inline" onChanged={refreshChats} />}</div></div>{selectedChat && <div className="workspace-head-actions">
        {user?.role === "admin" && <button type="button" className="icon-button" aria-label="서브 에이전트 관리" title="서브 에이전트 관리" aria-expanded={subagentOpen} onClick={() => setSubagentOpen(true)}><Bot size={17} aria-hidden="true" /></button>}
        {["stopped", "error"].includes(selectedChat.status)
          ? <button className="primary" onClick={() => startChat(selectedChat.id)}>터미널 시작</button>
          : <button className="danger" onClick={() => stop(selectedChat.id)}>터미널 종료</button>}
      </div>}</div>
      <nav className="chat-view-tabs" aria-label="채팅 화면 모드">
        <button type="button" aria-pressed={!terminalMode} disabled={viewModeSaving} onClick={() => void selectViewMode("chat")}>채팅 모드</button>
        <button type="button" aria-pressed={terminalMode} disabled={viewModeSaving} onClick={() => void selectViewMode("terminal")}>터미널 모드</button>
      </nav>
      {selectedChat && <div className="model-bar-summary">
        <b>{selectedChat.model || "감지 중…"}</b>
        {selectedActivity && <b className={`activity-text ${selectedActivity.className}`}>{selectedActivity.label}</b>}
        {primaryUsageWindow && <span>{primaryUsageWindow.usedPercent}%</span>}
        <button type="button" aria-expanded={modelBarExpanded} onClick={() => setModelBarExpanded((value) => !value)}>{modelBarExpanded ? "접기 ▴" : "자세히 ▾"}</button>
      </div>}
      {selectedChat && <div className={`model-bar${modelBarExpanded ? " expanded" : ""}`}>
        <span>모델 <b>{selectedChat.model || "감지 중…"}</b></span>
        {selectedActivity && <span>상태 <b className={`activity-text ${selectedActivity.className}`}>{selectedActivity.label}</b></span>}
        {primaryUsageWindow && <span>주요 사용량 <b>{primaryUsageWindow.usedPercent}%</b>{primaryUsageWindow.resetAt && ` · 초기화 ${primaryUsageWindow.resetAt}`}</span>}
        <label className="tool-details-toggle"><input type="checkbox" checked={showToolDetails} onChange={(event) => setShowToolDetails(event.target.checked)} />도구·diff 상세 보기</label>
        {!!modelOptions?.models?.length && <select aria-label="모델 선택" value={selectedModelIndex} onChange={(event) => setSelectedModelIndex(event.target.value)}>
          {modelOptions.models.map((item: Json) => <option key={item.index} value={item.index}>{item.label}{item.index === currentModelOption?.index ? " (현재)" : ""}</option>)}
        </select>}
        {!!modelOptions?.efforts?.length && <select aria-label="추론 강도 선택" value={selectedEffortId} onChange={(event) => setSelectedEffortId(event.target.value)}>
          {modelOptions.efforts.map((item: Json) => <option key={item.id} value={item.id}>{item.label}{item.id === currentEffortOption?.id ? " (현재)" : ""}</option>)}
        </select>}
        <button type="button" disabled={modelLoading || modelApplying || !selectedModelIndex} onClick={() => void applyModelSelection()}>{modelApplying ? "적용 중…" : modelLoading ? "모델 확인 중…" : "모델 적용"}</button>
        <button type="button" disabled={modelRefreshing} title="상태 조회용 CLI에 다시 물어 모델·추론 강도 목록을 새로고침합니다" onClick={() => void refreshModelOptions()}>{modelRefreshing ? "새로고침 중…" : "모델 목록 새로고침"}</button>
        {selectedProvider.supportsPermissionMode && selectedChat.permission_mode && <span>권한 모드 <b>{selectedChat.permission_mode}</b></span>}
        {selectedProvider.supportsPermissionMode && selectedChat.status === "running" && <button type="button" disabled={cyclingMode} title="기본(권한 요청)·auto-accept edits·plan mode 순으로 전환합니다" onClick={() => {
          setCyclingMode(true);
          void cycleMode(selectedChat.id).catch((error: any) => window.alert(error?.message || "모드 전환에 실패했습니다.")).finally(() => setCyclingMode(false));
        }}>{cyclingMode ? "전환 중…" : "모드 전환"}</button>}
      </div>}
      {selectedApprovals.length > 0 && <div className="inline-approvals">{selectedApprovals.map((item: Json) => <ApprovalCard key={item.id} item={item} decide={decide} />)}</div>}
      {terminalMode
        ? <section className="terminal-panel terminal-panel-full" aria-label="채팅 터미널"><div className="terminal-panel-head"><span>채팅 터미널</span><small>현재 CLI 세션에 직접 입력합니다</small></div>{selectedChat ? <TerminalPanel chat={selectedChat} socket={socket} /> : <div className="terminal-empty">채팅을 선택하세요.</div>}</section>
        : <div className="conversation"><div className="messages" ref={scrollParent} onScroll={handleMessagesScroll} onWheel={cancelAutomaticScroll} onTouchStart={cancelAutomaticScroll} onPointerDown={cancelAutomaticScroll}>
          {loadingMore && <div className="load-more-indicator">이전 메시지 불러오는 중…</div>}
          <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative", width: "100%" }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => <div key={visibleMessages[virtualRow.index].id} data-index={virtualRow.index} ref={rowVirtualizer.measureElement} style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtualRow.start}px)` }}>
              <MessageCard message={visibleMessages[virtualRow.index]} showDetails={showToolDetails} project={project} onOpenProjectFile={onOpenProjectFile} />
            </div>)}
          </div>
        </div>
        {busy && <div className="busy-indicator"><span className="busy-dots"><i /><i /><i /></span>작업중…</div>}
        {selectedChat && <form className="composer" onDragOver={(event) => event.preventDefault()} onDrop={handleDrop} onSubmit={(event) => {
          event.preventDefault();
          if (!text.trim()) return;
          const outgoing = text;
          const outgoingPreviews = attachmentPreviews;
          setText("");
          setAttachmentPreviews([]);
          setSendError("");
          // 이미 작업 중일 때 보낸 후속 입력은 TUI 큐로 들어간다. 중지 시 입력창에 복구할 대상은
          // 현재 실행을 시작한 원래 질문이어야 하므로 후속 입력으로 덮어쓰지 않는다.
          if (!busy) setLastSentByChatId((current) => ({ ...current, [selectedChat.id]: outgoing }));
          void send(outgoing).catch((error: any) => { setSendError(error?.message || "메시지 전송에 실패했습니다."); setText(outgoing); setAttachmentPreviews(outgoingPreviews); });
        }}>
          {attachmentStatus && <span className="attachment-status">{attachmentStatus}</span>}
          {sendError && <span className="attachment-status send-error">{sendError}</span>}
          {!!attachmentPreviews.length && <div className="attachment-preview-row">{attachmentPreviews.map((item) => <div className="attachment-preview" key={item.path}>
            <img src={attachmentUrl(project.id, item.path)} alt={item.name} />
            <button type="button" aria-label={`${item.name} 첨부 제거`} onClick={() => removeAttachmentPreview(item.path)}>×</button>
          </div>)}</div>}
          <div className="composer-row">
            <input ref={fileInput} type="file" multiple hidden onChange={(event) => { void uploadAttachments(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
            <button type="button" className="attach-button" aria-label="파일 첨부" onClick={() => fileInput.current?.click()}>📎</button>
            <div className="composer-input-wrap">
              {commandMenuOpen && <div className="slash-menu" role="listbox" aria-label="슬래시 명령어">
                {filteredCommands.length ? filteredCommands.map((item: Json, index: number) => <button key={item.id} type="button" role="option" aria-selected={index === commandIndex} className={index === commandIndex ? "active" : ""} onMouseDown={(event) => { event.preventDefault(); insertSlashCommand(item); }}>
                  <span className={`provider ${item.provider}`}>{providerMeta(item.provider).label}</span><strong>{item.name}</strong><small>{item.description}</small>
                </button>) : <div className="slash-empty">명령을 찾을 수 없습니다.</div>}
              </div>}
              <textarea ref={textarea} value={text} onChange={(event) => { const value = event.target.value; setText(value); if (value !== dismissedCommandText) setDismissedCommandText(""); }} onBlur={() => setDismissedCommandText(text)} onPaste={handlePaste} onKeyDown={handleComposerKeyDown} placeholder="질문을 입력하세요" rows={1} />
            </div>
            <div className="composer-actions">
              {busy && <button type="button" className="danger" disabled={interrupting} onClick={() => {
                  setInterrupting(true);
                  // 터미널에서도 취소된 질문이 입력창으로 복구되는 것과 동일하게, 웹 입력창이 비어 있을 때만
                  // 방금 보낸 질문을 되돌려준다(이미 다른 입력이 있으면 덮어쓰지 않는다). 터미널 쪽에는
                  // ESC 외에 아무것도 더 보내지 않으므로 실제 PTY에는 사용자가 직접 입력한 것만 들어간다.
                  const lastSent = lastSentByChatId[selectedChat.id];
                  if (lastSent && !text.trim()) setText(lastSent);
                  void interrupt(selectedChat.id).catch(() => setInterrupting(false));
                }}>{interrupting ? "중지 중…" : "중지"}</button>}
              <button className="primary" disabled={!text.trim()}>전송</button>
            </div>
          </div>
        </form>}
      </div>}
    </div>
    {!!pendingApprovals.length && <aside className="approval-list"><h3>권한 요청</h3>{pendingApprovals.map((item: Json) => <ApprovalCard key={item.id} item={item} decide={decide} />)}</aside>}
    </section>
    {menuOpen && <><button className="mobile-menu-backdrop" aria-label="메뉴 닫기" onClick={() => setMenuOpen(false)} /><aside className="mobile-chat-menu" aria-label="모바일 메뉴">
      <div className="mobile-menu-head"><strong>web-agent-manager</strong><button aria-label="메뉴 닫기" onClick={() => setMenuOpen(false)}>×</button></div>
      <label className="mobile-project-select"><span>프로젝트</span><select value={project?.id || ""} onChange={(event) => { setProject(projects.find((item: Json) => item.id === Number(event.target.value)) || null); setMenuOpen(false); }}><option value="">프로젝트 없음</option>{projects.map((item: Json) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
      <button onClick={() => { addProject(); setMenuOpen(false); }}>+ 프로젝트 추가</button>
      {project && <button className="project-delete" onClick={() => { void deleteProject(project); setMenuOpen(false); }}>🗑 현재 프로젝트 삭제</button>}
      <div className="mobile-new-chat">
        {createTargets.map((target, index: number) => <button key={target.key} className={index === 0 ? "primary" : ""} onClick={() => { void createChat(target.provider, target.accountId); setMenuOpen(false); }}>새 {target.label} 채팅</button>)}
      </div>
      {selectedChat && <div className="session-actions"><button onClick={() => void handleBackup()}>세션 백업</button><button className="danger" onClick={() => void handleDeleteOnly()}>삭제</button><button className="danger" onClick={() => void handleDelete()}>백업 후 삭제</button></div>}
      {!!sessionBackups?.length && <button className="backup-toggle" aria-pressed={showBackups} onClick={() => setShowBackups((open) => !open)}>백업 목록 {showBackups ? "숨기기" : `보기 (${sessionBackups.length})`}</button>}
      {sessionActionStatus && <span className="session-action-status">{sessionActionStatus}</span>}
      <h4>채팅 목록</h4>
      {chatGroups.map((group) => <div className="chat-group" key={group.key}>
        <button type="button" className="chat-group-head" aria-expanded={!collapsedGroups[group.key]} onClick={() => setCollapsedGroups((current) => ({ ...current, [group.key]: !current[group.key] }))}>
          <span className="chat-group-caret">{collapsedGroups[group.key] ? "▸" : "▾"}</span>
          <b>{group.label}</b>
          <span className="chat-group-count">{group.chats.length}</span>
        </button>
        {!collapsedGroups[group.key] && <>
          <div className="chat-group-actions">{createTargets.map((target) => (
            <button key={target.key} disabled={groupBusy === `${target.provider}:${group.worktreePath}`} onClick={() => { void createChatInGroup(group, target.provider, target.accountId).then(() => setMenuOpen(false)); }}>+ {target.label}</button>
          ))}</div>
          {group.chats.map((chat: Json) => { const activity = chatActivity(chat, pendingApprovals); return <button className={`chat-item ${selectedChat?.id === chat.id ? "active" : ""}`} key={chat.id} onClick={() => { setSelectedChat(chat); setMenuOpen(false); }}>
            <span className={`provider ${chat.provider}`}>{providerMeta(chat.provider).label}</span><strong>{chat.title}</strong><span className="chat-id">#{chat.id}</span><small><span className={`activity-chip ${activity.className}`}>{activity.label}</span><span className="chat-branch">{chat.git_branch || "프로젝트 공유"}</span></small>
          </button>; })}
        </>}
      </div>)}
      {showBackups && !!sessionBackups?.length && <h4>백업</h4>}
      {showBackups && sessionBackups?.map((backup: Json) => <article className="backup-item" key={backup.id}><b>{backup.title}</b><span>{providerMeta(backup.provider).label} · {formatBackupTime(backup.backedUpAt)}</span><div className="backup-item-actions"><button disabled={backup.chatExists} onClick={() => void handleRestore(backup.id)}>{backup.chatExists ? "복원됨" : "복원"}</button><button className="danger" onClick={() => void handleDeleteBackup(backup.id)}>삭제</button></div></article>)}
      {!!otherPendingApprovals.length && <h4>권한 요청</h4>}
      {otherPendingApprovals.map((item: Json) => <ApprovalCard key={item.id} item={item} decide={decide} />)}
    </aside></>}
    {subagentOpen && user?.role === "admin" && project && selectedChat && <SubagentManager
      project={project}
      selectedChat={selectedChat}
      providers={providerList}
      chats={chats}
      setSelectedChat={setSelectedChat}
      refreshChats={refreshChats}
      interrupt={interrupt}
      stop={stop}
      startChat={startChat}
      onClose={() => setSubagentOpen(false)}
    />}
  </>;
}
