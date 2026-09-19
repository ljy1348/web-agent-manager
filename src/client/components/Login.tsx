import React, { useEffect, useState } from "react";
import type { Json } from "../types";

// 로그인 폼을 렌더링하고 성공한 웹 세션을 상위 앱에 전달한다.
export function Login({ onLogin }: { onLogin: (data: Json) => void }): React.ReactElement {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [setupRequired, setSetupRequired] = useState(false);
  const [checkingSetup, setCheckingSetup] = useState(true);
  const [mode, setMode] = useState<"password" | "one-time">("password");
  const [oneTimeCode, setOneTimeCode] = useState("");
  const [mfaChallenge, setMfaChallenge] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void fetch("/api/auth/setup-status").then((response) => response.json()).then((data) => setSetupRequired(data.setupRequired === true)).catch(() => undefined).finally(() => setCheckingSetup(false));
  }, []);

  // 현재 입력값으로 일반 로그인 요청을 보내 상위 앱에 세션을 전달한다.
  async function login(): Promise<void> {
    if (mfaChallenge) {
      const response = await fetch("/api/auth/login/mfa", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ challengeToken: mfaChallenge, code: mfaCode }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      onLogin(data);
      return;
    }
    const response = await fetch("/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    if (response.status === 202 && data.mfaRequired) {
      setMfaChallenge(data.challengeToken);
      setPassword("");
      return;
    }
    onLogin(data);
  }

  // 관리자가 발급한 8자리 코드를 일반 사용자 임시 세션으로 교환한다.
  async function oneTimeLogin(): Promise<void> {
    const response = await fetch("/api/auth/one-time-login", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: oneTimeCode }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    onLogin(data);
  }

  // 입력한 자격 증명으로 새 웹 세션을 만든다.
  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      if (!setupRequired && mode === "one-time") {
        await oneTimeLogin();
        return;
      }
      if (setupRequired) {
        if (password !== confirmPassword) throw new Error("비밀번호 확인이 일치하지 않습니다.");
        const setupResponse = await fetch("/api/auth/setup", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }),
        });
        const setupData = await setupResponse.json();
        if (!setupResponse.ok) throw new Error(setupData.error);
        setSetupRequired(false);
      }
      await login();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "로그인 실패");
    } finally {
      setSubmitting(false);
    }
  }

  if (checkingSetup) return <main className="login-shell"><div className="login-card"><h1>web-agent-manager</h1><p>초기 상태를 확인하고 있습니다.</p></div></main>;
  return <main className="login-shell">
    <form className="login-card" onSubmit={submit}>
      <div className="brand-mark">W</div><h1>web-agent-manager</h1><p>{setupRequired ? "첫 관리자 계정을 설정합니다." : "Codex와 Claude를 한 곳에서 관리합니다."}</p>
      {!setupRequired && !mfaChallenge && <div className="login-mode" role="tablist" aria-label="로그인 방식">
        <button type="button" role="tab" aria-selected={mode === "password"} className={mode === "password" ? "active" : ""} onClick={() => { setMode("password"); setError(""); }}>계정 로그인</button>
        <button type="button" role="tab" aria-selected={mode === "one-time"} className={mode === "one-time" ? "active" : ""} onClick={() => { setMode("one-time"); setError(""); }}>일회용 코드</button>
      </div>}
      {!mfaChallenge && (setupRequired || mode === "password") && <>
        <label>아이디<input value={username} onChange={(event) => setUsername(event.target.value)} autoFocus /></label>
        <label>비밀번호<input type="password" minLength={setupRequired ? 12 : undefined} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      </>}
      {!mfaChallenge && !setupRequired && mode === "one-time" && <label>8자리 코드<input className="one-time-code-input" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{8}" maxLength={8} value={oneTimeCode} onChange={(event) => setOneTimeCode(event.target.value.replace(/\D/g, "").slice(0, 8))} autoFocus placeholder="00000000" /></label>}
      {mfaChallenge && <><label>인증 앱 코드 또는 복구 코드<input className="one-time-code-input mfa-login-code" inputMode="text" autoComplete="one-time-code" maxLength={64} value={mfaCode} onChange={(event) => setMfaCode(event.target.value.slice(0, 64))} autoFocus /></label><p className="one-time-login-note">인증 앱의 6자리 코드나 저장해 둔 일회용 복구 코드를 입력하세요.</p><button type="button" className="link-button" onClick={() => { setMfaChallenge(""); setMfaCode(""); setError(""); }}>계정 로그인으로 돌아가기</button></>}
      {setupRequired && <label>비밀번호 확인<input type="password" minLength={12} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>}
      {!mfaChallenge && !setupRequired && mode === "one-time" && <p className="one-time-login-note">관리자가 발급한 코드는 한 번만 사용할 수 있으며, 로그인은 1시간 동안 유지됩니다.</p>}
      {error && <div className="error">{error}</div>}<button className="primary" disabled={submitting}>{submitting ? "확인 중…" : mfaChallenge ? "2단계 인증" : setupRequired ? "관리자 생성" : mode === "one-time" ? "임시 로그인" : "로그인"}</button>
    </form>
  </main>;
}
