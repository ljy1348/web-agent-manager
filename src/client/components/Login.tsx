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

  useEffect(() => {
    void fetch("/api/auth/setup-status").then((response) => response.json()).then((data) => setSetupRequired(data.setupRequired === true)).catch(() => undefined).finally(() => setCheckingSetup(false));
  }, []);

  // 현재 입력값으로 일반 로그인 요청을 보내 상위 앱에 세션을 전달한다.
  async function login(): Promise<void> {
    const response = await fetch("/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    onLogin(data);
  }

  // 입력한 자격 증명으로 새 웹 세션을 만든다.
  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError("");
    try {
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
    }
  }

  if (checkingSetup) return <main className="login-shell"><div className="login-card"><h1>web-agent-manager</h1><p>초기 상태를 확인하고 있습니다.</p></div></main>;
  return <main className="login-shell">
    <form className="login-card" onSubmit={submit}>
      <div className="brand-mark">W</div><h1>web-agent-manager</h1><p>{setupRequired ? "첫 관리자 계정을 설정합니다." : "Codex와 Claude를 한 곳에서 관리합니다."}</p>
      <label>아이디<input value={username} onChange={(event) => setUsername(event.target.value)} autoFocus /></label>
      <label>비밀번호<input type="password" minLength={setupRequired ? 12 : undefined} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      {setupRequired && <label>비밀번호 확인<input type="password" minLength={12} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>}
      {error && <div className="error">{error}</div>}<button className="primary">{setupRequired ? "관리자 생성" : "로그인"}</button>
    </form>
  </main>;
}
