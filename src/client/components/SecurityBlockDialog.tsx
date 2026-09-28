import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Fingerprint, ShieldAlert, WifiOff, X } from "lucide-react";
import { api, type SecurityBlockReason } from "../api";
import { useDialogHistory } from "../lib/dialog-history";
import { BiometricError, biometricBridge, biometricStatus, reauthenticateWithBiometric } from "../lib/biometric";

export type SecurityBlockRequest = { reason: SecurityBlockReason; message: string };

// 서버가 403으로 막은 원인(재인증 필요·외부망 차단)을 화면 중앙에 알리고, 재인증은 그 자리에서 받는다.
export function SecurityBlockDialog({ request, temporary, onClose }: { request: SecurityBlockRequest; temporary: boolean; onClose: (reauthenticated: boolean) => void }) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [mfaEnabled, setMfaEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // 뒤로가기·닫기·성공이 모두 같은 닫기 경로를 타므로 성공 여부는 ref로 넘긴다.
  const reauthenticatedRef = useRef(false);
  const dismiss = useDialogHistory(true, () => onClose(reauthenticatedRef.current), "security-block");
  const reauth = request.reason === "reauth";
  const [biometric, setBiometric] = useState<{ deviceBound: boolean; enrolled: boolean } | null>(null);
  // 앱에서는 키보드가 지문 창을 가리지 않도록 비밀번호 칸 자동 포커스를 끈다.
  const [inApp] = useState(() => Boolean(biometricBridge()));
  const biometricAutoStartedRef = useRef(false);

  useEffect(() => {
    if (!reauth || temporary) return;
    // MFA 사용 여부를 모르면 입력칸을 숨기지 않도록 실패 시 true로 둔다.
    api("/auth/mfa").then((data) => setMfaEnabled(data?.enabled === true)).catch(() => setMfaEnabled(true));
    void biometricStatus().then((status) => {
      setBiometric(status);
      // 등록된 기기에서는 창이 뜨자마자 한 번만 지문 확인을 띄운다.
      if (status?.enrolled && !biometricAutoStartedRef.current) { biometricAutoStartedRef.current = true; void confirmWithBiometric(); }
    });
  }, [reauth, temporary]);

  async function confirmWithBiometric(): Promise<void> {
    setBusy(true); setError("");
    try {
      await reauthenticateWithBiometric();
      reauthenticatedRef.current = true;
      dismiss();
    } catch (caught: any) {
      if (caught instanceof BiometricError && caught.code === "cancelled") setError("지문 확인을 취소했습니다. 비밀번호로 확인하거나 다시 시도할 수 있습니다.");
      else setError(caught?.message || "지문 본인 확인에 실패했습니다.");
      if (caught instanceof BiometricError && ["invalidated", "missing"].includes(caught.code)) setBiometric((current) => current && { ...current, enrolled: false });
    } finally { setBusy(false); }
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      await api("/auth/reauth", { method: "POST", body: JSON.stringify({ currentPassword: password, code }) });
      setPassword(""); setCode("");
      reauthenticatedRef.current = true;
      dismiss();
    } catch (caught: any) {
      setError(caught?.message || "본인 확인에 실패했습니다.");
    } finally { setBusy(false); }
  }

  return createPortal(<div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) dismiss(); }}>
    <section className="project-dialog security-block-dialog" style={{ width: "min(480px, 100%)" }} role="dialog" aria-modal="true" aria-label={reauth ? "본인 확인 필요" : "외부망 접속 차단"}>
      <header><div><span className="eyebrow">보안 확인</span><h2>{reauth ? "본인 확인이 필요합니다" : "외부망이라 차단되었습니다"}</h2></div><button type="button" className="icon-button" title="닫기" aria-label="닫기" onClick={() => dismiss()} disabled={busy}><X size={18} /></button></header>
      {reauth ? <form className="project-form" onSubmit={submit}>
        <p className="project-form-note"><ShieldAlert size={14} aria-hidden="true" /> {request.message}</p>
        {temporary
          ? <p className="project-form-note">임시 로그인에서는 중요 작업 본인 확인을 할 수 없습니다. 관리자 계정으로 다시 로그인해주세요.</p>
          : <>
            <p className="project-form-note">삭제·CLI 업데이트·프로세스 종료 같은 중요 작업은 최근에 본인 확인을 해야 실행됩니다. 여기서 확인하면 하던 작업을 바로 이어서 실행합니다.</p>
            {biometric?.enrolled && <button type="button" className="primary" onClick={() => void confirmWithBiometric()} disabled={busy}><Fingerprint size={16} aria-hidden="true" /> 지문으로 확인</button>}
            {biometric?.deviceBound && !biometric.enrolled && <p className="project-form-note">설정 › 로그인 보안에서 지문 본인 확인을 등록하면 다음부터 지문으로 확인할 수 있습니다.</p>}
            <label>{biometric?.enrolled ? "또는 비밀번호" : "비밀번호"}<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required autoFocus={!inApp} /></label>
            {mfaEnabled !== false && <label>MFA 코드{mfaEnabled === null ? " (사용 중인 경우)" : ""}<input autoComplete="one-time-code" inputMode="numeric" maxLength={64} value={code} onChange={(event) => setCode(event.target.value.slice(0, 64))} required={mfaEnabled === true} /></label>}
          </>}
        {error && <div className="error">{error}</div>}
        <div className="dialog-actions"><button type="button" onClick={() => dismiss()} disabled={busy}>취소</button>{!temporary && <button className="primary" disabled={busy}>{busy ? "확인 중…" : "확인하고 계속"}</button>}</div>
      </form> : <div className="project-form">
        <p className="project-form-note"><WifiOff size={14} aria-hidden="true" /> {request.message}</p>
        <p className="project-form-note">지금 접속은 외부망으로 판정되어 삭제·프로세스 종료처럼 되돌릴 수 없는 작업이 막혀 있습니다. 다음 중 하나로 해결할 수 있습니다.</p>
        <ul className="project-form-note">
          <li>Android 앱: 내부망에서 한 번 접속해 설정 톱니의 <b>이 기기 앱 인증</b>을 해두면 외부망에서도 사용할 수 있습니다.</li>
          <li>브라우저: 내부망이나 VPN 주소(예: 192.168.x.x)로 직접 접속합니다. 도메인 주소 접속은 외부망으로 판정됩니다.</li>
        </ul>
        <div className="dialog-actions"><button type="button" className="primary" onClick={() => dismiss()} autoFocus>확인</button></div>
      </div>}
    </section>
  </div>, document.body);
}
