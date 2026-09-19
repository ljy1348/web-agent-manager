import React, { useEffect, useState } from "react";
import { Bell, KeyRound, ShieldCheck } from "lucide-react";
import { api } from "../../api";
import { copyText } from "../../lib/clipboard";
import type { Json } from "../../types";

interface SettingsViewProps {
  user: Json;
  slack: Json;
  ntfy: Json;
  notificationPermission: NotificationPermission;
  notificationsSupported: boolean;
  temporary: boolean;
  onEnableNotifications(): Promise<void>;
  onOpenCliAuth(): void;
  onSignedOut(): void;
}

interface WebSession {
  id: number;
  current: boolean;
  mobileTrusted: boolean;
  deviceLabel?: string | null;
  lastSeenAt: string;
  expiresAt: string;
}

function sessionTime(value: string): string {
  const normalized = /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value.replace(" ", "T")}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "short" }).format(parsed) : value;
}

// 현재 계정의 로그인 세션과 비밀번호를 운영 권한과 독립적으로 관리한다.
function SessionSecurityCard({ temporary, onSignedOut }: { temporary: boolean; onSignedOut(): void }): React.ReactElement {
  const [sessions, setSessions] = useState<WebSession[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState(false);
  const [changing, setChanging] = useState(false);
  const [reauthenticating, setReauthenticating] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [reauthPassword, setReauthPassword] = useState("");
  const [reauthCode, setReauthCode] = useState("");
  const [status, setStatus] = useState("");
  useEffect(() => {
    let active = true;
    void api("/auth/sessions")
      .then((data) => { if (active) { setSessions(data.sessions || []); setHasMore(!!data.hasMore); } })
      .catch((error: any) => { if (active) setStatus(error?.message || "세션을 불러오지 못했습니다."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  async function revokeOthers(): Promise<void> {
    setRevoking(true); setStatus("다른 세션을 로그아웃하는 중…");
    try {
      const data = await api("/auth/sessions/revoke-others", { method: "POST" });
      setSessions((current) => current.filter((session) => session.current));
      setHasMore(false);
      setStatus(`다른 세션 ${Number(data.revokedCount) || 0}개를 로그아웃했습니다.`);
    } catch (error: any) { setStatus(error?.message || "세션 로그아웃에 실패했습니다."); }
    finally { setRevoking(false); }
  }
  async function changePassword(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (newPassword !== confirmPassword) { setStatus("새 비밀번호 확인이 일치하지 않습니다."); return; }
    if (newPassword.length < 12 || newPassword.length > 256) { setStatus("새 비밀번호는 12~256자여야 합니다."); return; }
    setChanging(true); setStatus("비밀번호를 변경하고 모든 세션을 로그아웃하는 중…");
    try {
      await api("/auth/password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) });
      setCurrentPassword(""); setNewPassword(""); setConfirmPassword("");
      onSignedOut();
    } catch (error: any) { setStatus(error?.message || "비밀번호 변경에 실패했습니다."); }
    finally { setChanging(false); }
  }
  async function reauthenticate(event: React.FormEvent): Promise<void> {
    event.preventDefault(); setReauthenticating(true); setStatus("본인 확인 중…");
    try {
      const data = await api("/auth/reauth", { method: "POST", body: JSON.stringify({ currentPassword: reauthPassword, code: reauthCode }) });
      setReauthPassword(""); setReauthCode("");
      setStatus(`본인 확인을 완료했습니다. ${sessionTime(data.validUntil)}까지 중요 작업을 실행할 수 있습니다.`);
    } catch (error: any) { setStatus(error?.message || "본인 확인에 실패했습니다."); }
    finally { setReauthenticating(false); }
  }
  const otherCount = sessions.filter((session) => !session.current).length;
  return <article className="card session-security-card"><div className="card-top"><span>로그인 보안</span><span className="settings-status ready">보호됨</span></div>
    <div className="settings-card-copy"><ShieldCheck size={22} aria-hidden="true" /><p>현재 계정의 로그인 세션을 확인하고, 필요하면 다른 기기나 브라우저의 세션을 모두 끊습니다.</p></div>
    <div className="session-security-list" aria-label="로그인 세션 목록">
      {loading && <span className="muted">세션을 확인하는 중…</span>}
      {!loading && sessions.map((session) => <div className="session-security-row" key={session.id}><span><strong>{session.current ? "현재 세션" : session.deviceLabel || "다른 브라우저"}</strong><small>{session.mobileTrusted ? "신뢰 기기 · " : ""}최근 활동 {sessionTime(session.lastSeenAt)}</small></span>{session.current && <i>현재</i>}</div>)}
      {!loading && sessions.length === 0 && <span className="muted">활성 세션이 없습니다.</span>}
      {hasMore && <small className="muted">최근 세션 100개만 표시합니다.</small>}
    </div>
    {!temporary && <><div className="slack-settings-actions"><button type="button" disabled={revoking || otherCount === 0} onClick={() => void revokeOthers()}>{revoking ? "로그아웃 중…" : `다른 세션 로그아웃${otherCount ? ` (${otherCount})` : ""}`}</button></div>
      <form className="slack-settings-form password-change-form" onSubmit={reauthenticate}>
        <strong>중요 작업 본인 확인</strong><span className="muted idle-note">삭제·CLI 업데이트·프로세스 종료 전에 필요합니다. MFA를 사용 중이면 코드도 입력하세요.</span>
        <label>재인증 비밀번호<input type="password" autoComplete="current-password" value={reauthPassword} onChange={(event) => setReauthPassword(event.target.value)} required /></label>
        <label>재인증 MFA 코드 (사용 중인 경우)<input autoComplete="one-time-code" maxLength={64} value={reauthCode} onChange={(event) => setReauthCode(event.target.value.slice(0, 64))} /></label>
        <div className="slack-settings-actions"><button className="primary" disabled={reauthenticating}>{reauthenticating ? "확인 중…" : "중요 작업 본인 확인"}</button></div>
      </form>
      <form className="slack-settings-form password-change-form" onSubmit={changePassword}>
        <strong>비밀번호 변경</strong>
        <label>현재 비밀번호<input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></label>
        <label>새 비밀번호<input type="password" autoComplete="new-password" minLength={12} maxLength={256} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></label>
        <label>새 비밀번호 확인<input type="password" autoComplete="new-password" minLength={12} maxLength={256} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required /></label>
        <div className="slack-settings-actions"><button className="primary" disabled={changing}>{changing ? "변경 중…" : "비밀번호 변경·전체 로그아웃"}</button></div>
      </form></>}
    {temporary && <p className="muted idle-note">임시 로그인에서는 세션과 비밀번호를 변경할 수 없습니다.</p>}
    {status && <span className="attachment-status" aria-live="polite">{status}</span>}
  </article>;
}

// 표준 인증 앱과 호환되는 TOTP를 등록하고 일회용 복구 코드를 한 번만 표시한다.
function MfaSettingsCard({ onSignedOut }: { onSignedOut(): void }): React.ReactElement {
  const [info, setInfo] = useState<{ enabled: boolean; recoveryCodesRemaining: number } | null>(null);
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [currentPassword, setCurrentPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => { void api("/auth/mfa").then((data) => setInfo(data)).catch((error: any) => setMessage(error?.message || "MFA 상태를 불러오지 못했습니다.")); }, []);
  async function begin(event: React.FormEvent): Promise<void> {
    event.preventDefault(); setBusy(true); setMessage("등록 정보를 만드는 중…");
    try { const data = await api("/auth/mfa/setup", { method: "POST", body: JSON.stringify({ currentPassword }) }); setSetup(data); setCurrentPassword(""); setMessage("인증 앱에 아래 키를 등록하고 생성된 6자리 코드를 확인하세요."); }
    catch (error: any) { setMessage(error?.message || "MFA 등록을 시작하지 못했습니다."); } finally { setBusy(false); }
  }
  async function confirm(event: React.FormEvent): Promise<void> {
    event.preventDefault(); setBusy(true); setMessage("인증 코드를 확인하는 중…");
    try { const data = await api("/auth/mfa/confirm", { method: "POST", body: JSON.stringify({ code }) }); setRecoveryCodes(data.recoveryCodes || []); setInfo({ enabled: true, recoveryCodesRemaining: (data.recoveryCodes || []).length }); setSetup(null); setCode(""); setMessage("MFA를 켰습니다. 복구 코드는 이 화면에서 한 번만 확인할 수 있습니다."); }
    catch (error: any) { setMessage(error?.message || "인증 코드 확인에 실패했습니다."); } finally { setBusy(false); }
  }
  async function disable(event: React.FormEvent): Promise<void> {
    event.preventDefault(); setBusy(true); setMessage("MFA를 해제하고 모든 세션을 로그아웃하는 중…");
    try { await api("/auth/mfa/disable", { method: "POST", body: JSON.stringify({ currentPassword, code }) }); onSignedOut(); }
    catch (error: any) { setMessage(error?.message || "MFA 해제에 실패했습니다."); } finally { setBusy(false); }
  }
  function copyRecoveryCodes(): void { copyText(recoveryCodes.join("\n")); setMessage("복구 코드를 복사했습니다. 안전한 곳에 별도로 보관하세요."); }
  return <article className="card mfa-settings-card"><div className="card-top"><span>2단계 인증</span><span className={`settings-status ${info?.enabled ? "ready" : ""}`}>{info === null ? "확인 중" : info.enabled ? "사용 중" : "꺼짐"}</span></div>
    <p className="muted one-time-login-description">인증 앱의 30초 TOTP 코드로 비밀번호 로그인을 한 번 더 확인합니다.</p>
    {recoveryCodes.length > 0 && <div className="mfa-recovery-codes" aria-label="MFA 복구 코드"><strong>복구 코드</strong><code>{recoveryCodes.join("\n")}</code><button type="button" onClick={copyRecoveryCodes}>모두 복사</button></div>}
    {!info?.enabled && !setup && <form className="slack-settings-form" onSubmit={begin}><label>MFA 현재 비밀번호<input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></label><div className="slack-settings-actions"><button className="primary" disabled={busy || info === null}>{busy ? "준비 중…" : "TOTP 등록 시작"}</button></div></form>}
    {!info?.enabled && setup && <form className="slack-settings-form" onSubmit={confirm}><div className="mfa-secret"><small>수동 등록 키</small><code>{setup.secret}</code><button type="button" onClick={() => { copyText(setup.secret); setMessage("등록 키를 복사했습니다."); }}>복사</button></div><label>MFA 6자리 확인 코드<input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} required /></label><div className="slack-settings-actions"><button className="primary" disabled={busy}>{busy ? "확인 중…" : "MFA 활성화"}</button></div></form>}
    {info?.enabled && recoveryCodes.length === 0 && <form className="slack-settings-form" onSubmit={disable}><span className="muted">남은 복구 코드 {info.recoveryCodesRemaining}개</span><label>MFA 현재 비밀번호<input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></label><label>MFA 코드 또는 복구 코드<input autoComplete="one-time-code" maxLength={64} value={code} onChange={(event) => setCode(event.target.value.slice(0, 64))} required /></label><div className="slack-settings-actions"><button disabled={busy}>{busy ? "해제 중…" : "MFA 해제·전체 로그아웃"}</button></div></form>}
    {message && <span className="attachment-status" aria-live="polite">{message}</span>}
  </article>;
}

// 관리자 전용 Slack bot token·channel id 설정 카드.
function SlackSettingsCard({ connected }: { connected: boolean }): React.ReactElement {
  const [settings, setSettings] = useState<Json | null>(null);
  const [botToken, setBotToken] = useState("");
  const [channelId, setChannelId] = useState("");
  const [status, setStatus] = useState("");
  useEffect(() => { void api("/admin/slack-settings").then((data) => { setSettings(data); setChannelId(data.channelId || ""); }).catch(() => undefined); }, []);
  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setStatus("저장 중…");
    try {
      const data = await api("/admin/slack-settings", { method: "PUT", body: JSON.stringify({ botToken, channelId }) });
      setSettings(data); setBotToken(""); setStatus("저장했습니다.");
    } catch (error: any) {
      setStatus(error?.message || "저장에 실패했습니다.");
    }
  }
  async function test(): Promise<void> {
    setStatus("테스트 메시지 전송 중…");
    try { await api("/slack/test", { method: "POST" }); setStatus("테스트 메시지를 보냈습니다."); } catch (error: any) { setStatus(error?.message || "전송에 실패했습니다."); }
  }
  return <article className="card"><div className="card-top"><span>Slack 알림</span><span className={`settings-status ${connected ? "ready" : ""}`}>{connected ? "연결됨" : "미설정"}</span></div>
    <form className="slack-settings-form" onSubmit={save}>
      <label>Bot Token<input type="password" value={botToken} onChange={(event) => setBotToken(event.target.value)} placeholder={settings?.botTokenConfigured ? "설정됨 (바꾸려면 새로 입력)" : "xoxb-..."} /></label>
      <label>Channel ID<input value={channelId} onChange={(event) => setChannelId(event.target.value)} placeholder="C0123456789" /></label>
      <div className="slack-settings-actions"><button className="primary">저장</button><button type="button" onClick={test}>테스트 전송</button></div>
      {status && <span className="attachment-status">{status}</span>}
    </form>
  </article>;
}

// 관리자 전용 ntfy topic·서버 URL 설정 카드.
function NtfySettingsCard({ connected }: { connected: boolean }): React.ReactElement {
  const [settings, setSettings] = useState<Json | null>(null);
  const [topic, setTopic] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [status, setStatus] = useState("");
  useEffect(() => { void api("/admin/ntfy-settings").then((data) => { setSettings(data); setTopic(data.topic || ""); setServerUrl(data.serverUrl || ""); }).catch(() => undefined); }, []);
  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setStatus("저장 중…");
    try {
      const data = await api("/admin/ntfy-settings", { method: "PUT", body: JSON.stringify({ topic, serverUrl }) });
      setSettings(data); setStatus("저장했습니다.");
    } catch (error: any) {
      setStatus(error?.message || "저장에 실패했습니다.");
    }
  }
  async function test(): Promise<void> {
    setStatus("테스트 알림 전송 중…");
    try { await api("/ntfy/test", { method: "POST" }); setStatus("테스트 알림을 보냈습니다."); } catch (error: any) { setStatus(error?.message || "전송에 실패했습니다."); }
  }
  return <article className="card"><div className="card-top"><span>ntfy 알림</span><span className={`settings-status ${connected ? "ready" : ""}`}>{connected ? "연결됨" : "미설정"}</span></div>
    <form className="slack-settings-form" onSubmit={save}>
      <label>Topic<input value={topic} onChange={(event) => setTopic(event.target.value)} placeholder={settings?.topic || "my_web_agent_z6119"} /></label>
      <label>서버 URL<input value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="https://ntfy.sh" /></label>
      <div className="slack-settings-actions"><button className="primary">저장</button><button type="button" onClick={test}>테스트 전송</button></div>
      {status && <span className="attachment-status">{status}</span>}
    </form>
  </article>;
}

// 범용 webhook URL은 path/query에 토큰이 있을 수 있으므로 기존 값은 host만 보여준다.
function WebhookSettingsCard(): React.ReactElement {
  const [settings, setSettings] = useState<Json | null>(null);
  const [endpointUrl, setEndpointUrl] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [status, setStatus] = useState("");
  useEffect(() => {
    let active = true;
    void api("/admin/webhook-settings")
      .then((data) => { if (active) { setSettings(data); setEnabled(!!data.enabled); } })
      .catch((error: any) => { if (active) setStatus(error?.message || "Webhook 설정을 불러오지 못했습니다."); });
    return () => { active = false; };
  }, []);
  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault(); setBusy("save"); setStatus("Webhook 설정 저장 중…");
    try {
      const data = await api("/admin/webhook-settings", { method: "PUT", body: JSON.stringify({ endpointUrl, signingSecret, enabled }) });
      setSettings(data); setEndpointUrl(""); setSigningSecret(""); setEnabled(!!data.enabled); setStatus("Webhook 설정을 저장했습니다.");
    } catch (error: any) { setStatus(error?.message || "Webhook 설정 저장에 실패했습니다."); }
    finally { setBusy(null); }
  }
  async function test(): Promise<void> {
    setBusy("test"); setStatus("서명된 테스트 webhook 전송 중…");
    try { await api("/webhook/test", { method: "POST" }); setStatus("서명된 테스트 webhook을 보냈습니다."); }
    catch (error: any) { setStatus(error?.message || "Webhook 전송에 실패했습니다."); }
    finally { setBusy(null); }
  }
  const connected = !!settings?.enabled;
  return <article className="card webhook-settings-card"><div className="card-top"><span>Signed outbound webhook</span><span className={`settings-status ${connected ? "ready" : ""}`}>{settings === null ? "확인 중" : connected ? "사용 중" : "꺼짐"}</span></div>
    <p className="muted idle-note">CI·incident 자동화용 고정 JSON을 HTTPS로 전송합니다. URL 경로와 HMAC secret은 다시 표시하지 않습니다.</p>
    {settings?.endpointHost && <small>등록 host: <code>{settings.endpointHost}</code></small>}
    <form className="slack-settings-form" onSubmit={save}>
      <label>Webhook endpoint<input type="password" autoComplete="off" value={endpointUrl} onChange={(event) => setEndpointUrl(event.target.value)} placeholder={settings?.endpointConfigured ? "설정됨 (바꾸려면 전체 HTTPS URL 입력)" : "https://hooks.example.com/wam"} /></label>
      <label>HMAC signing secret<input type="password" autoComplete="new-password" minLength={32} maxLength={1024} value={signingSecret} onChange={(event) => setSigningSecret(event.target.value)} placeholder={settings?.signingSecretConfigured ? "설정됨 (바꾸려면 새 secret 입력)" : "32 byte 이상"} /></label>
      <label className="checkbox-line"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />전송 활성화</label>
      <div className="slack-settings-actions"><button className="primary" disabled={busy !== null}>{busy === "save" ? "저장 중…" : "저장"}</button><button type="button" disabled={busy !== null || !settings?.enabled} onClick={() => void test()}>{busy === "test" ? "전송 중…" : "테스트 전송"}</button></div>
      {status && <span className="attachment-status" aria-live="polite">{status}</span>}
    </form>
  </article>;
}

// 브라우저별 알림 권한은 서버 설정과 달리 현재 기기에서 직접 허용해야 한다.
function BrowserNotificationCard({ permission, supported, onEnable }: { permission: NotificationPermission; supported: boolean; onEnable(): Promise<void> }): React.ReactElement {
  const label = !supported ? "지원 안 함" : permission === "granted" ? "허용됨" : permission === "denied" ? "차단됨" : "허용 필요";
  const description = permission === "granted"
    ? "작업 완료와 사용량 초기화를 이 브라우저에서 알립니다."
    : permission === "denied"
      ? "브라우저 또는 운영체제 설정에서 이 사이트의 알림을 허용하세요."
      : "작업 완료와 사용량 초기화를 놓치지 않도록 이 기기에서 권한을 요청합니다.";
  return <article className="card notification-settings-card"><div className="card-top"><span>브라우저 알림</span><span className={`settings-status ${permission === "granted" ? "ready" : ""}`}>{label}</span></div>
    <div className="settings-card-copy"><Bell size={22} aria-hidden="true" /><p>{description}</p></div>
    <div className="slack-settings-actions"><button type="button" className="primary" disabled={!supported || permission !== "default"} onClick={() => void onEnable()}>{permission === "granted" ? "알림 사용 중" : permission === "denied" ? "브라우저에서 변경" : "알림 허용"}</button></div>
  </article>;
}

// 관리자 전용 유휴 채팅 자동 종료 정책 카드.
function IdleChatSettingsCard(): React.ReactElement {
  const [enabled, setEnabled] = useState(true);
  const [timeoutHours, setTimeoutHours] = useState(24);
  const [status, setStatus] = useState("");
  useEffect(() => {
    void api("/admin/idle-chat-settings")
      .then((data) => { setEnabled(!!data.enabled); setTimeoutHours(Number(data.timeoutHours) || 24); })
      .catch(() => undefined);
  }, []);
  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setStatus("저장 중…");
    try {
      const data = await api("/admin/idle-chat-settings", { method: "PUT", body: JSON.stringify({ enabled, timeoutHours }) });
      setEnabled(!!data.enabled); setTimeoutHours(Number(data.timeoutHours)); setStatus("저장했습니다.");
    } catch (error: any) {
      setStatus(error?.message || "저장에 실패했습니다.");
    }
  }
  return <article className="card"><div className="card-top">유휴 채팅 자동 종료</div>
    <form className="slack-settings-form" onSubmit={save}>
      <label className="idle-toggle"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />설정한 시간 동안 아무 활동이 없는 터미널을 자동 종료</label>
      <label>기준 시간(시간)<input type="number" min={1} max={720} value={timeoutHours} onChange={(event) => setTimeoutHours(Number(event.target.value))} /></label>
      <p className="muted idle-note">작업 중이거나 리밋 재개를 기다리거나 승인 응답을 기다리는 채팅은 종료하지 않습니다. 10분마다 검사합니다.</p>
      <div className="slack-settings-actions"><button className="primary">저장</button></div>
      {status && <span className="attachment-status">{status}</span>}
    </form>
  </article>;
}

// 정식 관리자가 일반 사용자용 8자리 임시 로그인 코드를 발급한다.
function OneTimeLoginCard(): React.ReactElement {
  const [issued, setIssued] = useState<Json | null>(null);
  const [status, setStatus] = useState("");
  const [issuing, setIssuing] = useState(false);
  async function issue(): Promise<void> {
    setIssuing(true);
    setStatus("발급 중…");
    try {
      const data = await api("/auth/one-time-codes", { method: "POST" });
      setIssued(data);
      setStatus("새 코드를 발급했습니다. 이 화면을 벗어나면 원문을 다시 확인할 수 없습니다.");
    } catch (error: any) {
      setStatus(error?.message || "코드 발급에 실패했습니다.");
    } finally {
      setIssuing(false);
    }
  }
  function copy(): void {
    if (!issued?.oneTimeCode) return;
    copyText(String(issued.oneTimeCode));
    setStatus("코드를 복사했습니다.");
  }
  return <article className="card one-time-login-card"><div className="card-top">일회용 임시 로그인</div>
    <p className="muted one-time-login-description">8자리 숫자 코드는 10분 안에 한 번만 사용할 수 있습니다. 로그인 후 1시간 동안 일반 사용자 권한만 제공하며 내부망 권한은 부여하지 않습니다.</p>
    {issued?.oneTimeCode && <div className="issued-login-code" aria-live="polite"><code>{issued.oneTimeCode}</code><button type="button" onClick={copy}>복사</button></div>}
    <div className="slack-settings-actions"><button type="button" className="primary" disabled={issuing} onClick={() => void issue()}>{issuing ? "발급 중…" : issued ? "새 코드 발급" : "코드 발급"}</button></div>
    {status && <span className="attachment-status">{status}</span>}
  </article>;
}

interface FullBackupSummary {
  id: string;
  createdAt: string;
  sizeBytes: number;
  counts: Record<string, number>;
  externalRequirements: string[];
}

interface RemoteWorkerHost {
  id: string;
  name: string;
  hostname: string;
  port: number;
  username: string;
  workspaceRoot: string;
  hostKeyFingerprint: string;
  enabled: boolean;
  status: "unverified" | "ready" | "unreachable" | "incompatible";
  protocolVersion?: string | null;
  workerVersion?: string | null;
  capabilities: string[];
  lastLatencyMs?: number | null;
  lastError?: string | null;
  lastProbedAt?: string | null;
}

interface RemoteWorkerMapping { id: string; projectId: number; projectName?: string | null; hostId: string; hostName?: string | null; remotePath: string; enabled: boolean; }

const shadowReasonLabels: Record<string, string> = { shadow_disabled: "shadow가 꺼져 있음", insufficient_days: "상태 관찰 일수 7일 미만", insufficient_observations: "상태 관찰 100건 미만", no_eligible_chats: "관찰할 활성 Codex 채팅 없음", insufficient_chat_coverage: "활성 채팅 coverage 80% 미만", busy_state_not_observed: "busy 표본 없음", idle_state_not_observed: "idle 표본 없음", mismatch_observed: "상태 불일치 발견", error_observed: "상태 조회 오류 발견", inconclusive_observed: "상태 판정 불가 표본 발견", observation_stale: "최근 15분 상태 관찰 없음", latency_over_timeout: "상태 p95 지연이 timeout 초과", turn_shadow_disabled: "turn history shadow가 꺼져 있음", turn_insufficient_days: "turn 관찰 일수 7일 미만", turn_insufficient_scans: "turn scan 100건 미만", turn_insufficient_terminal_turns: "종료 turn 10건 미만", turn_scan_error_observed: "turn 조회 오류 발견", turn_metadata_invalid: "turn metadata 누락·역행 발견", turn_terminal_pair_missing: "시작 없는 종료 turn 발견", turn_observation_stale: "최근 15분 turn 관찰 없음", turn_latency_over_timeout: "turn p95 지연이 timeout 초과", interactive_transport_candidate_flag_required: "대화형 후보 flag 꺼짐", interactive_transport_cohort_required: "후보 cohort 미설정", interactive_transport_quota_required: "후보 신규 채팅 quota 미설정" };

function StructuredShadowReadinessCard(): React.ReactElement {
  const [data, setData] = useState<Json | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function load(): Promise<void> { setBusy(true); try { setData(await api("/admin/providers/codex/shadow")); setError(""); } catch (reason: any) { setError(reason?.message || "shadow readiness를 불러오지 못했습니다."); } finally { setBusy(false); } }
  useEffect(() => { void load(); }, []);
  const readiness = data?.readiness; const thread = readiness?.threadStatus || readiness; const metrics = thread?.metrics; const turn = readiness?.turnHistory; const turnMetrics = turn?.metrics; const reasons = Array.isArray(readiness?.reasons) ? readiness.reasons : [];
  const badge = readiness?.candidateEligible ? "후보 gate 통과" : readiness?.status === "ready" ? "shadow gate 통과" : "관찰 필요";
  return <article className="card shadow-readiness-card"><div className="card-top"><span>Codex structured shadow gate</span><span className={`settings-status ${readiness?.status === "ready" ? "ready" : ""}`}>{badge}</span></div>
    <p className="muted one-time-login-description">구조화 쓰기를 켜지 않고 thread status와 본문 없는 turn history를 함께 판정합니다. 상태는 7일·100건·80% coverage, turn은 7일·100 scan·종료 10건과 start/end 누락 0건을 요구합니다.</p>
    {metrics && <div className="shadow-metrics"><span>상태 일수 <b>{metrics.observedDays}/7</b></span><span>상태 표본 <b>{metrics.observations}/100</b></span><span>채팅 <b>{metrics.observedChats}/{metrics.eligibleChats}</b></span><span>busy/idle <b>{metrics.busySamples}/{metrics.idleSamples}</b></span><span>상태 p95 <b>{metrics.p95LatencyMs ?? "-"}ms</b></span></div>}
    {turnMetrics && <div className="shadow-metrics"><span>turn 일수 <b>{turnMetrics.observedDays}/7</b></span><span>scan <b>{turnMetrics.scans}/100</b></span><span>종료 pair <b>{turnMetrics.pairedTurns}/{turnMetrics.terminalTurns}</b></span><span>누락/무효 <b>{turnMetrics.missingPairs}/{turnMetrics.invalidTurns}</b></span><span>turn p95 <b>{turnMetrics.p95LatencyMs ?? "-"}ms</b></span></div>}
    {readiness && <p className="muted idle-note">대화형 후보 flag: {readiness.interactiveCandidateEnabled ? "켜짐" : "꺼짐"} · cohort: {readiness.interactiveCandidateCohort || "미설정"} · quota: {readiness.interactiveCandidateMaxNewChats || 0} · limited 연결: {readiness.transitionEligible ? "가능" : "차단"}</p>}
    {Array.isArray(readiness?.candidateBlockers) && readiness.candidateBlockers.length > 0 && <div className="profile-warnings">{readiness.candidateBlockers.map((reason: string) => <span key={`candidate:${reason}`}>{shadowReasonLabels[reason] || reason}</span>)}</div>}
    {reasons.length > 0 && <div className="profile-warnings">{reasons.map((reason: string) => <span key={reason}>{shadowReasonLabels[reason] || reason}</span>)}</div>}
    <div className="slack-settings-actions"><button type="button" disabled={busy} onClick={() => void load()}>{busy ? "계산 중…" : "Readiness 새로고침"}</button></div>{error && <span className="attachment-status">{error}</span>}
  </article>;
}

interface ProjectProfileVersion { id: string; version: number; configSnapshot: Json; note?: string | null; }
interface ProjectProfile { id: string; name: string; taskKind: string; status: string; activeVersion?: number | null; versions: ProjectProfileVersion[]; }
const profileReadinessIssueLabels: Record<string, string> = {
  active_profile_missing: "활성 profile 없음",
  verification_steps_missing: "검증 단계 없음",
  protected_actions_missing: "보호 정책 없음",
  project_analysis_failed: "프로젝트 분석 실패",
};

function ProjectProfileSettingsCard(): React.ReactElement {
  const [projects, setProjects] = useState<Json[]>([]); const [projectId, setProjectId] = useState(0);
  const [profiles, setProfiles] = useState<ProjectProfile[]>([]); const [provider, setProvider] = useState("codex"); const [taskKind, setTaskKind] = useState("implementation");
  const [name, setName] = useState(""); const [note, setNote] = useState(""); const [snapshot, setSnapshot] = useState(""); const [warnings, setWarnings] = useState<string[]>([]);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null); const [busy, setBusy] = useState<string | null>(null); const [status, setStatus] = useState("");
  const [readiness, setReadiness] = useState<Json | null>(null);
  async function loadReadiness(): Promise<void> { try { setReadiness((await api("/admin/project-profiles/readiness")).readiness); } catch (error: any) { setStatus(error?.message || "전체 profile 준비 상태를 불러오지 못했습니다."); } }
  useEffect(() => { void Promise.all([api("/projects").then((data) => { const rows = data.projects || []; setProjects(rows); if (rows[0]) setProjectId(Number(rows[0].id)); }), loadReadiness()]).catch((error: any) => setStatus(error?.message || "프로젝트를 불러오지 못했습니다.")); }, []);
  useEffect(() => { if (!projectId) return; setProfiles([]); void api(`/projects/${projectId}/profiles`).then((data) => setProfiles(data.profiles || [])).catch((error: any) => setStatus(error?.message || "프로필을 불러오지 못했습니다.")); }, [projectId]);
  async function analyze(): Promise<void> { setBusy("analyze"); setStatus("프로젝트 지침과 검증 명령을 분석하는 중…"); try { const data = await api(`/projects/${projectId}/profile-draft`, { method: "POST", body: JSON.stringify({ provider, taskKind }) }); setName(data.draft.name); setSnapshot(JSON.stringify(data.draft.configSnapshot, null, 2)); setWarnings(data.draft.warnings || []); setEditingProfileId(null); setStatus("초안을 만들었습니다. JSON과 경고를 검토한 뒤 draft로 저장하세요."); } catch (error: any) { setStatus(error?.message || "프로필 초안 분석에 실패했습니다."); } finally { setBusy(null); } }
  async function save(event: React.FormEvent): Promise<void> { event.preventDefault(); let configSnapshot: unknown; try { configSnapshot = JSON.parse(snapshot); } catch { setStatus("프로필 JSON이 올바르지 않습니다."); return; } setBusy("save"); setStatus("검토한 프로필 version을 저장하는 중…"); try { const target = editingProfileId ? `/projects/${projectId}/profiles/${encodeURIComponent(editingProfileId)}/versions` : `/projects/${projectId}/profiles`; const body = editingProfileId ? { configSnapshot, note } : { name, taskKind, configSnapshot, note }; await api(target, { method: "POST", body: JSON.stringify(body) }); const data = await api(`/projects/${projectId}/profiles`); setProfiles(data.profiles || []); await loadReadiness(); setEditingProfileId(null); setNote(""); setStatus("draft version을 저장했습니다. 활성화 전에는 새 채팅에 적용되지 않습니다."); } catch (error: any) { setStatus(error?.message || "프로필 저장에 실패했습니다."); } finally { setBusy(null); } }
  function editVersion(profile: ProjectProfile, version: ProjectProfileVersion): void { setEditingProfileId(profile.id); setName(profile.name); setTaskKind(profile.taskKind); setSnapshot(JSON.stringify(version.configSnapshot, null, 2)); setNote(""); setWarnings(profileWarnings(version.configSnapshot)); setStatus(`${profile.name} v${version.version}을 바탕으로 새 불변 version을 검토합니다.`); }
  async function activate(profile: ProjectProfile, version: ProjectProfileVersion): Promise<void> { const warningText = profileWarnings(version.configSnapshot); if (!window.confirm(`${profile.name} v${version.version}을 ${projects.find((item) => Number(item.id) === projectId)?.name || "프로젝트"}의 ${profile.taskKind} 기본값으로 활성화할까요?${warningText.length ? `\n경고: ${warningText.join(", ")}` : ""}`)) return; setBusy(`activate:${version.id}`); setStatus("선택한 version을 활성화하는 중…"); try { await api(`/projects/${projectId}/profiles/${encodeURIComponent(profile.id)}/activate`, { method: "POST", body: JSON.stringify({ versionId: version.id }) }); const data = await api(`/projects/${projectId}/profiles`); setProfiles(data.profiles || []); await loadReadiness(); setStatus(`${profile.name} v${version.version}을 활성화했습니다. 새 채팅부터 적용됩니다.`); } catch (error: any) { setStatus(error?.message || "프로필 활성화에 실패했습니다."); } finally { setBusy(null); } }
  function profileWarnings(config: Json): string[] { const result: string[] = []; const files = config?.instructions?.files; const steps = config?.verification?.steps; const protectedActions = config?.protectedActions; if (!Array.isArray(files) || !files.includes("AGENTS.md")) result.push("AGENTS.md 없음"); if (!Array.isArray(steps) || !steps.length) result.push("검증 명령 없음"); if (!Array.isArray(protectedActions) || !protectedActions.length) result.push("보호 정책 없음"); return result; }
  return <article className="card project-profile-card"><div className="card-top"><span>프로젝트 Agent profile</span><span className={`settings-status ${profiles.some((item) => item.status === "active") ? "ready" : ""}`}>{profiles.filter((item) => item.status === "active").length}개 활성</span></div>
    <p className="muted one-time-login-description">프로젝트 파일을 읽어 제안만 만들고 자동 적용하지 않습니다. JSON을 검토해 draft로 저장한 뒤 특정 version을 별도로 활성화하세요.</p>
    {readiness && <div className="profile-readiness"><strong>전체 준비 {readiness.readyProjects}/{readiness.totalProjects}</strong>{(readiness.projects || []).map((item: Json) => <button type="button" className={item.ready ? "ready" : ""} key={item.projectId} onClick={() => setProjectId(Number(item.projectId))}><span>{item.projectName}</span><small>{item.ready ? "준비됨" : [...(item.taskKinds || []).flatMap((kind: Json) => kind.issues || []), ...(item.detectedWarnings || [])].map((issue: string) => profileReadinessIssueLabels[issue] || issue).join(" · ")}</small></button>)}</div>}
    <div className="profile-controls"><select aria-label="Profile 프로젝트" value={projectId || ""} onChange={(event) => setProjectId(Number(event.target.value))}>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><select aria-label="Profile provider" value={provider} onChange={(event) => setProvider(event.target.value)}><option value="codex">Codex</option><option value="claude">Claude</option><option value="grok">Grok</option></select><select aria-label="Profile 작업 종류" value={taskKind} onChange={(event) => setTaskKind(event.target.value)}><option value="analysis">분석</option><option value="implementation">일반 구현</option><option value="high_risk">고위험 변경</option><option value="operations">운영</option></select><button type="button" className="primary" disabled={!projectId || busy !== null} onClick={() => void analyze()}>{busy === "analyze" ? "분석 중…" : "초안 분석"}</button></div>
    {snapshot && <form className="profile-review-form" onSubmit={save}><label>프로필 이름<input value={name} maxLength={200} disabled={!!editingProfileId} onChange={(event) => setName(event.target.value)} required /></label><label>검토 메모<input value={note} maxLength={20000} onChange={(event) => setNote(event.target.value)} placeholder="검증 명령과 보호 정책 확인" /></label>{warnings.length > 0 && <div className="profile-warnings" role="alert">{warnings.map((warning) => <span key={warning}>{warning}</span>)}</div>}<label>불변 설정 JSON<textarea aria-label="Profile 설정 JSON" value={snapshot} onChange={(event) => setSnapshot(event.target.value)} spellCheck={false} required /></label><div className="slack-settings-actions"><button className="primary" disabled={busy !== null}>{busy === "save" ? "저장 중…" : editingProfileId ? "새 version 저장" : "Draft 저장"}</button>{editingProfileId && <button type="button" onClick={() => setEditingProfileId(null)}>새 profile로 전환</button>}</div></form>}
    <div className="profile-list">{profiles.map((profile) => <section key={profile.id}><strong>{profile.name}</strong><small>{profile.taskKind} · {profile.status}{profile.activeVersion ? ` · 활성 v${profile.activeVersion}` : ""}</small>{profile.versions.map((version) => <div className="session-row" key={version.id}><span>v{version.version}{version.note ? ` · ${version.note}` : ""}</span><div className="slack-settings-actions"><button type="button" disabled={busy !== null} onClick={() => editVersion(profile, version)}>새 version 검토</button><button type="button" className="primary" disabled={busy !== null || profile.activeVersion === version.version} onClick={() => void activate(profile, version)}>{busy === `activate:${version.id}` ? "활성화 중…" : profile.activeVersion === version.version ? "활성" : "명시 활성화"}</button></div></div>)}</section>)}{!profiles.length && <span className="muted">저장된 profile이 없습니다. 분석 초안부터 만드세요.</span>}</div>
    {status && <span className="attachment-status" aria-live="polite">{status}</span>}
  </article>;
}

const emptyRemoteWorker = { name: "", hostname: "", port: 22, username: "wam_worker", workspaceRoot: "/srv/wam/projects", hostKey: "", privateKey: "", enabled: true };

// 관리자가 명시적으로 pin한 SSH host만 등록하고, 고정 capability 명령으로 호환성을 확인한다.
function RemoteWorkerSettingsCard(): React.ReactElement {
  const [hosts, setHosts] = useState<RemoteWorkerHost[]>([]);
  const [projects, setProjects] = useState<Json[]>([]);
  const [mappings, setMappings] = useState<RemoteWorkerMapping[]>([]);
  const [mappingProjectId, setMappingProjectId] = useState(0);
  const [mappingHostId, setMappingHostId] = useState("");
  const [mappingPath, setMappingPath] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyRemoteWorker);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  async function load(): Promise<void> {
    try {
      const [hostData, mappingData, projectData] = await Promise.all([api("/remote-workers"), api("/remote-worker-mappings"), api("/projects")]);
      setHosts(hostData.hosts || []); setMappings(mappingData.mappings || []); setProjects(projectData.projects || []);
    }
    catch (error: any) { setStatus(error?.message || "원격 worker 목록을 불러오지 못했습니다."); }
  }
  useEffect(() => { void load(); }, []);
  function change<K extends keyof typeof form>(key: K, value: (typeof form)[K]): void { setForm((current) => ({ ...current, [key]: value })); }
  function edit(host: RemoteWorkerHost): void {
    setEditingId(host.id);
    setForm({ name: host.name, hostname: host.hostname, port: host.port, username: host.username, workspaceRoot: host.workspaceRoot || "", hostKey: "", privateKey: "", enabled: host.enabled });
    setStatus("공개 host key와 private key는 바꿀 때만 다시 입력하세요.");
  }
  function reset(): void { setEditingId(null); setForm(emptyRemoteWorker); }
  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault(); setBusy("save"); setStatus(editingId ? "worker 설정을 저장하는 중…" : "worker를 등록하는 중…");
    const body: Record<string, unknown> = { name: form.name, hostname: form.hostname, port: form.port, username: form.username, workspaceRoot: form.workspaceRoot, enabled: form.enabled };
    if (form.hostKey) body.hostKey = form.hostKey;
    if (form.privateKey) body.privateKey = form.privateKey;
    try {
      const result = await api(editingId ? `/remote-workers/${encodeURIComponent(editingId)}` : "/remote-workers", { method: editingId ? "PUT" : "POST", body: JSON.stringify(body) });
      setHosts((current) => [...current.filter((host) => host.id !== result.host.id), result.host].sort((a, b) => a.name.localeCompare(b.name)));
      setStatus(editingId ? "worker 설정을 저장했습니다. 변경 후 다시 probe하세요." : "worker를 등록했습니다. 연결 probe로 호환성을 확인하세요.");
      reset();
    } catch (error: any) { setStatus(error?.message || "원격 worker 저장에 실패했습니다."); }
    finally { setBusy(null); }
  }
  async function probe(host: RemoteWorkerHost): Promise<void> {
    setBusy(`probe:${host.id}`); setStatus(`${host.name} capability를 확인하는 중…`);
    try {
      const result = await api(`/remote-workers/${encodeURIComponent(host.id)}/probe`, { method: "POST" });
      setHosts((current) => current.map((item) => item.id === host.id ? result.host : item));
      setStatus(`${host.name} worker가 ${result.host.lastLatencyMs}ms에 응답했습니다.`);
    } catch (error: any) { setStatus(error?.message || "원격 worker probe에 실패했습니다."); await load(); }
    finally { setBusy(null); }
  }
  async function remove(host: RemoteWorkerHost): Promise<void> {
    if (!window.confirm(`${host.name} 원격 worker 등록을 삭제할까요?`)) return;
    setBusy(`delete:${host.id}`); setStatus("원격 worker를 삭제하는 중…");
    try { await api(`/remote-workers/${encodeURIComponent(host.id)}`, { method: "DELETE" }); setHosts((current) => current.filter((item) => item.id !== host.id)); if (editingId === host.id) reset(); setStatus("원격 worker와 보관된 전용 key를 삭제했습니다."); }
    catch (error: any) { setStatus(error?.message || "원격 worker 삭제에 실패했습니다."); }
    finally { setBusy(null); }
  }
  async function saveMapping(event: React.FormEvent): Promise<void> {
    event.preventDefault(); setBusy("mapping"); setStatus("프로젝트 remote path를 연결하는 중…");
    try {
      const result = await api(`/projects/${mappingProjectId}/remote-worker-mapping`, { method: "PUT", body: JSON.stringify({ hostId: mappingHostId, remotePath: mappingPath, enabled: true }) });
      setMappings((current) => [...current.filter((item) => item.projectId !== result.mapping.projectId), result.mapping].sort((a, b) => String(a.projectName).localeCompare(String(b.projectName))));
      setMappingPath(""); setStatus("프로젝트 remote mapping을 저장했습니다. task 카드에서 capability를 명시 승인해 실행할 수 있습니다.");
    } catch (error: any) { setStatus(error?.message || "remote mapping 저장에 실패했습니다."); }
    finally { setBusy(null); }
  }
  async function removeMapping(mapping: RemoteWorkerMapping): Promise<void> {
    if (!window.confirm(`${mapping.projectName || `프로젝트 #${mapping.projectId}`} remote mapping을 삭제할까요?`)) return;
    setBusy(`mapping-delete:${mapping.id}`); setStatus("remote mapping을 삭제하는 중…");
    try { await api(`/projects/${mapping.projectId}/remote-worker-mapping`, { method: "DELETE" }); setMappings((current) => current.filter((item) => item.id !== mapping.id)); setStatus("remote mapping을 삭제했습니다."); }
    catch (error: any) { setStatus(error?.message || "remote mapping 삭제에 실패했습니다."); }
    finally { setBusy(null); }
  }
  const statusLabel: Record<RemoteWorkerHost["status"], string> = { unverified: "확인 전", ready: "준비됨", unreachable: "연결 실패", incompatible: "비호환" };
  return <article className="card remote-worker-card"><div className="card-top"><span>원격 worker · SSH host</span><span className={`settings-status ${hosts.some((host) => host.status === "ready") ? "ready" : ""}`}>{hosts.filter((host) => host.status === "ready").length}개 준비됨</span></div>
    <p className="muted one-time-login-description">고정 host key·전용 key·workspace root를 등록합니다. WAM은 임의 shell 대신 고정 capability probe와 승인된 task protocol만 실행하며 key 원문은 다시 표시하지 않습니다.</p>
    <form className="slack-settings-form remote-worker-form" onSubmit={save}>
      <label>Worker 이름<input value={form.name} maxLength={80} onChange={(event) => change("name", event.target.value)} required /></label>
      <div className="remote-worker-address"><label>Hostname 또는 IP<input value={form.hostname} maxLength={253} onChange={(event) => change("hostname", event.target.value)} required /></label><label>SSH port<input type="number" min={1} max={65535} value={form.port} onChange={(event) => change("port", Number(event.target.value))} required /></label></div>
      <label>SSH username<input value={form.username} maxLength={32} onChange={(event) => change("username", event.target.value)} required /></label>
      <label>Remote workspace root<input value={form.workspaceRoot} maxLength={1024} onChange={(event) => change("workspaceRoot", event.target.value)} placeholder="/srv/wam/projects" required /></label>
      <label>고정 SSH host public key<textarea value={form.hostKey} maxLength={4096} onChange={(event) => change("hostKey", event.target.value)} placeholder={editingId ? "기존 key 유지 (회전 시에만 입력)" : "ssh-ed25519 AAAA…"} required={!editingId} /></label>
      <label>전용 SSH private key<textarea className="remote-worker-secret" value={form.privateKey} maxLength={65536} autoComplete="new-password" onChange={(event) => change("privateKey", event.target.value)} placeholder={editingId ? "기존 key 유지 (회전 시에만 입력)" : "-----BEGIN OPENSSH PRIVATE KEY-----"} required={!editingId} /></label>
      <label className="idle-toggle"><input type="checkbox" checked={form.enabled} onChange={(event) => change("enabled", event.target.checked)} />이 worker 활성화</label>
      <div className="slack-settings-actions"><button className="primary" disabled={busy !== null}>{busy === "save" ? "저장 중…" : editingId ? "변경 저장" : "Worker 등록"}</button>{editingId && <button type="button" disabled={busy !== null} onClick={reset}>취소</button>}</div>
    </form>
    <div className="remote-worker-list" aria-label="원격 worker 목록">
      {hosts.map((host) => <section className="remote-worker-row" key={host.id}><div className="remote-worker-summary"><strong>{host.name}</strong><span className={`settings-status ${host.status === "ready" ? "ready" : ""}`}>{statusLabel[host.status]}</span><small>{host.username}@{host.hostname}:{host.port}</small><small>workspace: {host.workspaceRoot || "미설정"}</small><code>{host.hostKeyFingerprint}</code>{host.protocolVersion && <small>{host.protocolVersion} · worker {host.workerVersion} · {host.lastLatencyMs}ms</small>}{host.capabilities.length > 0 && <small>허용 capability: {host.capabilities.join(", ")}</small>}{host.lastError && <small className="remote-worker-error">{host.lastError}</small>}</div><div className="slack-settings-actions"><button type="button" disabled={busy !== null} onClick={() => edit(host)}>편집·key 회전</button><button type="button" className="primary" disabled={busy !== null || !host.enabled} onClick={() => void probe(host)}>{busy === `probe:${host.id}` ? "Probe 중…" : "연결 Probe"}</button><button type="button" disabled={busy !== null} onClick={() => void remove(host)}>삭제</button></div></section>)}
      {!hosts.length && <span className="muted">등록된 원격 worker가 없습니다.</span>}
    </div>
    <form className="remote-worker-mapping-form" onSubmit={saveMapping}>
      <strong>프로젝트 remote mapping</strong>
      <select aria-label="Mapping 프로젝트" value={mappingProjectId || ""} onChange={(event) => setMappingProjectId(Number(event.target.value))} required><option value="">프로젝트 선택</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
      <select aria-label="Mapping worker" value={mappingHostId} onChange={(event) => setMappingHostId(event.target.value)} required><option value="">Worker 선택</option>{hosts.filter((host) => host.enabled).map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}</select>
      <input aria-label="Remote project path" value={mappingPath} maxLength={1024} onChange={(event) => setMappingPath(event.target.value)} placeholder="/srv/wam/projects/my-project" required />
      <button className="primary" disabled={busy !== null}>{busy === "mapping" ? "연결 중…" : "Mapping 저장"}</button>
    </form>
    <div className="remote-worker-mappings">{mappings.map((mapping) => <div className="session-row" key={mapping.id}><div><strong>{mapping.projectName || `프로젝트 #${mapping.projectId}`} → {mapping.hostName || mapping.hostId}</strong><small>{mapping.remotePath}</small></div><button type="button" disabled={busy !== null} onClick={() => void removeMapping(mapping)}>삭제</button></div>)}{!mappings.length && <span className="muted">연결된 remote project가 없습니다.</span>}</div>
    {status && <span className="attachment-status" aria-live="polite">{status}</span>}
  </article>;
}

// 전체 DB와 WAM 관리 key를 하나의 passphrase 암호화 package로 만들고 offline 복구용으로 내려받는다.
function FullBackupCard(): React.ReactElement {
  const [backups, setBackups] = useState<FullBackupSummary[]>([]);
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  async function load(): Promise<void> {
    try { setBackups((await api("/admin/full-backups")).backups || []); }
    catch (error: any) { setStatus(error?.message || "전체 백업 목록을 불러오지 못했습니다."); }
  }
  useEffect(() => { void load(); }, []);
  async function create(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (passphrase.length < 16) { setStatus("백업 passphrase는 16자 이상이어야 합니다."); return; }
    if (passphrase !== confirmation) { setStatus("백업 passphrase 확인이 일치하지 않습니다."); return; }
    setBusy(true); setStatus("SQLite snapshot을 암호화하는 중…");
    try {
      const result = await api("/admin/full-backups", { method: "POST", body: JSON.stringify({ passphrase }) });
      setPassphrase(""); setConfirmation("");
      setBackups((current) => [result.backup, ...current.filter((item) => item.id !== result.backup.id)]);
      setStatus("암호화 백업을 만들었습니다. passphrase는 서버에 저장되지 않으므로 안전한 곳에 별도로 보관하세요.");
    } catch (error: any) { setStatus(error?.message || "전체 백업에 실패했습니다."); }
    finally { setBusy(false); }
  }
  async function download(backup: FullBackupSummary): Promise<void> {
    setStatus("백업 파일을 확인하는 중…");
    try {
      const response = await fetch(`/api/admin/full-backups/${encodeURIComponent(backup.id)}/download`);
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || `HTTP ${response.status}`);
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = `${backup.id}.wambackup`; anchor.click();
      URL.revokeObjectURL(url);
      setStatus("암호화 백업을 다운로드했습니다.");
    } catch (error: any) { setStatus(error?.message || "백업 다운로드에 실패했습니다."); }
  }
  async function remove(backup: FullBackupSummary): Promise<void> {
    if (!window.confirm("이 암호화 백업 파일을 삭제할까요? 다운로드 사본은 영향을 받지 않습니다.")) return;
    setBusy(true); setStatus("백업을 삭제하는 중…");
    try {
      await api(`/admin/full-backups/${encodeURIComponent(backup.id)}`, { method: "DELETE" });
      setBackups((current) => current.filter((item) => item.id !== backup.id));
      setStatus("서버의 백업 파일을 삭제했습니다.");
    } catch (error: any) { setStatus(error?.message || "백업 삭제에 실패했습니다."); }
    finally { setBusy(false); }
  }
  return <article className="card"><div className="card-top">전체 암호화 백업</div>
    <p className="muted one-time-login-description">프로젝트·프로필·일정·채팅 session mapping과 WAM 암호화 key를 묶습니다. 생성·다운로드·삭제 전에는 위 로그인 보안 카드에서 본인 확인이 필요합니다.</p>
    <form className="slack-settings-form" onSubmit={create}>
      <label>백업 passphrase<input type="password" autoComplete="new-password" minLength={16} maxLength={1024} value={passphrase} onChange={(event) => setPassphrase(event.target.value)} required /></label>
      <label>passphrase 확인<input type="password" autoComplete="new-password" minLength={16} maxLength={1024} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required /></label>
      <div className="slack-settings-actions"><button className="primary" disabled={busy}>{busy ? "암호화 중…" : "새 전체 백업"}</button></div>
    </form>
    <div className="session-list">
      {backups.map((backup) => <div className="session-row" key={backup.id}><div><strong>{sessionTime(backup.createdAt)}</strong><small>{(backup.sizeBytes / 1024 / 1024).toFixed(1)} MiB · 프로젝트 {backup.counts.projects ?? 0} · 채팅 {backup.counts.chats ?? 0}</small></div><div className="slack-settings-actions"><button type="button" disabled={busy} onClick={() => void download(backup)}>다운로드</button><button type="button" disabled={busy} onClick={() => void remove(backup)}>삭제</button></div></div>)}
      {!backups.length && <span className="muted">저장된 전체 백업이 없습니다.</span>}
    </div>
    <p className="muted idle-note">복구: 서버를 중지한 빈 설치에서 <code>WEB_AGENT_MANAGER_BACKUP_PASSPHRASE=... npm run backup:restore -- --backup 파일 --data-dir 빈경로</code></p>
    {status && <span className="attachment-status" aria-live="polite">{status}</span>}
  </article>;
}

export function SettingsView({ user, slack, ntfy, notificationPermission, notificationsSupported, temporary, onEnableNotifications, onOpenCliAuth, onSignedOut }: SettingsViewProps): React.ReactElement {
  return <section className="content-grid settings-page">
    <div className="section-head"><div><span className="eyebrow">환경과 연결</span><h2>설정</h2><p>알림 채널, 계정 인증과 운영 정책을 한곳에서 관리합니다.</p></div></div>
    <div className="settings-grid">
      <BrowserNotificationCard permission={notificationPermission} supported={notificationsSupported} onEnable={onEnableNotifications} />
      <SessionSecurityCard temporary={temporary} onSignedOut={onSignedOut} />
      {!temporary && <MfaSettingsCard onSignedOut={onSignedOut} />}
      {user.role === "admin" && <article className="card cli-settings-card"><div className="card-top">CLI 계정·인증</div><div className="settings-card-copy"><KeyRound size={22} aria-hidden="true" /><p>Codex·Claude·Grok·GitHub 로그인과 공급자별 계정 슬롯, 사용량 조회 범위를 관리합니다.</p></div><div className="slack-settings-actions"><button type="button" className="primary" onClick={onOpenCliAuth}>CLI 인증 관리</button></div></article>}
      {user.role === "admin" && <SlackSettingsCard connected={!!slack?.enabled} />}
      {user.role === "admin" && <NtfySettingsCard connected={!!ntfy?.enabled} />}
      {user.role === "admin" && <WebhookSettingsCard />}
      {user.role === "admin" && <IdleChatSettingsCard />}
      {user.role === "admin" && <OneTimeLoginCard />}
      {user.role === "admin" && <FullBackupCard />}
      {user.role === "admin" && <ProjectProfileSettingsCard />}
      {user.role === "admin" && <StructuredShadowReadinessCard />}
      {user.role === "admin" && <RemoteWorkerSettingsCard />}
    </div>
  </section>;
}
