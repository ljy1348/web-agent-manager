import React, { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import type { Json } from "../../types";

// 서버 tmux 창의 고정 크기(session-manager.ts의 DEFAULT_COLS/DEFAULT_ROWS)와 반드시 같아야 한다.
// 커서 절대 위치 이동 같은 ANSI 시퀀스는 "행·열 번호"만 담고 있어, 클라이언트 xterm의 논리적 그리드
// 크기가 서버 tmux pane 크기와 다르면 같은 번호가 서로 다른 위치를 가리키게 된다. 열(가로)뿐 아니라
// 행(세로)도 마찬가지다 — tmux 자체 상태바처럼 절대 행 번호(예: "맨 아래 행")로 그려지는 요소가 있는데,
// 예전에 세로만 미리보기 박스 높이에 맞춰 fit()했더니 서버는 36행 기준으로 상태바를 그리고 클라이언트는
// 훨씬 적은 행수라 그 위치가 클라이언트 뷰포트 밖으로 밀려나면서 상태바 줄이 계속 새로 쌓여 보였다.
// 그래서 행도 열과 마찬가지로 fit() 없이 서버와 같은 값으로 고정하고, 박스보다 큰 내용은 가로·세로
// 스크롤(styles.css의 .terminal-host)로 본다.
const TERMINAL_COLS = 256;
const TERMINAL_ROWS = 36;

const MOBILE_PRIMARY_SHORTCUTS = [
  { label: "Esc", title: "Escape", data: "\u001b" },
  { label: "Tab", title: "Tab", data: "\t" },
  { label: "↑", title: "위쪽 방향키", data: "\u001b[A" },
  { label: "↓", title: "아래쪽 방향키", data: "\u001b[B" },
  { label: "Enter", title: "Enter", data: "\r" },
] as const;

const MOBILE_MORE_SHORTCUTS = [
  { label: "^C", title: "Ctrl+C · 현재 작업 중단", data: "\u0003" },
  { label: "^D", title: "Ctrl+D · 입력 종료", data: "\u0004" },
  { label: "⇧Tab", title: "Shift+Tab", data: "\u001b[Z" },
  { label: "←", title: "왼쪽 방향키", data: "\u001b[D" },
  { label: "→", title: "오른쪽 방향키", data: "\u001b[C" },
  { label: "PgUp", title: "Page Up · TUI 기록 위로", data: "\u001b[5~" },
  { label: "PgDn", title: "Page Down · TUI 기록 아래로", data: "\u001b[6~" },
] as const;

// Ctrl/Alt 잠금 뒤 모바일 키보드에서 누른 한 글자를 터미널 제어 시퀀스로 바꾼다.
function modifiedKey(key: string, control: boolean, alt: boolean): string | null {
  let result = key;
  if (control) {
    if (key === "Backspace") result = "\b";
    else if (key === "Enter") result = "\r";
    else if (key === " ") result = "\u0000";
    else if (key === "?") result = "\u007f";
    else if (key.length === 1) {
      const code = key.toUpperCase().charCodeAt(0);
      if (code < 64 || code > 95) return null;
      result = String.fromCharCode(code - 64);
    } else return null;
  } else if (key.length !== 1) return null;
  return alt ? `\u001b${result}` : result;
}

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
// 선택 채팅의 원본 PTY 출력을 xterm에 표시하고 키 입력과 크기를 동기화한다.
export function TerminalPanel({ chat, socket }: { chat: Json | null; socket: WebSocket | null }): React.ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const controlRef = useRef(false);
  const altRef = useRef(false);
  const [controlActive, setControlActive] = useState(false);
  const [altActive, setAltActive] = useState(false);
  controlRef.current = controlActive;
  altRef.current = altActive;

  // 현재 채팅의 PTY 입력 채널로 원시 터미널 바이트를 보낸다.
  function sendTerminalInput(data: string): void {
    if (chat && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "terminal_input", chatId: chat.id, data }));
  }

  // 모바일 보조 키를 전송하고 일회성 modifier 상태를 정리한다.
  function pressShortcut(data: string): void {
    sendTerminalInput(data);
    setControlActive(false);
    setAltActive(false);
  }

  useEffect(() => {
    const hostElement = host.current;
    if (!hostElement) return;
    const instance = new Terminal({ cols: TERMINAL_COLS, rows: TERMINAL_ROWS, cursorBlink: true, fontSize: 13, theme: { background: "#0b1110", foreground: "#d8e5de" } });
    instance.open(hostElement);
    instance.focus();
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
    instance.onData((data) => {
      const modified = controlRef.current || altRef.current ? modifiedKey(data, controlRef.current, altRef.current) : null;
      sendTerminalInput(modified ?? data);
      if (modified !== null) {
        setControlActive(false);
        setAltActive(false);
      }
    });
    // 모바일의 세로 스와이프를 xterm wheel로 바꿔 일반 스크롤백과 TUI mouse mode 양쪽에 전달한다.
    // 가로 스와이프는 256열 고정 화면을 좌우로 이동시키고, 모든 터치 이동은 바깥 문서로 전파하지 않는다.
    let disposed = false;
    let gesture: { id: number; x: number; y: number; axis: "x" | "y" | null; remainder: number } | null = null;
    const pointerDown = (event: PointerEvent): void => {
      if (event.pointerType !== "touch") return;
      gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, axis: null, remainder: 0 };
      try { hostElement.setPointerCapture?.(event.pointerId); } catch { /* 합성 이벤트 등 capture 불가 환경은 좌표 추적만 사용 */ }
    };
    const pointerMove = (event: PointerEvent): void => {
      if (disposed || !gesture || gesture.id !== event.pointerId) return;
      const deltaX = gesture.x - event.clientX;
      const deltaY = gesture.y - event.clientY;
      if (!gesture.axis && Math.max(Math.abs(deltaX), Math.abs(deltaY)) >= 6) gesture.axis = Math.abs(deltaY) >= Math.abs(deltaX) ? "y" : "x";
      if (!gesture.axis) return;
      event.preventDefault();
      event.stopPropagation();
      if (gesture.axis === "y") {
        if (instance.modes.mouseTrackingMode !== "none") {
          // TUI가 mouse mode를 켠 경우 xterm이 wheel을 실제 mouse protocol PTY 입력으로 바꾼다.
          hostElement.querySelector<HTMLElement>(".xterm")?.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: event.clientX, clientY: event.clientY, deltaMode: WheelEvent.DOM_DELTA_PIXEL, deltaY }));
        } else {
          gesture.remainder += deltaY;
          const rows = Math.trunc(gesture.remainder / Math.max(12, instance.options.fontSize ?? 13));
          if (rows) {
            const before = instance.buffer.active.viewportY;
            instance.scrollLines(rows);
            gesture.remainder -= rows * Math.max(12, instance.options.fontSize ?? 13);
            // 스크롤백이 없는 고정 화면에서는 잘린 행을 볼 수 있도록 호스트 자체를 이동한다.
            if (instance.buffer.active.viewportY === before) hostElement.scrollTop += deltaY;
          }
        }
      } else hostElement.scrollLeft += deltaX;
      gesture.x = event.clientX;
      gesture.y = event.clientY;
    };
    const pointerEnd = (event: PointerEvent): void => { if (gesture?.id === event.pointerId) gesture = null; };
    hostElement.addEventListener("pointerdown", pointerDown, true);
    hostElement.addEventListener("pointermove", pointerMove, { capture: true, passive: false });
    hostElement.addEventListener("pointerup", pointerEnd, true);
    hostElement.addEventListener("pointercancel", pointerEnd, true);
    return () => {
      disposed = true;
      gesture = null;
      hostElement.removeEventListener("pointerdown", pointerDown, true);
      hostElement.removeEventListener("pointermove", pointerMove, true);
      hostElement.removeEventListener("pointerup", pointerEnd, true);
      hostElement.removeEventListener("pointercancel", pointerEnd, true);
      instance.dispose();
      terminal.current = null;
    };
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

  useEffect(() => {
    if (!chat || !socket || socket.readyState !== WebSocket.OPEN) return;
    terminal.current?.clear();
    socket.send(JSON.stringify({ type: "subscribe_terminal", chatId: chat.id }));
  }, [chat?.id, socket]);

  return <div className="terminal-console">
    <div className="terminal-stage"><div className="terminal-host" ref={host}>{!chat && <span>채팅을 선택하세요.</span>}</div></div>
    <div className="terminal-mobile-toolbar" role="toolbar" aria-label="모바일 터미널 키">
      <button type="button" className="keyboard-key" onClick={() => terminal.current?.focus()} title="화면 키보드 열기">⌨ 키보드</button>
      <button type="button" aria-pressed={controlActive} onClick={() => { setControlActive((active) => !active); terminal.current?.focus(); }} title="다음 키에 Ctrl 적용">Ctrl</button>
      {MOBILE_PRIMARY_SHORTCUTS.map((item) => <button type="button" key={item.label} title={item.title} onClick={() => pressShortcut(item.data)}>{item.label}</button>)}
      <button type="button" aria-pressed={altActive} onClick={() => { setAltActive((active) => !active); terminal.current?.focus(); }} title="다음 키에 Alt 적용">Alt</button>
      {MOBILE_MORE_SHORTCUTS.map((item) => <button type="button" key={item.label} title={item.title} onClick={() => pressShortcut(item.data)}>{item.label}</button>)}
    </div>
    <span className="terminal-touch-hint">상하 스와이프: 기록 · 좌우 스와이프: 화면 이동 · 키 바도 좌우로 더 보기</span>
  </div>;
}
