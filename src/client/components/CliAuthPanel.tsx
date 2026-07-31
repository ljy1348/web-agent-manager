import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, KeyRound, LoaderCircle, Square, X } from "lucide-react";
import { api } from "../api";
import type { Json } from "../types";
import { AuthTerminal } from "../features/terminal/AuthTerminal";

const LABELS: Record<string, string> = { codex: "Codex", claude: "Claude", github: "GitHub" };

// 세 CLI의 인증 상태와 공식 로그인 터미널을 한 화면에서 관리한다.
export function CliAuthPanel({ open, user, socket, onClose, onRequireOpen }: { open: boolean; user: Json; socket: WebSocket | null; onClose: () => void; onRequireOpen: () => void }): React.ReactElement | null {
  const [providers, setProviders] = useState<Json[]>([]);
  const [selected, setSelected] = useState("codex");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const prompted = useRef(false);

  // CLI 인증 상태를 출력 내용 없이 종료 코드 기준으로 다시 확인한다.
  async function refresh(): Promise<void> {
    if (user.role !== "admin") return;
    try {
      const data = await api("/cli-auth");
      setProviders(data.providers || []);
      const pending = (data.providers || []).find((provider: Json) => provider.installed && !provider.authenticated);
      if (pending && !prompted.current) {
        prompted.current = true;
        setSelected(pending.provider);
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
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
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

  // 선택한 공급자의 공식 CLI 로그인 PTY를 시작한다.
  async function start(provider: string): Promise<void> {
    setSelected(provider);
    setError("");
    try {
      await api(`/cli-auth/${provider}/start`, { method: "POST" });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "로그인을 시작하지 못했습니다.");
    }
  }

  // 현재 인증 PTY를 명시적으로 중단한다.
  async function stop(provider: string): Promise<void> {
    await api(`/cli-auth/${provider}/stop`, { method: "POST" });
    await refresh();
  }

  if (!open || user.role !== "admin") return null;
  const current = providers.find((provider) => provider.provider === selected);
  return createPortal(<div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="cli-auth-dialog" role="dialog" aria-modal="true" aria-label="CLI 인증 관리">
      <header><div><span className="eyebrow">초기 연결</span><h2>CLI 인증</h2></div><button type="button" className="icon-button" title="닫기" onClick={onClose}><X size={18} /></button></header>
      <div className="cli-auth-layout">
        <aside className="cli-auth-providers">
          {loading && <span><LoaderCircle className="spin" size={15} />확인 중</span>}
          {providers.map((provider) => <button type="button" key={provider.provider} className={selected === provider.provider ? "active" : ""} onClick={() => setSelected(provider.provider)}>
            <span>{LABELS[provider.provider]}</span>
            <small>{!provider.installed ? "설치되지 않음" : provider.authenticated ? "인증됨" : provider.running ? "인증 진행 중" : "인증 필요"}</small>
            {provider.authenticated && <CheckCircle2 size={16} />}
          </button>)}
        </aside>
        <main className="cli-auth-main">
          <div className="cli-auth-head"><div><strong>{LABELS[selected]}</strong><span>{current?.authenticated ? "계정 인증이 완료되었습니다." : "아래 공식 CLI 흐름에서 브라우저 인증을 완료하세요."}</span></div><div>
            {current?.running ? <button type="button" onClick={() => void stop(selected)}><Square size={14} />중단</button> : <button type="button" className="primary" disabled={!current?.installed} onClick={() => void start(selected)}><KeyRound size={15} />{current?.authenticated ? "다시 인증" : "인증 시작"}</button>}
          </div></div>
          {error && <div className="error">{error}</div>}
          <AuthTerminal provider={selected} socket={socket} />
        </main>
      </div>
    </section>
  </div>, document.body);
}
