import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { mergeMessages, reconcileOptimisticMessages } from "./message-display";
import { api, setCsrfToken } from "./api";
import { Login } from "./components/Login";
import { AgentIntegrationNotice } from "./components/AgentIntegrationNotice";
import { CliAuthPanel } from "./components/CliAuthPanel";
import { ProjectDialog } from "./components/ProjectDialog";
import {
  Files, FolderPlus, Gauge, GitPullRequest, KeyRound, MessageSquareText, ScrollText, Trash2, Wrench,
} from "lucide-react";
import { Overview } from "./features/overview/Overview";
import { ChatView } from "./features/chat/ChatView";
import { FilesView } from "./features/files/FilesView";
import { InstructionsView } from "./features/instructions/InstructionsView";
import { GitView } from "./features/git/GitView";
import { ToolsView } from "./features/tools/ToolsView";
import { notificationPermission, requestNotificationPermission, showNotification } from "./lib/notifications";
import { initClientLogging } from "./lib/logger";
import type { Json, Tab } from "./types";

// 렌더 전에 콘솔 티·전역 오류 수집을 설치해 이후 모든 로그가 서버에도 남게 한다.
initClientLogging();

// 데스크톱 상단 nav와 모바일 하단 탭바가 같은 탭 목록·라벨을 공유한다.
const TABS: Tab[] = ["overview", "chat", "files", "instructions", "git", "tools"];
const TAB_LABELS: Record<Tab, string> = { overview: "대시보드", chat: "채팅", files: "파일", instructions: "지침", git: "GitHub", tools: "도구" };
const TAB_ICONS: Record<Tab, typeof Gauge> = {
  overview: Gauge,
  chat: MessageSquareText,
  files: Files,
  instructions: ScrollText,
  git: GitPullRequest,
  tools: Wrench,
};

interface NavigationLocation {
  tab: Tab;
  chatId: number | null;
  projectId: number | null;
  filePath: string | null;
}

// 채팅 선택이 바뀌는 경로를 브라우저 콘솔에서 추적하기 위한 민감정보 없는 로그를 남긴다.
function logChatTrace(event: string, details: Record<string, unknown>): void {
  console.info("[web-agent-manager:chat]", event, { at: new Date().toISOString(), ...details });
}

// 주소창의 ?chat=번호 값을 읽어 특정 채팅으로 바로 들어갈 수 있게 한다.
function chatIdFromLocation(): number | null {
  const value = new URLSearchParams(window.location.search).get("chat");
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// 현재 URL에서 탭·채팅·프로젝트·파일 탐색 상태를 안전한 값으로 복원한다.
function navigationFromLocation(): NavigationLocation {
  const search = new URLSearchParams(window.location.search);
  const requestedTab = search.get("tab");
  const chatId = chatIdFromLocation();
  const projectValue = Number(search.get("project"));
  const projectId = Number.isInteger(projectValue) && projectValue > 0 ? projectValue : null;
  const filePath = search.get("file");
  const inferredTab: Tab = chatId ? "chat" : filePath !== null ? "files" : window.matchMedia("(max-width: 700px)").matches ? "chat" : "overview";
  return {
    tab: TABS.includes(requestedTab as Tab) ? requestedTab as Tab : inferredTab,
    chatId,
    projectId,
    filePath,
  };
}

// 프로젝트 경로 표시에서 서버가 알려준 홈 디렉터리(defaultPath, 하드코딩 아님) 접두사를 지워 목록을 덜 장황하게 보여준다.
function shortProjectPath(projectPath: string, home: string): string {
  if (!home) return projectPath;
  if (projectPath === home) return ".";
  if (projectPath.startsWith(`${home}/`)) return projectPath.slice(home.length + 1);
  return projectPath;
}

// 앱 내부 탐색 상태를 URL에 기록하고 사용자 탐색만 새 history 항목으로 추가한다.
function writeNavigation(location: NavigationLocation, mode: "push" | "replace"): void {
  const url = new URL(window.location.href);
  url.searchParams.set("tab", location.tab);
  if (location.chatId) url.searchParams.set("chat", String(location.chatId));
  else url.searchParams.delete("chat");
  if (location.projectId) url.searchParams.set("project", String(location.projectId));
  else url.searchParams.delete("project");
  if (location.tab === "files" && location.filePath !== null) url.searchParams.set("file", location.filePath);
  else url.searchParams.delete("file");
  window.history[mode === "push" ? "pushState" : "replaceState"]({ webAgentManager: true }, "", `${url.pathname}${url.search}${url.hash}`);
}

// 전체 관리 화면 상태와 실시간 갱신을 조정한다.
function App(): React.ReactElement {
  const initialNavigation = useRef<NavigationLocation>(navigationFromLocation());
  const [user, setUser] = useState<Json | null>(null); const [loading, setLoading] = useState(true); const [tab, setTab] = useState<Tab>(initialNavigation.current.tab);
  const [projects, setProjects] = useState<Json[]>([]); const [project, setProject] = useState<Json | null>(null); const [defaultProjectPath, setDefaultProjectPath] = useState(""); const [providers, setProviders] = useState<Json[]>([]); const [accounts, setAccounts] = useState<Json[]>([]); const [chats, setChats] = useState<Json[]>([]); const [chat, setChat] = useState<Json | null>(null); const [messages, setMessages] = useState<Json[]>([]); const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [targetChatId, setTargetChatId] = useState<number | null>(initialNavigation.current.chatId);
  const [usage, setUsage] = useState<Json[]>([]); const [system, setSystem] = useState<Json>({}); const [runtime, setRuntime] = useState<Json>({}); const [slack, setSlack] = useState<Json>({}); const [ntfy, setNtfy] = useState<Json>({}); const [approvals, setApprovals] = useState<Json[]>([]); const [sessionBackups, setSessionBackups] = useState<Json[]>([]); const [socket, setSocket] = useState<WebSocket | null>(null); const [error, setError] = useState("");
  const [showProjectDialog, setShowProjectDialog] = useState(false);
  const [showCliAuth, setShowCliAuth] = useState(false);
  const [cliAuthPending, setCliAuthPending] = useState(false);
  const [fileTarget, setFileTarget] = useState<{ projectId: number; path: string; requestId: number } | null>(
    initialNavigation.current.projectId && initialNavigation.current.filePath !== null
      ? { projectId: initialNavigation.current.projectId, path: initialNavigation.current.filePath, requestId: Date.now() }
      : null,
  );
  // 브라우저 알림 권한 상태. 탭을 새로고침하거나 다른 곳에서 권한을 바꿀 수 있어 마운트 시 한 번 읽어둔다.
  const [notifPermission, setNotifPermission] = useState<NotificationPermission>(() => notificationPermission());
  // ChatView는 tab이 바뀌면 언마운트되므로, 그 안의 useRef(사용자 스크롤 여부·이전 위치)로는 탭을 벗어났다
  // 돌아올 때 상태가 초기화되어 "채팅이 바뀐 것"으로 오인해 정렬이 처음부터 재실행되고 자동 로드가
  // 재발동하는 문제가 있었다. App은 언마운트되지 않으므로 여기서 들고 있다가 그대로 넘겨준다.
  const chatScrollStateRef = useRef({ userScrolled: false, prevChatId: null as number | null, prevFirstId: null as string | null, scrollTop: 0 });
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const projectRef = useRef(project);
  projectRef.current = project;
  const targetChatIdRef = useRef(targetChatId);
  targetChatIdRef.current = targetChatId;
  const userRef = useRef(user);
  userRef.current = user;
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const fileTargetRef = useRef(fileTarget);
  fileTargetRef.current = fileTarget;
  const projectSwitchRef = useRef(0);
  const selectionVersionRef = useRef(0);
  const chatListRequestRef = useRef(0);
  const lastSessionSaveVersionRef = useRef(0);
  const lastSessionSaveQueueRef = useRef<Promise<void>>(Promise.resolve());

  // 비동기 갱신에서도 즉시 같은 값을 보도록 채팅 타깃 state와 ref를 함께 바꾼다.
  function setPendingChatTarget(chatId: number | null): void {
    targetChatIdRef.current = chatId;
    setTargetChatId(chatId);
  }

  // 현재 선택 ref를 기준으로 URL 상태를 추가하거나 교체한다.
  function syncNavigation(mode: "push" | "replace", overrides: Partial<NavigationLocation> = {}): void {
    const nextTab = overrides.tab ?? tabRef.current;
    const nextFilePath = overrides.filePath !== undefined
      ? overrides.filePath
      : nextTab === "files" ? fileTargetRef.current?.path ?? "" : null;
    writeNavigation({
      tab: nextTab,
      chatId: overrides.chatId !== undefined ? overrides.chatId : chatRef.current?.id ?? null,
      projectId: overrides.projectId !== undefined ? overrides.projectId : projectRef.current?.id ?? null,
      filePath: nextFilePath,
    }, mode);
  }

  // 사용자가 탭을 누르면 현재 채팅·프로젝트를 유지한 새 브라우저 history 항목을 만든다.
  function selectTab(nextTab: Tab): void {
    if (tabRef.current === nextTab) return;
    tabRef.current = nextTab;
    setTab(nextTab);
    syncNavigation("push", { tab: nextTab, filePath: nextTab === "files" ? fileTargetRef.current?.path ?? "" : null });
  }

  // 프로젝트 기본 경로를 포함한 핵심 화면 데이터를 한 번에 다시 불러온다.
  async function loadCore(): Promise<void> {
    const projectSwitchVersion = projectSwitchRef.current;
    const selectionVersion = selectionVersionRef.current;
    const preferredChatId = targetChatIdRef.current ?? (!chatRef.current ? Number(userRef.current?.last_chat_id || 0) || null : null);
    logChatTrace("loadCore:start", { preferredChatId, currentChatId: chatRef.current?.id ?? null, targetChatId: targetChatIdRef.current, selectionVersion, userLastChatId: userRef.current?.last_chat_id ?? null });
    const [providerData, projectData, usageData, systemData, runtimeData, slackData, ntfyData, approvalData, preferredChatData] = await Promise.all([
      api("/providers"),
      api("/projects"),
      api("/usage"),
      api("/system"),
      api("/runtime"),
      api("/slack"),
      api("/ntfy"),
      api("/approvals"),
      preferredChatId ? api(`/chats/${preferredChatId}`).catch(() => null) : Promise.resolve(null),
    ]);
    const projectList = projectData.projects || [];
    if (projectData.defaultPath) setDefaultProjectPath(projectData.defaultPath);
    const preferredProjectId = (preferredChatData?.chat?.project_id ?? Number(userRef.current?.last_project_id || 0)) || null;
    const preferredProject = projectList.find((item: Json) => item.id === preferredProjectId) || null;
    setProviders(providerData.providers || []);
    // 계정 목록은 관리자 전용 API라 일반 사용자에게는 비워둔다(계정 선택 UI 자체가 나타나지 않는다).
    if (userRef.current?.role === "admin") void api("/agent-accounts").then((data) => setAccounts(data.accounts || [])).catch(() => undefined);
    setProjects(projectList);
    setProject((current) => {
      const switchedWhileLoading = projectSwitchRef.current !== projectSwitchVersion || selectionVersionRef.current !== selectionVersion;
      if (switchedWhileLoading && current && projectList.some((item: Json) => item.id === current.id)) return current;
      if (targetChatIdRef.current === preferredChatId && preferredProject) return preferredProject;
      if (current && projectList.some((item: Json) => item.id === current.id)) return current;
      return preferredProject || projectList[0] || null;
    });
    // URL은 최초 state와 popstate에서만 입력으로 읽는다. 이후 replaceState로 갱신된 URL을 매 실시간
    // 새로고침마다 다시 타깃으로 해석하면, 클릭 직전에 시작된 요청이 과거 채팅을 되살릴 수 있다.
    if (projectSwitchRef.current === projectSwitchVersion && selectionVersionRef.current === selectionVersion && preferredChatData?.chat && !chatRef.current && targetChatIdRef.current === null) {
      logChatTrace("loadCore:set-target", { reason: "empty-current", targetChatId: preferredChatData.chat.id, currentChatId: null, selectionVersion });
      setPendingChatTarget(preferredChatData.chat.id);
    }
    setUsage(usageData.usage); setSystem(systemData); setRuntime(runtimeData); setSlack(slackData); setNtfy(ntfyData); setApprovals(approvalData.approvals);
  }
  useEffect(() => { fetch("/api/auth/me").then(async (response) => { if (!response.ok) return; const data = await response.json(); setCsrfToken(data.csrfToken); setUser(data.user); }).finally(() => setLoading(false)); }, []);
  // 현재 선택된 채팅의 최신 메시지를 다시 읽어온다. 과거 구간과 작업 중 큐에 넣은 낙관적 입력을
  // 유지하되, JSONL에 실제 user 메시지가 새로 확인된 입력만 하나씩 확정해 중복을 제거한다.
  async function refetchCurrentMessages(): Promise<void> {
    const requestChatId = chatRef.current?.id;
    const selectionVersion = selectionVersionRef.current;
    if (!requestChatId) return;
    const data = await api(`/chats/${requestChatId}/messages`);
    if (chatRef.current?.id !== requestChatId || selectionVersionRef.current !== selectionVersion) {
      logChatTrace("messages:discard-stale", { requestChatId, currentChatId: chatRef.current?.id ?? null, selectionVersion });
      return;
    }
    setMessages((current: Json[]) => reconcileOptimisticMessages(current, data.messages));
    setHasMoreMessages((current: boolean) => current || data.hasMore);
  }
  // "작업중" 여부는 서버가 채팅별로 DB에 영속화해 관리한다(core/chat-busy.ts) — 클라이언트는 그 값을
  // 그대로 표시만 한다. 예전엔 웹소켓 chat_busy 이벤트만으로 별도 Set을 관리했는데, 모바일에서
  // 백그라운드로 갔다 온 사이 이벤트를 놓치면 영영 안 풀리거나, 메시지 내용만으로 완료 여부를
  // 추측하다 보니(새 프롬프트를 보내고 아직 아무 것도 기록되기 전과 실제로 끝난 뒤를 구분 못 함)
  // 자꾸 오판이 났다. /chats 목록을 다시 불러오기만 하면 항상 정확한 현재 상태로 재동기화된다.
  async function refetchChats(): Promise<void> {
    const requestProjectId = projectRef.current?.id;
    const requestId = ++chatListRequestRef.current;
    if (!requestProjectId) return;
    const data = await api(`/chats?projectId=${requestProjectId}`);
    if (projectRef.current?.id !== requestProjectId || chatListRequestRef.current !== requestId) {
      logChatTrace("refetchChats:discard-stale", { requestId, latestRequestId: chatListRequestRef.current, requestProjectId, currentProjectId: projectRef.current?.id ?? null, count: data.chats?.length ?? 0 });
      return;
    }
    logChatTrace("refetchChats:loaded", { projectId: requestProjectId, count: data.chats?.length ?? 0, currentChatId: chatRef.current?.id ?? null, targetChatId: targetChatIdRef.current, firstChatId: data.chats?.[0]?.id ?? null });
    setChats(data.chats);
    const current = chatRef.current;
    const requestedTargetId = targetChatIdRef.current;
    const targeted = requestedTargetId ? data.chats.find((item: Json) => item.id === requestedTargetId) : null;
    const next = targeted || data.chats.find((item: Json) => item.id === current?.id) || data.chats[0] || null;
    if (current?.id !== next?.id) logChatTrace("refetchChats:select", { previousChatId: current?.id ?? null, nextChatId: next?.id ?? null, targetedChatId: targeted?.id ?? null, fallbackFirstChatId: data.chats?.[0]?.id ?? null });
    chatRef.current = next;
    setChat(next);
    if (targeted && targetChatIdRef.current === requestedTargetId) {
      logChatTrace("refetchChats:clear-target", { targetChatId: requestedTargetId });
      setPendingChatTarget(null);
    }
    if (next) syncNavigation("replace", { chatId: next.id });
  }
  // 계정별 마지막 작업 위치를 서버에 저장한다.
  function rememberLastSession(projectId: number | null | undefined, chatId: number | null | undefined): void {
    const version = ++lastSessionSaveVersionRef.current;
    const body = { projectId: projectId || null, chatId: chatId || null };
    logChatTrace("lastSession:save:queued", { ...body, version });
    lastSessionSaveQueueRef.current = lastSessionSaveQueueRef.current.catch(() => undefined).then(async () => {
      logChatTrace("lastSession:save:start", { ...body, version });
      const data = await api("/auth/last-session", { method: "POST", body: JSON.stringify(body) });
      if (lastSessionSaveVersionRef.current !== version) return;
      logChatTrace("lastSession:save:done", { projectId: data.lastProjectId, chatId: data.lastChatId, version });
      setUser((current) => current ? { ...current, last_project_id: data.lastProjectId, last_chat_id: data.lastChatId } : current);
    }).catch((error) => logChatTrace("lastSession:save:error", { message: error instanceof Error ? error.message : "저장 실패", version }));
  }
  // 현재 웹 계정의 채팅 화면 모드를 즉시 반영하고 서버에 영속화한다.
  async function changeChatViewMode(chatViewMode: "chat" | "terminal"): Promise<void> {
    const previous = userRef.current?.chat_view_mode === "terminal" ? "terminal" : "chat";
    setUser((current) => current ? { ...current, chat_view_mode: chatViewMode } : current);
    try {
      const data = await api("/auth/chat-view-mode", { method: "PUT", body: JSON.stringify({ chatViewMode }) });
      setUser((current) => current ? { ...current, chat_view_mode: data.chatViewMode } : current);
    } catch (error) {
      setUser((current) => current?.chat_view_mode === chatViewMode ? { ...current, chat_view_mode: previous } : current);
      throw error;
    }
  }
  // 채팅 선택은 URL과 계정별 마지막 세션 저장을 함께 처리한다.
  function selectChat(next: Json | null): void {
    logChatTrace("selectChat:user", { previousChatId: chatRef.current?.id ?? null, nextChatId: next?.id ?? null, projectId: next?.project_id ?? projectRef.current?.id ?? null });
    selectionVersionRef.current += 1;
    chatListRequestRef.current += 1;
    chatRef.current = next;
    setChat(next);
    setMessages([]);
    setHasMoreMessages(false);
    setPendingChatTarget(null);
    tabRef.current = "chat";
    setTab("chat");
    syncNavigation("push", {
      tab: "chat",
      chatId: next?.id ?? null,
      projectId: next?.project_id ?? projectRef.current?.id ?? null,
      filePath: null,
    });
    if (next) rememberLastSession(next.project_id ?? projectRef.current?.id, next.id);
  }
  // 프로젝트 선택은 계정별 마지막 프로젝트 저장을 함께 처리한다.
  function selectProject(next: Json | null): void {
    logChatTrace("selectProject:user", { previousProjectId: projectRef.current?.id ?? null, nextProjectId: next?.id ?? null, currentChatId: chatRef.current?.id ?? null });
    selectionVersionRef.current += 1;
    projectSwitchRef.current += 1;
    chatListRequestRef.current += 1;
    projectRef.current = next;
    chatRef.current = null;
    setProject(next);
    setChat(null);
    setChats([]);
    setMessages([]);
    setHasMoreMessages(false);
    setPendingChatTarget(null);
    syncNavigation("push", { chatId: null, projectId: next?.id ?? null, filePath: tabRef.current === "files" ? "" : null });
    if (next) rememberLastSession(next.id, null);
  }
  // chats/chat 상태의 한 항목만 낙관적으로(서버 응답을 기다리지 않고) 갱신한다. chat_busy 웹소켓
  // 이벤트 처리와 send()의 즉시 표시 양쪽에서 같이 쓴다.
  function patchChatBusy(chatId: number, busy: boolean): void {
    const patch = (item: Json): Json => item.id === chatId ? { ...item, busy: busy ? 1 : 0 } : item;
    setChats((items: Json[]) => items.map(patch));
    setChat((currentChat: Json | null) => currentChat ? patch(currentChat) : currentChat);
  }
  // history_updated는 웹소켓 연결 수립 시점의 클로저에 갇히므로 ref로 현재 선택된 채팅을 참조한다.
  // 모바일 브라우저는 탭이 백그라운드로 가면 소켓을 끊어버리고 복귀해도 알아서 재연결하지 않는 경우가
  // 많아, 그 상태로는 새로고침 전까지 어떤 실시간 갱신도 받지 못했다. 연결이 끊기면 자동 재연결하고,
  // 앱이 다시 화면에 보이는 시점(visibilitychange)에는 그 사이 놓쳤을 이벤트를 보완하기 위해 무조건
  // 최신 상태를 한 번 다시 불러오며, 소켓이 끊긴 상태였다면 재연결 대기 없이 즉시 다시 연결한다.
  useEffect(() => {
    if (!user) return;
    void loadCore().catch((caught) => setError(caught.message));
    let closedByCleanup = false;
    // handleVisibility가 좀비 소켓을 갈아끼우려고 일부러 닫을 때 그 close 이벤트까지 "예기치 않은
    // 끊김"으로 오인해 2초 뒤 중복 재연결을 걸지 않도록 구분하는 플래그.
    let intentionalReplace = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let current: WebSocket | null = null;

    function connect(): void {
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      current = ws;
      // 끊겼다 자동 재연결된 경우(서버 재시작 등) 그 사이 놓친 이벤트(예: 작업 완료로 busy가 풀린 것)가
      // 있을 수 있어, 연결이 열릴 때마다 항상 최신 상태로 다시 맞춘다. 최초 연결도 겸사겸사 한 번 더
      // 맞춰주는 정도라 비용은 무시할 만하다.
      ws.onopen = () => { setSocket(ws); void refetchChats().catch(() => undefined); void refetchCurrentMessages().catch(() => undefined); };
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        // TODO(임시 상세 로그): 웹소켓 수신 원본 전체 기록. 문제가 안정화되면 제거하거나 레벨을 낮춘다.
        console.debug("[web-agent-manager:ws]", "recv", typeof event.data === "string" && event.data.length > 1500 ? `${event.data.slice(0, 1500)}…` : event.data);
        if (["history_updated", "chat_status", "chat_model", "chat_title", "chat_permission_mode", "chat_busy", "approval_requested", "approval_resolved"].includes(message.type)) {
          logChatTrace("ws:event", { type: message.type, payloadChatId: message.payload?.chatId ?? null, currentChatId: chatRef.current?.id ?? null, targetChatId: targetChatIdRef.current });
        }
        if (message.type === "system_metrics") setSystem((currentSystem: Json) => ({ ...currentSystem, latest: message.payload }));
        if (message.type === "history_updated" && message.payload?.chatId === chatRef.current?.id) void refetchCurrentMessages();
        if (message.type === "history_updated") void refetchChats();
        // chat_status는 usage/approvals 배열 길이와 무관하게 오므로, 상태를 직접 반영해 재개 진행 상황이 화면에 즉시 보이게 한다.
        if (message.type === "chat_status" && Number.isInteger(message.payload?.chatId)) {
          const patch = (item: Json): Json => item.id === message.payload.chatId ? { ...item, status: message.payload.status, last_error: message.payload.error } : item;
          setChats((items: Json[]) => items.map(patch));
          setChat((currentChat: Json | null) => currentChat ? patch(currentChat) : currentChat);
        }
        if (message.type === "chat_model" && Number.isInteger(message.payload?.chatId)) {
          const patch = (item: Json): Json => item.id === message.payload.chatId ? { ...item, model: message.payload.model } : item;
          setChats((items: Json[]) => items.map(patch));
          setChat((currentChat: Json | null) => currentChat ? patch(currentChat) : currentChat);
        }
        // /rename을 보낸 탭이 아닌 다른 탭·기기에서도 새 이름이 바로 반영되게 한다.
        if (message.type === "chat_title" && Number.isInteger(message.payload?.chatId)) {
          const patch = (item: Json): Json => item.id === message.payload.chatId ? { ...item, title: message.payload.title } : item;
          setChats((items: Json[]) => items.map(patch));
          setChat((currentChat: Json | null) => currentChat ? patch(currentChat) : currentChat);
        }
        // Claude 하단 상태줄에서 감지한 현재 권한 모드(auto/manual/accept edits/plan)를 그대로 반영한다.
        if (message.type === "chat_permission_mode" && Number.isInteger(message.payload?.chatId)) {
          const patch = (item: Json): Json => item.id === message.payload.chatId ? { ...item, permission_mode: message.payload.mode } : item;
          setChats((items: Json[]) => items.map(patch));
          setChat((currentChat: Json | null) => currentChat ? patch(currentChat) : currentChat);
        }
        // busy는 서버 DB에 영속화된 값을 그대로 반영만 한다(core/chat-busy.ts) — 별도 클라이언트 상태로
        // 추측하지 않으므로, 이 이벤트를 놓쳐도 다음 refetchChats()(재연결·재방문 시)가 항상 정확한
        // 현재 값으로 재동기화해준다.
        if (message.type === "chat_busy" && Number.isInteger(message.payload?.chatId)) patchChatBusy(message.payload.chatId, !!message.payload.busy);
        // task_completed는 실제 응답 완료에만 뜨는 별도 이벤트라(도구 호출 중간 턴 등은 제외) 그대로
        // 알림 트리거로 쓴다. rate_limit_reset은 계정 단위라 어느 채팅인지 특정하지 않는다.
        if (message.type === "task_completed") showNotification("작업이 완료됐습니다", message.payload?.title || "채팅을 확인해보세요.");
        if (message.type === "rate_limit_reset") showNotification("사용량 한도가 초기화됐습니다", "대기 중이던 작업을 이어갑니다.");
        if (message.type === "usage_session_reset") showNotification(`${message.payload?.windowLabel || "세션"} 사용량이 초기화됐습니다`, `${message.payload?.label || message.payload?.provider || "AI"} 사용량을 확인해보세요.`);
        if (["usage_updated", "history_updated", "chat_status", "approval_requested", "approval_resolved"].includes(message.type)) void loadCore();
      };
      ws.onclose = () => {
        setSocket((currentSocket) => (currentSocket === ws ? null : currentSocket));
        if (closedByCleanup) return;
        if (intentionalReplace) { intentionalReplace = false; return; }
        reconnectTimer = setTimeout(connect, 2000);
      };
    }
    connect();

    function handleVisibility(): void {
      if (document.visibilityState !== "visible") return;
      void loadCore().catch(() => undefined);
      void refetchCurrentMessages().catch(() => undefined);
      // 백그라운드로 가 있던 사이 chat_busy 이벤트를 놓쳤을 수 있어, 항상 정확한 현재 값으로 다시 맞춘다.
      void refetchChats().catch(() => undefined);
      // readyState가 OPEN이어도 실제로는 죽어있는("좀비") 소켓일 수 있다 — 모바일에서 앱이 백그라운드로
      // 가면 브라우저가 close 이벤트 없이 연결을 조용히 끊어버리는 경우가 많은데, 그럴 때 readyState는
      // 계속 OPEN으로 남아 재연결 조건에 안 걸린다. 그 상태로는 포그라운드 복귀 시점의 REST 재조회
      // 이후로는 응답이 끝나도 다시는 실시간 갱신을 못 받는다(새로고침 전까지). readyState를 신뢰하지
      // 않고 화면이 보일 때마다 무조건 새로 연결한다 — 기존 연결이 실제로 살아있었더라도 재연결 자체는
      // 가벼운 비용이라 문제 없다.
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (current) { intentionalReplace = true; current.close(); }
      connect();
    }
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      closedByCleanup = true;
      document.removeEventListener("visibilitychange", handleVisibility);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      current?.close();
    };
  }, [user?.id]);
  useEffect(() => { if (!project) { setChats([]); return; } void refetchChats(); }, [project?.id, usage.length, approvals.length]);
  useEffect(() => {
    function handlePopState(): void {
      const navigation = navigationFromLocation();
      const nextChatId = navigation.chatId;
      const selectionVersion = ++selectionVersionRef.current;
      chatListRequestRef.current += 1;
      tabRef.current = navigation.tab;
      setTab(navigation.tab);
      if (navigation.tab === "files" && navigation.projectId) {
        const nextTarget = { projectId: navigation.projectId, path: navigation.filePath ?? "", requestId: Date.now() };
        fileTargetRef.current = nextTarget;
        setFileTarget(nextTarget);
      } else {
        fileTargetRef.current = null;
        setFileTarget(null);
      }
      if (chatRef.current?.id !== nextChatId) {
        chatRef.current = null;
        setChat(null);
        setMessages([]);
        setHasMoreMessages(false);
      }
      setPendingChatTarget(nextChatId);
      if (navigation.projectId && projectRef.current?.id !== navigation.projectId) {
        const nextProject = projects.find((item: Json) => item.id === navigation.projectId) || null;
        if (nextProject) {
          projectRef.current = nextProject;
          setProject(nextProject);
        }
      }
      if (nextChatId) {
        const knownChat = chats.find((item: Json) => item.id === nextChatId);
        if (knownChat) {
          chatRef.current = knownChat;
          setChat(knownChat);
          setPendingChatTarget(null);
          return;
        }
        void api(`/chats/${nextChatId}`).then((data) => {
          if (selectionVersionRef.current !== selectionVersion || targetChatIdRef.current !== nextChatId) return;
          const nextProject = projects.find((item: Json) => item.id === data.chat.project_id);
          if (nextProject) {
            projectRef.current = nextProject;
            setProject(nextProject);
          }
          chatRef.current = data.chat;
          setChat(data.chat);
          setPendingChatTarget(null);
        }).catch(() => undefined);
      } else if (navigation.tab === "chat") {
        setChats([]);
      }
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [projects, chats]);
  async function loadSessionBackups(projectId = project?.id): Promise<void> {
    if (!projectId) { setSessionBackups([]); return; }
    const data = await api(`/projects/${projectId}/session-backups`);
    setSessionBackups(data.backups || []);
  }
  useEffect(() => { void loadSessionBackups(); }, [project?.id]);
  useEffect(() => {
    if (!chat) {
      setMessages([]);
      setHasMoreMessages(false);
      return;
    }
    const requestChatId = chat.id;
    const selectionVersion = selectionVersionRef.current;
    let active = true;
    void api(`/chats/${requestChatId}/messages`).then((data) => {
      if (!active || chatRef.current?.id !== requestChatId || selectionVersionRef.current !== selectionVersion) return;
      setMessages(data.messages);
      setHasMoreMessages(data.hasMore);
    });
    return () => { active = false; };
  }, [chat?.id]);
  // 대화창을 위로 스크롤했을 때 이전 구간을 커서 기반으로 더 불러와 앞에 붙인다.
  // 도구 실행 로그가 많은 세션은 메시지 하나하나가 커서 화면에 몇 개 안 보이고 금세 맨 위 근처로
  // 판정되므로, 기본 60개씩이면 왕복이 여러 번 이어져 버벅이는 느낌을 준다. 서버 최대치(200)까지 요청한다.
  async function loadMoreMessages(): Promise<number> {
    if (!chat || !messages.length) return 0;
    const requestChatId = chat.id;
    const selectionVersion = selectionVersionRef.current;
    const data = await api(`/chats/${requestChatId}/messages?before=${encodeURIComponent(messages[0].id)}&limit=200`);
    if (chatRef.current?.id !== requestChatId || selectionVersionRef.current !== selectionVersion) return 0;
    setHasMoreMessages(data.hasMore);
    const merged = mergeMessages(data.messages, messages);
    const added = merged.length - messages.length;
    setMessages(merged);
    return added;
  }
  const activeChats = useMemo(() => chats.filter((item) => ["running", "starting", "resuming"].includes(item.status)).length, [chats]);
  // accountId를 주면 그 인증 계정으로 채팅을 만든다(생략하면 공급자의 기본 계정).
  async function createChat(provider: string, accountId?: number | null): Promise<void> { if (!project) return; const data = await api("/chats", { method: "POST", body: JSON.stringify({ projectId: project.id, provider, accountId: accountId ?? null }) }); setChats((items) => [data.chat, ...items]); selectChat(data.chat); }
  // 실제 응답 도착은 history_updated 웹소켓 알림으로 반영되므로 여기서는 전송만 담당한다.
  // JSONL에 실제로 기록되기까지는 시간차가 있어, 보내는 즉시 화면에 사용자 메시지를 먼저 띄워두고
  // history_updated가 오면(위 핸들러에서) 실제 메시지로 교체되며 사라진다. 전송 자체가 실패하면 바로 걷어낸다.
  async function send(text: string): Promise<void> {
    if (!chat) return;
    const chatId = chat.id;
    // 이전에 위로 스크롤해둔 채였더라도, 사용자가 직접 보낸 메시지는 항상 맨 아래로 따라가 보여준다.
    chatScrollStateRef.current.userScrolled = false;
    const optimisticMessage: Json = { id: `optimistic:${Date.now()}:${Math.random().toString(36).slice(2)}`, role: "user", kind: "text", content: text, createdAt: new Date().toISOString(), optimistic: true };
    setMessages((current: Json[]) => [...current, optimisticMessage]);
    patchChatBusy(chatId, true);
    logChatTrace("send:start", { chatId, textLength: text.length, selectedChatId: chatRef.current?.id ?? null });
    try {
      await api(`/chats/${chatId}/messages`, { method: "POST", body: JSON.stringify({ text }) });
      logChatTrace("send:accepted", { chatId });
    } catch (error) {
      setMessages((current: Json[]) => current.filter((item) => item.id !== optimisticMessage.id));
      patchChatBusy(chatId, false);
      logChatTrace("send:error", { chatId, message: error instanceof Error ? error.message : "전송 실패" });
      throw error;
    }
  }
  async function backupChat(id: number): Promise<void> { await api(`/chats/${id}/backup`, { method: "POST" }); await loadSessionBackups(); }
  // 선택한 채팅을 삭제하고, 필요하면 삭제 전에 서버에서 백업을 생성한다.
  async function deleteChat(id: number, backup = true): Promise<Json> {
    const result = await api(`/chats/${id}${backup ? "" : "?backup=0"}`, { method: "DELETE" });
    setChats((items: Json[]) => {
      const next = items.filter((item) => item.id !== id);
      setChat((current) => {
        const replacement = current?.id === id ? next[0] || null : current;
        if (current?.id === id) syncNavigation("replace", { chatId: replacement?.id ?? null });
        return replacement;
      });
      return next;
    });
    if (chat?.id === id) { setMessages([]); setHasMoreMessages(false); }
    await loadSessionBackups();
    return result;
  }
  async function restoreBackup(id: string): Promise<void> {
    const data = await api(`/session-backups/${id}/restore`, { method: "POST" });
    const restored = data.chat;
    setChats((items: Json[]) => [restored, ...items.filter((item) => item.id !== restored.id)]);
    selectChat(restored);
    await loadSessionBackups(restored.project_id || project?.id);
  }
  // 백업 사본(JSONL·메타데이터)만 지운다 — 원본 채팅·공급자 기록은 그대로 둔다.
  async function deleteBackup(id: string): Promise<void> {
    await api(`/session-backups/${id}`, { method: "DELETE" });
    await loadSessionBackups();
  }
  async function stop(id: number): Promise<void> { await api(`/chats/${id}/stop`, { method: "POST" }); await loadCore(); }
  // 진행 중인 응답을 ESC로 중단한다. 서버가 잠시 후 터미널 상태를 다시 확인해 chat_busy를 정리해 알려준다.
  async function interrupt(id: number): Promise<void> { await api(`/chats/${id}/interrupt`, { method: "POST" }); }
  // Shift+Tab을 보내 Claude Code CLI의 기본·auto-accept edits·plan mode를 순환 전환한다.
  async function cycleMode(id: number): Promise<void> { await api(`/chats/${id}/mode-cycle`, { method: "POST" }); }
  // 종료된 채팅을 웹에서 다시 시작한다. chat_status 웹소켓 알림이 실제 진행 상태를 반영한다.
  async function startChat(id: number): Promise<void> { await api(`/chats/${id}/start`, { method: "POST" }); }
  async function decide(id: string, decision: string, answer?: string): Promise<void> { await api(`/approvals/${id}/decision`, { method: "POST", body: JSON.stringify({ decision, answer }) }); await loadCore(); }
  // 실제 클릭(사용자 제스처) 안에서 호출해야 브라우저가 권한 팝업을 띄워준다.
  async function enableNotifications(): Promise<void> { setNotifPermission(await requestNotificationPermission()); }
  // 로컬 경로와 GitHub 저장소를 선택할 수 있는 프로젝트 생성 화면을 연다.
  function addProject(): void { setShowProjectDialog(true); }
  // 생성·재활성화한 프로젝트를 최신 목록에서 선택하고 채팅 탭으로 이동한다.
  async function openProject(target: Json): Promise<void> {
    const data = await api("/projects");
    const nextProjects = data.projects || [];
    const next = nextProjects.find((item: Json) => item.id === target.id) || target;
    setProjects(nextProjects.some((item: Json) => item.id === next.id) ? nextProjects : [next, ...nextProjects]);
    tabRef.current = "chat";
    setTab("chat");
    selectProject(next);
  }
  // 채팅의 프로젝트 파일 링크를 파일 탭의 정확한 경로 탐색 요청으로 변환한다.
  function openProjectFile(path: string): void {
    if (!project) return;
    const nextTarget = { projectId: project.id, path, requestId: Date.now() };
    fileTargetRef.current = nextTarget;
    setFileTarget(nextTarget);
    tabRef.current = "files";
    setTab("files");
    syncNavigation("push", { tab: "files", projectId: project.id, filePath: path });
  }
  // 파일 탭 안의 폴더·미리보기 이동도 브라우저 뒤로가기로 복원되도록 기록한다.
  function navigateFile(path: string): void {
    if (!project) return;
    const nextTarget = { projectId: project.id, path, requestId: Date.now() };
    fileTargetRef.current = nextTarget;
    syncNavigation("push", { tab: "files", projectId: project.id, filePath: path });
  }
  // 실제로 지우지 않고 목록에서만 숨긴다(서버가 active=0으로 표시, 채팅 기록은 보존).
  async function deleteProject(target: Json): Promise<void> {
    const message = target.chat_count > 0 ? `"${target.name}" 프로젝트를 목록에서 삭제할까요? 채팅 ${target.chat_count}개는 삭제되지 않고 보존됩니다.` : `"${target.name}" 프로젝트를 목록에서 삭제할까요?`;
    if (!window.confirm(message)) return;
    await api(`/projects/${target.id}`, { method: "DELETE" });
    if (project?.id === target.id) selectProject(null);
    await loadCore();
  }
  if (loading) return <div className="splash">web-agent-manager</div>;
  if (!user) return <Login onLogin={(data) => { setCsrfToken(data.csrfToken); setUser(data.user); }} />;
  return <div className={`app-shell tab-${tab}`}><header><div className="brand"><span>W</span><div><b>web-agent-manager</b><small>Agent workspace</small></div></div><nav>{TABS.map((item) => <button key={item} className={tab === item ? "active" : ""} onClick={() => selectTab(item)}>{React.createElement(TAB_ICONS[item], { size: 16, "aria-hidden": true })}<span>{TAB_LABELS[item]}</span></button>)}</nav><div className="header-meta"><span className="live"><i />{activeChats} 실행 중</span>{typeof Notification !== "undefined" && notifPermission !== "granted" && <button type="button" className="notif-toggle" disabled={notifPermission === "denied"} title={notifPermission === "denied" ? "브라우저 설정에서 알림을 허용해야 합니다." : "작업 완료·사용량 한도 초기화 시 브라우저 알림을 받습니다."} onClick={() => void enableNotifications()}>🔔 알림 켜기</button>}{user.role === "admin" && <button type="button" className="header-icon-button" title="CLI 인증 관리" aria-label="CLI 인증 관리" onClick={() => setShowCliAuth(true)}><KeyRound size={16} /></button>}<span className="header-user">{user.username}</span></div></header>
    <div className="project-bar"><span className="project-bar-label">작업 프로젝트</span><select aria-label="작업 프로젝트" value={project?.id || ""} onChange={(event) => selectProject(projects.find((item) => item.id === Number(event.target.value)) || null)}><option value="">프로젝트 없음</option>{projects.map((item) => <option value={item.id} key={item.id}>{item.name} · {shortProjectPath(item.path, defaultProjectPath)}</option>)}</select><button className="project-add" aria-label="프로젝트" onClick={addProject}><FolderPlus size={16} /><span>프로젝트 추가</span></button>{project && <button type="button" className="project-delete" title="목록에서 프로젝트 삭제" aria-label="목록에서 프로젝트 삭제" onClick={() => void deleteProject(project)}><Trash2 size={16} /></button>}</div>
    <AgentIntegrationNotice user={user} />
    {error && <div className="global-error" onClick={() => setError("")}>{error}</div>}
    <main className={`main${tab === "chat" ? " main-chat" : ""}`}>{tab === "overview" && <Overview user={user} providers={providers} usage={usage} system={system} runtime={runtime} slack={slack} ntfy={ntfy} refresh={loadCore} />}{tab === "chat" && <ChatView user={user} chatViewMode={user.chat_view_mode === "terminal" ? "terminal" : "chat"} changeChatViewMode={changeChatViewMode} providers={providers} accounts={accounts} project={project} projects={projects} setProject={selectProject} addProject={addProject} deleteProject={deleteProject} chats={chats} selectedChat={chat} setSelectedChat={selectChat} refreshChats={refetchChats} createChat={createChat} send={send} stop={stop} interrupt={interrupt} cycleMode={cycleMode} startChat={startChat} messages={messages} hasMoreMessages={hasMoreMessages} loadMoreMessages={loadMoreMessages} usage={usage} busy={!!chat?.busy} socket={socket} approvals={approvals} decide={decide} scrollState={chatScrollStateRef.current} sessionBackups={sessionBackups} backupChat={backupChat} deleteChat={deleteChat} restoreBackup={restoreBackup} deleteBackup={deleteBackup} onOpenProjectFile={openProjectFile} />}{tab === "files" && <FilesView project={project} chat={chat} target={fileTarget} onNavigate={navigateFile} />}{tab === "instructions" && <InstructionsView project={project} chat={chat} />}{tab === "git" && <GitView project={project} user={user} chat={chat} providers={providers} refreshChats={refetchChats} onOpenProject={(next) => void openProject(next)} onOpenChat={(next) => { selectChat(next); setTab("chat"); }} />}{tab === "tools" && <ToolsView project={project} />}</main>
    <ProjectDialog open={showProjectDialog} defaultPath={defaultProjectPath} onClose={() => setShowProjectDialog(false)} onProject={(next) => void openProject(next)} />
    <CliAuthPanel open={showCliAuth} user={user} socket={socket} onClose={() => setShowCliAuth(false)} onRequireOpen={() => setShowCliAuth(true)} onPendingChange={setCliAuthPending} />
    {/* 데스크톱 상단 header/nav는 모바일에서 전부 display:none이라, 채팅 탭 말고는 갈 방법이 없었다.
        모바일 전용 하단 탭바를 따로 둔다(styles.css에서 데스크톱은 숨기고 모바일에서만 보여줌). */}
    <nav className={`mobile-tabbar${cliAuthPending ? " has-auth" : ""}`} aria-label="탭 전환">{TABS.map((item) => <button key={item} className={tab === item ? "active" : ""} onClick={() => selectTab(item)}>{React.createElement(TAB_ICONS[item], { size: 18, "aria-hidden": true })}<span>{TAB_LABELS[item]}</span></button>)}{user.role === "admin" && cliAuthPending && <button type="button" className="mobile-auth-button" title="CLI 인증 관리" aria-label="CLI 인증 관리" onClick={() => setShowCliAuth(true)}><KeyRound size={16} aria-hidden="true" /><span>인증</span></button>}</nav>
  </div>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
