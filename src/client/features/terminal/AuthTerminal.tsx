import React, { useEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { copyText } from "../../lib/clipboard";

const URL_PATTERN = /https?:\/\/[^\s\x1b]+/g;

// 선택한 CLI 로그인 PTY를 xterm으로 표시하고 발견한 인증 URL을 새 탭으로 연다.
// 선택 공급자의 공식 인증 PTY를 xterm으로 표시하고 로그인 링크를 추적한다.
export function AuthTerminal({ provider, socket }: { provider: string; socket: WebSocket | null }): React.ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const recentOutput = useRef("");
  const [loginUrl, setLoginUrl] = useState("");

  useEffect(() => {
    if (!host.current) return;
    const instance = new Terminal({ cols: 120, rows: 32, cursorBlink: true, fontSize: 13, theme: { background: "#0b1110", foreground: "#d8e5de" } });
    instance.open(host.current);
    // focus를 안 주면 브라우저가 이 터미널의 숨은 입력창에 키 입력(Ctrl+V 붙여넣기 포함)을 안 보낼 수
    // 있다(메인 TerminalPanel은 이미 focus()를 호출해서 겪지 않는 문제).
    instance.focus();
    terminal.current = instance;
    instance.onData((data) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "auth_terminal_input", provider, data }));
    });
    // 이 터미널은 Ctrl+C 선택 복사 처리가 없어, 인증 코드를 선택하고 Ctrl+C를 누르면 복사 대신
    // 그대로 SIGINT로 전달돼 진행 중인 로그인이 취소됐다(메인 TerminalPanel과 같은 예외 처리).
    instance.attachCustomKeyEventHandler((event) => {
      if (event.type === "keydown" && event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "c" && instance.hasSelection()) {
        copyText(instance.getSelection());
        return false;
      }
      return true;
    });
    return () => { instance.dispose(); terminal.current = null; };
  }, [provider, socket]);

  useEffect(() => {
    if (!socket) return;
    const receive = (event: MessageEvent): void => {
      try {
        const message = JSON.parse(event.data);
        if (message.type !== "auth_terminal_output" || message.payload.provider !== provider) return;
        const data = String(message.payload.data || "");
        terminal.current?.write(data);
        recentOutput.current = `${recentOutput.current}${data}`.slice(-8_000);
        const urls = recentOutput.current.match(URL_PATTERN);
        if (urls?.length) setLoginUrl(urls.at(-1)!.replace(/[),.;]+$/, ""));
      } catch {
        // 인증 터미널과 무관한 비 JSON 프레임은 무시한다.
      }
    };
    socket.addEventListener("message", receive);
    return () => socket.removeEventListener("message", receive);
  }, [socket, provider]);

  useEffect(() => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    terminal.current?.clear();
    recentOutput.current = "";
    setLoginUrl("");
    socket.send(JSON.stringify({ type: "subscribe_auth_terminal", provider }));
  }, [provider, socket]);

  return <div className="auth-terminal-wrap">
    {loginUrl && <a className="auth-login-link" href={loginUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} />인증 페이지 열기</a>}
    <div className="auth-terminal" ref={host} />
  </div>;
}
