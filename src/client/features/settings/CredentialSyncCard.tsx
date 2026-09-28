import React, { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import type { ConnectedComputer } from "../federation/FederationSettingsCard";
import { AuthTerminal } from "../terminal/AuthTerminal";
import { createWebSocketConnectionManager } from "../../lib/websocket-connection-manager";
import "./provider-settings-card.css";

type Provider = "github" | "codex" | "claude" | "grok";
interface AuthStatus { provider: Provider; accountId: number | null; key: string; installed: boolean; authenticated: boolean; running: boolean }

const ROWS: Array<{ provider: Provider; label: string; copyable: boolean; note: string }> = [
  { provider: "github", label: "GitHub (gh)", copyable: true, note: "토큰이 자동 교체되지 않아 복사해도 안전합니다." },
  { provider: "codex", label: "Codex", copyable: true, note: "Codex 공식 안내대로 auth.json을 복사합니다." },
  { provider: "claude", label: "Claude", copyable: false, note: "토큰이 갱신 때 교체될 수 있어 복사하지 않습니다. 원격 로그인으로 대상 컴퓨터가 자기 토큰을 갖게 합니다." },
  { provider: "grok", label: "Grok", copyable: false, note: "원격 로그인만 지원합니다." },
];

// 기본 계정 상태만 본다. 추가 계정 슬롯은 각 컴퓨터의 CLI 계정 화면에서 관리한다.
function defaultStatus(list: AuthStatus[] | undefined, provider: Provider): AuthStatus | undefined {
  return list?.find((item) => item.provider === provider && item.accountId == null);
}

function statusLabel(status: AuthStatus | undefined): { text: string; ready: boolean } {
  if (!status) return { text: "확인 불가", ready: false };
  if (!status.installed) return { text: "CLI 없음", ready: false };
  return status.authenticated ? { text: "로그인됨", ready: true } : { text: "로그인 필요", ready: false };
}

// gh·Codex 인증을 연결 컴퓨터에 복사하고, Claude 등은 대상 컴퓨터의 로그인 터미널을 원격으로 띄우는 카드(#138).
export function CredentialSyncCard({ nodes }: { nodes: ConnectedComputer[] }): React.ReactElement {
  const [nodeId, setNodeId] = useState(nodes[0]?.id ?? "");
  const [local, setLocal] = useState<AuthStatus[]>();
  const [remote, setRemote] = useState<AuthStatus[]>();
  const [remoteError, setRemoteError] = useState("");
  const [loginProvider, setLoginProvider] = useState<Provider | null>(null);
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const nodeName = nodes.find((node) => node.id === nodeId)?.name ?? "대상 컴퓨터";

  useEffect(() => { if (!nodes.some((node) => node.id === nodeId)) setNodeId(nodes[0]?.id ?? ""); }, [nodes, nodeId]);
  const load = useCallback(async (): Promise<void> => {
    void api("/cli-auth").then((data) => setLocal(data?.providers)).catch(() => setLocal(undefined));
    if (!nodeId) return;
    try {
      const data = await api(`/federation/nodes/${encodeURIComponent(nodeId)}/api/cli-auth`);
      if (!Array.isArray(data?.providers)) throw new Error("인증 동기화를 지원하지 않는 WAM 버전입니다.");
      setRemote(data.providers); setRemoteError("");
    } catch (error: any) { setRemote(undefined); setRemoteError(error?.message || "대상 컴퓨터의 로그인 상태를 불러오지 못했습니다."); }
  }, [nodeId]);
  useEffect(() => { setLoginProvider(null); void load(); }, [load]);

  // 원격 로그인 중에만 대상 컴퓨터의 실시간 연결을 이 WAM을 거쳐 연다. 로그인이 끝나면 상태를 다시 읽는다.
  useEffect(() => {
    if (!loginProvider || !nodeId) return;
    const manager = createWebSocketConnectionManager({
      createSocket: () => new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?node=${encodeURIComponent(nodeId)}`),
      connectTimeoutMs: 15_000,
      reconnectDelayMs: 2_000,
      onOpen: (current) => setSocket(current as WebSocket),
      onSocketCleared: () => setSocket(null),
      onUnexpectedClose: (scheduleReconnect) => scheduleReconnect(),
      onMessage: (current, event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === "ping") (current as WebSocket).send(JSON.stringify({ type: "pong" }));
          if (message.type === "cli_auth_changed") void load();
        } catch { /* 터미널 데이터는 AuthTerminal이 따로 받는다. */ }
      },
    });
    manager.connect();
    return () => { manager.dispose(); setSocket(null); };
  }, [loginProvider, nodeId, load]);

  async function copy(provider: Provider, label: string): Promise<void> {
    if (!window.confirm(`이 WAM의 ${label} 로그인 정보를 ${nodeName}에 복사할까요?\n${nodeName}의 기존 로그인 파일은 백업된 뒤 교체됩니다. 로그인 값은 화면이나 기록에 표시되지 않습니다.`)) return;
    setBusy(true); setStatus("");
    try {
      const data = await api(`/federation/nodes/${encodeURIComponent(nodeId)}/credentials/${provider}/sync`, { method: "POST" });
      await load();
      setStatus(`${nodeName}에 ${label} 로그인 정보를 복사했습니다.${data.backedUp ? " 기존 파일은 백업했습니다." : ""}`);
    } catch (error: any) { setStatus(error?.message || "복사하지 못했습니다."); }
    finally { setBusy(false); }
  }

  async function remoteLogin(provider: Provider): Promise<void> {
    setBusy(true); setStatus("");
    try {
      await api(`/federation/nodes/${encodeURIComponent(nodeId)}/api/cli-auth/${provider}/start`, { method: "POST", body: JSON.stringify({ accountId: null }) });
      setLoginProvider(provider);
      await load();
    } catch (error: any) { setStatus(error?.message || "원격 로그인을 시작하지 못했습니다."); }
    finally { setBusy(false); }
  }

  async function stopLogin(): Promise<void> {
    if (!loginProvider) return;
    // 진행 중인 로그인을 끊는 동작이라 실행 중이면 한 번 더 확인한다.
    if (defaultStatus(remote, loginProvider)?.running && !window.confirm("진행 중인 원격 로그인을 중단할까요?")) return;
    await api(`/federation/nodes/${encodeURIComponent(nodeId)}/api/cli-auth/${loginProvider}/stop`, { method: "POST", body: JSON.stringify({ accountId: null }) }).catch(() => undefined);
    setLoginProvider(null);
    void load();
  }

  return <article className="card provider-settings-card credential-sync-card">
    <div className="card-top"><span>인증 동기화</span></div>
    <p className="muted">연결 컴퓨터의 CLI 로그인을 맞춥니다. 로그인 값은 WAM 서버끼리만 전달되고 화면·기록에 남지 않습니다. 기본 계정만 대상이며, 추가 계정 슬롯은 각 컴퓨터에서 로그인하세요.</p>
    {nodes.length > 0 && !/^https:|\/\/100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(nodes.find((node) => node.id === nodeId)?.base_url ?? "https:") && <p className="project-transfer-warning credential-sync-http">⚠ {nodeName}은(는) 암호화되지 않은 HTTP 주소로 연결되어 있습니다. 신뢰할 수 있는 네트워크에서만 복사하세요.</p>}
    <div className="server-log-filters">
      <label>대상 컴퓨터<select value={nodeId} onChange={(event) => setNodeId(event.target.value)}>
        {nodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}
      </select></label>
      <div className="slack-settings-actions"><button type="button" disabled={busy} onClick={() => void load()}>상태 새로고침</button></div>
    </div>
    {remoteError && <p className="server-log-status" role="alert">{remoteError}</p>}
    <div className="provider-settings-backups">
      {ROWS.map((row) => {
        const mine = statusLabel(defaultStatus(local, row.provider));
        const theirs = statusLabel(defaultStatus(remote, row.provider));
        return <div className="session-security-row" key={row.provider}>
          <span><strong>{row.label}</strong><small>이 WAM: <b className={mine.ready ? "credential-ready" : ""}>{mine.text}</b> · {nodeName}: <b className={theirs.ready ? "credential-ready" : ""}>{theirs.text}</b></small><small>{row.note}</small></span>
          <span className="provider-settings-row-actions">
            {row.copyable && <button type="button" disabled={busy || !mine.ready || !remote} onClick={() => void copy(row.provider, row.label)}>복사해서 보내기</button>}
            <button type="button" disabled={busy || !remote || loginProvider !== null} onClick={() => void remoteLogin(row.provider)}>원격 로그인</button>
          </span>
        </div>;
      })}
    </div>
    {loginProvider && <div className="provider-settings-backups credential-remote-login">
      <strong>{nodeName}에서 {ROWS.find((row) => row.provider === loginProvider)?.label} 로그인 중 — 아래 안내대로 진행하세요</strong>
      <AuthTerminal provider={defaultStatus(remote, loginProvider)?.key ?? loginProvider} socket={socket} />
      <div className="slack-settings-actions"><button type="button" onClick={() => void stopLogin()}>{defaultStatus(remote, loginProvider)?.running ? "로그인 중단" : "로그인 터미널 닫기"}</button></div>
    </div>}
    {status && <p className="attachment-status provider-settings-status" aria-live="polite">{status}</p>}
  </article>;
}
