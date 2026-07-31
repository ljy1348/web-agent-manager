import React, { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import type { Json } from "../../types";

// 서버 tmux 창의 고정 크기(session-manager.ts의 DEFAULT_COLS/DEFAULT_ROWS)와 반드시 같아야 한다.
// 커서 절대 위치 이동 같은 ANSI 시퀀스는 "행·열 번호"만 담고 있어, 클라이언트 xterm의 논리적 그리드
// 크기가 서버 tmux pane 크기와 다르면 같은 번호가 서로 다른 위치를 가리키게 된다. 열(가로)뿐 아니라
// 행(세로)도 마찬가지다 — tmux 자체 상태바처럼 절대 행 번호(예: "맨 아래 행")로 그려지는 요소가 있는데,
// 예전에 세로만 미리보기 박스 높이에 맞춰 fit()했더니 서버는 36행 기준으로 상태바를 그리고 클라이언트는
// 훨씬 적은 행수라 그 위치가 클라이언트 뷰포트 밖으로 밀려나면서 상태바 줄이 계속 새로 쌓여 보였다.
// 그래서 행도 열과 마찬가지로 fit() 없이 서버와 같은 값으로 고정하고, 박스보다 큰 내용은 가로·세로
// 스크롤(styles.css의 .terminal)로 본다.
const TERMINAL_COLS = 256;
const TERMINAL_ROWS = 36;

// HTTPS가 아닌 LAN 접속 등 비보안 컨텍스트에서는 navigator.clipboard 자체가 없어, 옛 방식(임시
// textarea + execCommand)으로 대체한다.
function copyText(text: string): void {
  if (navigator.clipboard?.writeText) { void navigator.clipboard.writeText(text).catch(() => undefined); return; }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try { document.execCommand("copy"); } catch { /* 복사 실패는 조용히 무시 */ }
  document.body.removeChild(area);
}

// 선택한 채팅의 실제 tmux PTY를 xterm 화면과 WebSocket으로 연결한다.
export function TerminalPanel({ chat, socket }: { chat: Json | null; socket: WebSocket | null }): React.ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const instance = new Terminal({ cols: TERMINAL_COLS, rows: TERMINAL_ROWS, cursorBlink: true, fontSize: 13, theme: { background: "#0b1110", foreground: "#d8e5de" } });
    instance.open(host.current);
    terminal.current = instance;
    // Ctrl+C는 원래 SIGINT로 보내야 하지만, 텍스트를 선택해둔 상태에서는(원본 터미널 로그를 복사하고
    // 싶은 경우가 많음) 그 선택을 복사하는 쪽이 자연스럽다. 선택이 있을 때만 가로채 복사하고 xterm의
    // 기본 처리(SIGINT 전송)를 막는다 — 선택이 없으면 평소대로 인터럽트로 동작한다.
    instance.attachCustomKeyEventHandler((event) => {
      if (event.type === "keydown" && event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "c" && instance.hasSelection()) {
        copyText(instance.getSelection());
        return false;
      }
      return true;
    });
    instance.onData((data) => { if (chat && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "terminal_input", chatId: chat.id, data })); });
    return () => { instance.dispose(); terminal.current = null; };
  }, [chat?.id, socket]);

  useEffect(() => {
    if (!chat || !socket || socket.readyState !== WebSocket.OPEN) return;
    terminal.current?.clear();
    socket.send(JSON.stringify({ type: "subscribe_terminal", chatId: chat.id }));
  }, [chat?.id, socket]);

  useEffect(() => {
    if (!socket) return;
    const receive = (event: MessageEvent): void => {
      const message = JSON.parse(event.data);
      if (message.type === "terminal_output" && message.payload.chatId === chat?.id) terminal.current?.write(message.payload.data);
    };
    socket.addEventListener("message", receive);
    return () => socket.removeEventListener("message", receive);
  }, [socket, chat?.id]);

  return <div className="terminal" ref={host}>{!chat && <span>채팅을 선택하세요.</span>}</div>;
}
