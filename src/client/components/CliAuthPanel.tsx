import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, KeyRound, LoaderCircle, Plus, Square, Trash2, X } from "lucide-react";
import { api } from "../api";
import type { Json } from "../types";
import { AuthTerminal } from "../features/terminal/AuthTerminal";
import { useDialogHistory } from "../lib/dialog-history";

const LABELS: Record<string, string> = { codex: "Codex", claude: "Claude", github: "GitHub" };

// 세 CLI의 인증 상태와 공식 로그인 터미널을 한 화면에서 관리한다.
// Codex·Claude는 계정 슬롯마다 설정 디렉터리가 따로라 계정별로 각각 로그인한다.
export function CliAuthPanel({ open, user, socket, onClose, onRequireOpen, onPendingChange }: { open: boolean; user: Json; socket: WebSocket | null; onClose: () => void; onRequireOpen: () => void; onPendingChange: (pending: boolean) => void }): React.ReactElement | null {
  const [providers, setProviders] = useState<Json[]>([]);
  const [accounts, setAccounts] = useState<Json[]>([]);
  const [usageScope, setUsageScope] = useState("default");
  const [selected, setSelected] = useState("codex");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const prompted = useRef(false);

  // 서버가 확인해 둔 CLI 인증 상태와 계정 슬롯 목록을 함께 읽는다.
  async function refresh(): Promise<void> {
    if (user.role !== "admin") return;
    try {
      const [authData, accountData] = await Promise.all([api("/cli-auth"), api("/agent-accounts")]);
      const nextProviders = authData.providers || [];
      setProviders(nextProviders);
      setAccounts(accountData.accounts || []);
      setUsageScope(accountData.usageScope || "default");
      // 기본 계정이 아직 인증되지 않았을 때만 처음 한 번 안내를 띄운다. 추가로 만든 계정은
      // 사용자가 의도적으로 나중에 인증할 수 있어 자동으로 화면을 열지 않는다.
      const pending = nextProviders.find((provider: Json) => provider.installed && !provider.authenticated
        && (provider.accountId == null || (accountData.accounts || []).some((account: Json) => account.id === provider.accountId && account.is_default)));
      onPendingChange(!!pending);
      if (pending && !prompted.current) {
        prompted.current = true;
        setSelected(pending.key);
        onRequireOpen();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "인증 상태를 확인하지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [user.role]);

  useEffect(() => {
    if (!socket) return;
    const receive = (event: MessageEvent): void => {
      const message = JSON.parse(event.data);
      if (message.type === "cli_auth_changed") void refresh();
    };
    socket.addEventListener("message", receive);
    return () => socket.removeEventListener("message", receive);
  }, [socket]);

  // 선택한 계정의 공식 CLI 로그인 PTY를 시작한다.
  async function start(target: Json): Promise<void> {
    setError("");
    try {
      await api(`/cli-auth/${target.provider}/start`, { method: "POST", body: JSON.stringify({ accountId: target.accountId }) });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "로그인을 시작하지 못했습니다.");
    }
  }

  // 현재 인증 PTY를 명시적으로 중단한다.
  async function stop(target: Json): Promise<void> {
    await api(`/cli-auth/${target.provider}/stop`, { method: "POST", body: JSON.stringify({ accountId: target.accountId }) });
    await refresh();
  }

  // 새 계정 슬롯을 만든다. 폴더만 준비되고 로그인은 이어서 사용자가 진행한다.
  async function addAccount(provider: string): Promise<void> {
    const label = window.prompt(`추가할 ${LABELS[provider]} 계정의 이름을 입력하세요 (예: 회사 계정)`);
    if (!label?.trim()) return;
    setError("");
    try {
      const created = await api("/agent-accounts", { method: "POST", body: JSON.stringify({ provider, label: label.trim() }) });
      await refresh();
      setSelected(`${provider}:${created.account.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "계정을 추가하지 못했습니다.");
    }
  }

  // 계정 슬롯을 지운다. 인증이 든 폴더까지 지울지는 따로 확인받는다(되돌릴 수 없음).
  async function removeAccount(account: Json): Promise<void> {
    if (!window.confirm(`'${account.label}' 계정을 목록에서 제거할까요?`)) return;
    const removeFiles = window.confirm("이 계정 폴더에 저장된 인증 정보도 함께 삭제할까요?\n\n확인을 누르면 폴더가 완전히 삭제되어 되돌릴 수 없습니다. 취소를 누르면 목록에서만 제거하고 폴더는 남겨둡니다.");
    setError("");
    try {
      await api(`/agent-accounts/${account.id}${removeFiles ? "?removeFiles=1" : ""}`, { method: "DELETE" });
      setSelected(account.provider);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "계정을 삭제하지 못했습니다.");
    }
  }

  // 사용량 조회를 기본 계정 하나만 볼지, 등록된 전 계정을 볼지 바꾼다.
  async function changeUsageScope(scope: string): Promise<void> {
    setUsageScope(scope);
    try {
      await api("/agent-accounts/usage-scope", { method: "PUT", body: JSON.stringify({ scope }) });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "사용량 조회 범위를 바꾸지 못했습니다.");
      await refresh();
    }
  }

  const dismiss = useDialogHistory(open, onClose, "cli-auth");
  if (!open || user.role !== "admin") return null;
  const current = providers.find((provider) => provider.key === selected) ?? providers.find((provider) => provider.provider === selected);
  const currentAccount = accounts.find((account) => account.id === current?.accountId);
  const headLabel = current?.accountLabel ? `${LABELS[current.provider]} · ${current.accountLabel}` : LABELS[current?.provider ?? selected];
  return createPortal(<div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) dismiss(); }}>
    <section className="cli-auth-dialog" role="dialog" aria-modal="true" aria-label="CLI 인증 관리">
      <header><div><span className="eyebrow">초기 연결</span><h2>CLI 인증 · 계정</h2></div><button type="button" className="icon-button" title="닫기" aria-label="닫기" onClick={() => dismiss()}><X size={18} /></button></header>
      <div className="cli-auth-layout">
        <aside className="cli-auth-providers">
          {loading && <span><LoaderCircle className="spin" size={15} />확인 중</span>}
          {["codex", "claude"].map((provider) => <React.Fragment key={provider}>
            <div className="cli-auth-group">
              <span>{LABELS[provider]}</span>
              <button type="button" className="icon-button" title={`${LABELS[provider]} 계정 추가`} aria-label={`${LABELS[provider]} 계정 추가`} onClick={() => void addAccount(provider)}><Plus size={14} /></button>
            </div>
            {providers.filter((entry) => entry.provider === provider).map((entry) => <button type="button" key={entry.key} className={selected === entry.key ? "active" : ""} onClick={() => setSelected(entry.key)}>
              <span>{entry.accountLabel || LABELS[provider]}</span>
              <small>{!entry.installed ? "설치되지 않음" : entry.authenticated ? "인증됨" : entry.running ? "인증 진행 중" : "인증 필요"}</small>
              {entry.authenticated && <CheckCircle2 size={16} />}
            </button>)}
          </React.Fragment>)}
          {providers.filter((entry) => entry.provider === "github").map((entry) => <button type="button" key={entry.key} className={selected === entry.key ? "active" : ""} onClick={() => setSelected(entry.key)}>
            <span>{LABELS.github}</span>
            <small>{!entry.installed ? "설치되지 않음" : entry.authenticated ? "인증됨" : entry.running ? "인증 진행 중" : "인증 필요"}</small>
            {entry.authenticated && <CheckCircle2 size={16} />}
          </button>)}
          <div className="cli-auth-scope">
            <label htmlFor="usage-scope">사용량 조회</label>
            <select id="usage-scope" value={usageScope} onChange={(event) => void changeUsageScope(event.target.value)}>
              <option value="default">기본 계정만</option>
              <option value="all">모든 계정</option>
            </select>
            <small>모든 계정을 고르면 계정마다 조회 터미널이 하나씩 상시 실행됩니다.</small>
          </div>
        </aside>
        <main className="cli-auth-main">
          <div className="cli-auth-head"><div><strong>{headLabel}</strong><span>{current?.authenticated ? "계정 인증이 완료되었습니다." : "아래 공식 CLI 흐름에서 브라우저 인증을 완료하세요."}</span></div><div>
            {currentAccount && !currentAccount.is_default && <button type="button" title="계정 삭제" onClick={() => void removeAccount(currentAccount)}><Trash2 size={14} />계정 삭제</button>}
            {current?.running
              ? <button type="button" onClick={() => void stop(current)}><Square size={14} />중단</button>
              : <button type="button" className="primary" disabled={!current?.installed} onClick={() => current && void start(current)}><KeyRound size={15} />{current?.authenticated ? "다시 인증" : "인증 시작"}</button>}
          </div></div>
          {currentAccount && !currentAccount.is_default && <p className="cli-auth-note">이 계정으로 만든 채팅 {currentAccount.chatCount}개. 새 채팅을 만들 때 계정을 고를 수 있습니다.</p>}
          {error && <div className="error">{error}</div>}
          <AuthTerminal provider={current?.key ?? selected} socket={socket} />
        </main>
      </div>
    </section>
  </div>, document.body);
}
