import React, { useEffect, useRef, useState } from "react";
import { Copy, ExternalLink, Send } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { copyText } from "../../lib/clipboard";

const URL_PATTERN = /https?:\/\/[^\s\x1b]+/g;
// ANSI 이스케이프(색상·커서 이동 등)를 제거한다. 원본 PTY 바이트를 그대로 정규식에 넣으면 코드
// 글자 사이에 스타일 코드가 섞여 매칭이 깨질 수 있다(실측: 기기 코드에 특수문자가 섞인 것처럼
// 보였던 원인).
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*(\x07|\x1b\\)/g, "");
}
// Codex 기기 코드는 정확한 글자 구성을 가정하지 않고, "Enter this one-time code" 라벨 바로
// 다음 줄의 토큰을 그대로 잡는다(형식이 바뀌어도 안 깨지게). 브라우저에 붙여넣어야 하는 값이라
// 복사 버튼으로 바로 클립보드에 담아준다.
const DEVICE_CODE_PATTERN = /one-time code[^\n]*\n\s*(\S+)/i;

// 선택한 CLI 로그인 PTY를 xterm으로 표시하고 발견한 인증 URL을 새 탭으로 연다.
// 선택 공급자의 공식 인증 PTY를 xterm으로 표시하고 로그인 링크를 추적한다.
export function AuthTerminal({ provider, socket }: { provider: string; socket: WebSocket | null }): React.ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const recentOutput = useRef("");
  const [loginUrl, setLoginUrl] = useState("");
  const [deviceCode, setDeviceCode] = useState("");
  const [pasteValue, setPasteValue] = useState("");
  const isClaude = provider.startsWith("claude");

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
        const codeMatch = stripAnsi(recentOutput.current).match(DEVICE_CODE_PATTERN);
        if (codeMatch) setDeviceCode(codeMatch[1]);
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
    setDeviceCode("");
    setPasteValue("");
    socket.send(JSON.stringify({ type: "subscribe_auth_terminal", provider }));
  }, [provider, socket]);

  // 별도 입력창에서 받은 텍스트를 터미널에 직접 타이핑한 것과 동일하게 전달한다. xterm 터미널에
  // 바로 붙여넣으면 화면에 아무 표시가 없어(가려지거나 에코가 없어) 제대로 입력됐는지 확인할 방법이
  // 없다는 실사용 보고로 추가함 — 이 입력창은 눈에 보이는 채로 입력·수정 후 확정해서 보낼 수 있다.
  function sendPaste(): void {
    if (!pasteValue.trim() || socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "auth_terminal_input", provider, data: `${pasteValue.trim()}\r` }));
    setPasteValue("");
  }

  return <div className="auth-terminal-wrap">
    {loginUrl && <a className="auth-login-link" href={loginUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} />인증 페이지 열기</a>}
    {deviceCode && (
      <button type="button" className="auth-device-code" onClick={() => copyText(deviceCode)} title="기기 코드 복사">
        <Copy size={14} />{deviceCode} 복사
      </button>
    )}
    <div className="auth-terminal" ref={host} />
    {isClaude && (
      <form
        className="auth-paste-form"
        onSubmit={(event) => { event.preventDefault(); sendPaste(); }}
      >
        <input
          type="text"
          className="auth-paste-input"
          placeholder="브라우저에서 받은 코드를 여기에 붙여넣고 전송하세요"
          value={pasteValue}
          onChange={(event) => setPasteValue(event.target.value)}
        />
        <button type="submit" disabled={!pasteValue.trim()}><Send size={14} />전송</button>
      </form>
    )}
  </div>;
}
