import React, { useEffect, useState } from "react";
import { api } from "../../api";
import { copyText } from "../../lib/clipboard";

export interface ConnectedComputer {
  id: string;
  name: string;
  base_url: string;
  // 공급자 설정 동기화 모드(#136). 옛 서버 응답에는 없을 수 있다.
  settings_mode?: "follow" | "independent";
  created_at: string;
  updated_at: string;
}

export function FederationSettingsCard({ nodes, refresh }: { nodes: ConnectedComputer[]; refresh(): Promise<void> }): React.ReactElement {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [issuedToken, setIssuedToken] = useState("");
  const [tokens, setTokens] = useState<Array<{ id: string; created_at: string; revoked_at: string | null }>>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const loadTokens = (): void => { void api("/federation/agent-tokens").then((data) => setTokens(data.tokens || [])).catch(() => undefined); };
  useEffect(loadTokens, []);

  async function issueToken(): Promise<void> {
    setBusy(true); setStatus("");
    try {
      const data = await api("/federation/agent-tokens", { method: "POST" });
      setIssuedToken(data.token);
      loadTokens();
      setStatus("연결 토큰을 만들었습니다. 이 값은 다시 표시되지 않습니다.");
    } catch (error: any) { setStatus(error?.message || "토큰을 만들지 못했습니다."); }
    finally { setBusy(false); }
  }

  async function addNode(event: React.FormEvent): Promise<void> {
    event.preventDefault(); setBusy(true); setStatus("");
    try {
      await api("/federation/nodes", { method: "POST", body: JSON.stringify({ name, url, token }) });
      setName(""); setUrl(""); setToken("");
      await refresh();
      setStatus("컴퓨터를 연결했습니다.");
    } catch (error: any) { setStatus(error?.message || "컴퓨터를 연결하지 못했습니다."); }
    finally { setBusy(false); }
  }

  async function removeNode(node: ConnectedComputer): Promise<void> {
    if (!window.confirm(`${node.name} 연결을 해제할까요? 원격 WAM의 채팅과 파일은 삭제되지 않습니다.`)) return;
    setBusy(true);
    try { await api(`/federation/nodes/${node.id}`, { method: "DELETE" }); await refresh(); setStatus("연결만 해제했습니다."); }
    catch (error: any) { setStatus(error?.message || "연결 해제에 실패했습니다."); }
    finally { setBusy(false); }
  }

  async function revokeToken(id: string): Promise<void> {
    if (!window.confirm("이 토큰을 폐기할까요? 이 토큰으로 연결된 중앙 WAM은 즉시 접근할 수 없게 됩니다.")) return;
    setBusy(true);
    try { await api(`/federation/agent-tokens/${id}`, { method: "DELETE" }); loadTokens(); setStatus("토큰을 폐기했습니다."); }
    catch (error: any) { setStatus(error?.message || "토큰 폐기에 실패했습니다."); }
    finally { setBusy(false); }
  }

  return <article className="card federation-settings-card">
    <div className="card-top"><span>컴퓨터 연결</span><span className={`settings-status ${nodes.length ? "ready" : ""}`}>{nodes.length ? `${nodes.length}대 연결` : "이 컴퓨터만 사용"}</span></div>
    <p className="muted">한 대일 때는 지금처럼 사용하세요. 다른 컴퓨터에도 WAM을 설치했다면, 그곳에서 토큰을 만든 뒤 이곳에 주소와 토큰을 등록합니다. 원격 WAM의 채팅·파일·계정은 원격 컴퓨터에 남습니다.</p>
    <div className="slack-settings-actions"><button type="button" disabled={busy} onClick={() => void issueToken()}>이 컴퓨터의 연결 토큰 만들기</button></div>
    {issuedToken && <div className="mfa-secret"><small>한 번만 표시되는 연결 토큰</small><code>{issuedToken}</code><button type="button" onClick={() => { copyText(issuedToken); setStatus("토큰을 복사했습니다."); }}>복사</button><button type="button" onClick={() => setIssuedToken("")}>가리기</button></div>}
    {tokens.filter((item) => !item.revoked_at).map((item) => <div className="session-security-row" key={item.id}><span><strong>발급된 토큰</strong><small>{item.created_at}</small></span><button type="button" disabled={busy} onClick={() => void revokeToken(item.id)}>폐기</button></div>)}
    <form className="slack-settings-form" onSubmit={(event) => void addNode(event)}>
      <strong>다른 컴퓨터 추가</strong>
      <label>이름<input value={name} onChange={(event) => setName(event.target.value)} placeholder="작업용 PC" maxLength={80} required /></label>
      <label>원격 WAM 주소<input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://workstation.example.com/ 또는 http://100.101.102.103:4317/" type="url" required /></label>
      <p className="muted">내부 IP의 HTTP도 연결할 수 있습니다. Tailscale 밖의 Docker·사설망 HTTP는 전송 구간이 암호화되지 않으니 신뢰할 수 있는 네트워크에서만 사용하세요.</p>
      <label>원격 컴퓨터에서 만든 연결 토큰<input value={token} onChange={(event) => setToken(event.target.value)} type="password" autoComplete="off" required /></label>
      <div className="slack-settings-actions"><button className="primary" disabled={busy}>연결 확인·추가</button></div>
    </form>
    {nodes.map((node) => <div className="session-security-row" key={node.id}><span><strong>{node.name}</strong><small>{node.base_url}</small></span><button type="button" disabled={busy} onClick={() => void removeNode(node)}>연결 해제</button></div>)}
    {status && <span className="attachment-status" aria-live="polite">{status}</span>}
  </article>;
}
