import React, { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { createClientUuid } from "../../lib/client-uuid";
import { createWebSocketConnectionManager } from "../../lib/websocket-connection-manager";
import { formatUsageResetAt, usageWindows } from "../../lib/format";
import { splitMessageContent } from "../../message-display";
import { chatActivity } from "../../lib/approvals";
import { ApprovalCard } from "../../components/ApprovalCard";
import { TerminalPanel } from "../terminal/TerminalPanel";
import { MessageCard } from "../chat/ChatView";
import type { Json } from "../../types";
import type { ConnectedComputer } from "./FederationSettingsCard";

export function ConnectedComputersView({ nodes }: { nodes: ConnectedComputer[] }): React.ReactElement {
  const [nodeId, setNodeId] = useState(nodes[0]?.id ?? "");
  const [projects, setProjects] = useState<Json[]>([]);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [chats, setChats] = useState<Json[]>([]);
  const [chatId, setChatId] = useState<number | null>(null);
  const [messages, setMessages] = useState<Json[]>([]);
  const [approvals, setApprovals] = useState<Json[]>([]);
  const [usage, setUsage] = useState<Json[]>([]);
  const [providers, setProviders] = useState<Json[]>([]);
  const [provider, setProvider] = useState("codex");
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"chat" | "terminal">("chat");
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [online, setOnline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const nodeRef = useRef(nodeId);
  nodeRef.current = nodeId;
  const chatRef = useRef(chatId);
  chatRef.current = chatId;
  const request = (path: string, options?: RequestInit): Promise<any> => api(`/federation/nodes/${nodeRef.current}/api${path}`, options);
  const selectedChat = chats.find((item) => item.id === chatId) ?? null;
  const selectedProject = projects.find((item) => item.id === projectId) ?? null;

  async function refresh(node = nodeRef.current): Promise<void> {
    if (!node) return;
    const call = (path: string): Promise<any> => api(`/federation/nodes/${node}/api${path}`);
    const [projectData, approvalData, usageData, providerData] = await Promise.all([
      call("/projects"), call("/approvals"), call("/usage"), call("/providers"),
    ]);
    if (nodeRef.current !== node) return;
    setProjects(projectData.projects || []);
    setApprovals(approvalData.approvals || []);
    setUsage(usageData.usage || []);
    setProviders(providerData.providers || []);
    setOnline(true); setError("");
    setProjectId((current) => current && (projectData.projects || []).some((item: Json) => item.id === current)
      ? current : projectData.projects?.[0]?.id ?? null);
  }

  useEffect(() => {
    if (!nodes.some((item) => item.id === nodeId)) setNodeId(nodes[0]?.id ?? "");
  }, [nodes, nodeId]);

  useEffect(() => {
    setOnline(false); setProjects([]); setProjectId(null); setChats([]); setChatId(null); setMessages([]); setApprovals([]); setUsage([]);
    if (!nodeId) return;
    let cancelled = false;
    void refresh(nodeId).catch((caught) => { if (!cancelled) { setOnline(false); setError(caught?.message || "원격 WAM에 연결하지 못했습니다."); } });
    const timer = window.setInterval(() => {
      void refresh(nodeId).catch((caught) => { if (!cancelled) { setOnline(false); setError(caught?.message || "원격 WAM 연결이 끊겼습니다."); } });
    }, 30_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [nodeId]);

  useEffect(() => {
    if (!nodeId || !projectId) { setChats([]); return; }
    let cancelled = false;
    const load = (): void => {
      void api(`/federation/nodes/${nodeId}/api/chats?projectId=${projectId}`)
        .then((data) => { if (!cancelled) { setChats(data.chats || []); setChatId((current) => (data.chats || []).some((item: Json) => item.id === current) ? current : data.chats?.[0]?.id ?? null); } })
        .catch((caught) => { if (!cancelled) setError(caught?.message || "원격 채팅을 불러오지 못했습니다."); });
    };
    load();
    const timer = window.setInterval(load, 15_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [nodeId, projectId]);

  useEffect(() => {
    if (!nodeId || !chatId) { setMessages([]); return; }
    let cancelled = false;
    const load = (): void => {
      void api(`/federation/nodes/${nodeId}/api/chats/${chatId}/messages`)
        .then((data) => { if (!cancelled) setMessages(data.messages || []); })
        .catch((caught) => { if (!cancelled) setError(caught?.message || "메시지를 불러오지 못했습니다."); });
    };
    load();
    const timer = window.setInterval(load, 8_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [nodeId, chatId]);

  useEffect(() => {
    if (!nodeId) return;
    let lastMessageAt = Date.now();
    const manager = createWebSocketConnectionManager({
      createSocket: () => new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?node=${encodeURIComponent(nodeId)}`),
      connectTimeoutMs: 15_000,
      reconnectDelayMs: 2_000,
      onOpen: (current) => { lastMessageAt = Date.now(); setSocket(current as WebSocket); },
      onSocketCleared: () => setSocket(null),
      onUnexpectedClose: (scheduleReconnect) => scheduleReconnect(),
      onMessage: (current, event) => {
        lastMessageAt = Date.now();
        try {
          const message = JSON.parse(event.data);
          if (message.type === "ping") { (current as WebSocket).send(JSON.stringify({ type: "pong" })); return; }
          if (["approval_requested", "approval_resolved", "usage_updated", "chat_status"].includes(message.type)) void refresh(nodeId).catch(() => undefined);
          if (message.type === "history_updated" && message.payload?.chatId === chatRef.current) {
            void api(`/federation/nodes/${nodeId}/api/chats/${chatRef.current}/messages`).then((data) => setMessages(data.messages || [])).catch(() => undefined);
          }
        } catch { /* 터미널 데이터는 TerminalPanel도 독립적으로 수신한다. */ }
      },
    });
    const resume = (): void => {
      if (document.visibilityState !== "visible") return;
      manager.replace();
      void refresh(nodeId).catch(() => undefined);
    };
    const watchdog = window.setInterval(() => {
      if (document.visibilityState === "visible" && Date.now() - lastMessageAt > 70_000) {
        lastMessageAt = Date.now();
        manager.replace();
      }
    }, 10_000);
    document.addEventListener("visibilitychange", resume);
    manager.connect();
    return () => { document.removeEventListener("visibilitychange", resume); window.clearInterval(watchdog); manager.dispose(); setSocket(null); };
  }, [nodeId]);

  async function send(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!chatId || !text.trim()) return;
    const outgoing = text.trim(); setBusy(true); setError("");
    try {
      await request(`/chats/${chatId}/messages`, { method: "POST", body: JSON.stringify({ text: outgoing, idempotencyKey: createClientUuid() }) });
      setText("");
      const data = await request(`/chats/${chatId}/messages`);
      setMessages(data.messages || []);
    } catch (caught: any) { setError(caught?.message || "메시지를 보내지 못했습니다."); }
    finally { setBusy(false); }
  }

  async function createChat(): Promise<void> {
    if (!projectId) return;
    setBusy(true); setError("");
    try {
      const data = await request("/chats", { method: "POST", body: JSON.stringify({ projectId, provider, accountId: null }) });
      setChats((current) => [data.chat, ...current]); setChatId(data.chat.id);
    } catch (caught: any) { setError(caught?.message || "채팅을 만들지 못했습니다."); }
    finally { setBusy(false); }
  }

  async function decide(id: string, decision: string, answer?: string): Promise<void> {
    await request(`/approvals/${id}/decision`, { method: "POST", body: JSON.stringify({ decision, answer }) });
    const data = await request("/approvals");
    setApprovals(data.approvals || []);
  }

  const selectedNode = nodes.find((item) => item.id === nodeId);
  // 원격 /providers는 label을 준다(예전 응답 호환으로 name도 본다).
  const providerLabel = (id: string): string => { const found = providers.find((item) => item.id === id); return String(found?.label || found?.name || id); };
  // 메인 채팅과 같이 본문 없는 도구·시스템 기록은 빼고 보여준다(빈 칸으로 보이던 문제).
  const visibleMessages = messages.filter((item) => !!splitMessageContent(item).primary);
  const pendingApprovals = approvals.filter((item) => item.status === "pending" || !item.status);
  return <section className="content-grid federation-page">
    <div className="federation-head">
      <div className="federation-head-title"><span className="eyebrow">연결된 WAM</span><h2>컴퓨터 관리</h2></div>
      <div className="federation-toolbar">
        <select aria-label="컴퓨터" value={nodeId} onChange={(event) => setNodeId(event.target.value)}>{nodes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
        <span className={`settings-status ${online ? "ready" : ""}`}>{online ? "연결됨" : "연결 확인 중"}</span>
        {selectedNode && <small className="federation-node-url">{selectedNode.base_url}</small>}
        <button onClick={() => void refresh().catch((caught) => setError(caught?.message || "새로고침 실패"))}>새로고침</button>
      </div>
    </div>
    {error && <div className="global-error" role="alert">{error}</div>}
    {online && <div className="federation-layout">
      <aside className="card federation-sidebar">
        <select aria-label="프로젝트" value={projectId ?? ""} onChange={(event) => { setProjectId(Number(event.target.value)); setChatId(null); }}><option value="">프로젝트 없음</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
        <div className="federation-new-chat"><select aria-label="새 채팅 모델" value={provider} onChange={(event) => setProvider(event.target.value)}>{providers.map((item) => <option key={item.id} value={item.id}>{providerLabel(item.id)}</option>)}</select><button disabled={busy || !projectId} onClick={() => void createChat()}>새 채팅</button></div>
        <div className="federation-chat-list">{chats.length === 0 && <p className="muted">이 프로젝트에는 채팅이 없습니다.</p>}{chats.map((item) => { const activity = chatActivity(item, pendingApprovals); return <button type="button" key={item.id} className={`chat-item ${chatId === item.id ? "active" : ""}`} onClick={() => setChatId(item.id)}>
          <span className={`provider ${item.provider}`}>{providerLabel(item.provider)}</span>
          <strong title={item.title || undefined}>{item.title || "제목 없음"}</strong>
          <span className="chat-item-id"><span className="chat-id">#{item.id}</span></span>
          <small><span className={`activity-chip ${activity.className}`}>{activity.label}</span></small>
        </button>; })}</div>
      </aside>
      <div className="federation-main">
        {approvals.length > 0 && <div className="card"><strong>{selectedNode?.name} 권한 요청 ({approvals.length})</strong>{approvals.map((item) => <ApprovalCard key={item.id} item={item} decide={decide} />)}</div>}
        <div className="card federation-conversation"><div className="federation-conversation-head"><strong title={selectedChat?.title || undefined}>{selectedChat ? (selectedChat.title || "제목 없음") : "채팅을 선택하세요"}</strong>{selectedChat && <div className="federation-conversation-actions"><button className={mode === "chat" ? "primary" : ""} onClick={() => setMode("chat")}>채팅</button><button className={mode === "terminal" ? "primary" : ""} onClick={() => setMode("terminal")}>터미널</button><button disabled={busy} onClick={() => void request(`/chats/${chatId}/stop`, { method: "POST" }).then(() => refresh()).catch((caught) => setError(caught?.message || "중지 실패"))}>중지</button></div>}</div>
          {selectedChat && mode === "terminal" ? <div className="terminal-panel terminal-panel-full"><TerminalPanel chat={selectedChat} socket={socket} /></div> : <><div className="federation-messages">{selectedChat && visibleMessages.length === 0 && <p className="muted">표시할 메시지가 없습니다.</p>}{visibleMessages.map((item) => <MessageCard key={item.id} message={item} showDetails={false} />)}</div>{selectedChat && <form className="composer" onSubmit={(event) => void send(event)}><textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="원격 컴퓨터의 채팅에 메시지 보내기" /><button className="primary" disabled={busy || !text.trim()}>전송</button></form>}</>}
        </div>
        {usage.length > 0 && <div className="card federation-usage"><strong>{selectedNode?.name} 사용량</strong><div>{usage.map((item) => <div key={item.provider}><b>{providerLabel(item.provider)}</b>{usageWindows(item).map((window) => <span key={window.id}>{window.label || window.id} {window.usedPercent}%{window.resetAt ? ` · 초기화 ${formatUsageResetAt(window.resetAt)}` : ""}</span>)}</div>)}</div></div>}
      </div>
    </div>}
  </section>;
}
