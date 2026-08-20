import React, { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import type { Json } from "../../types";
import { copyText } from "../../lib/clipboard";

// 가로 폭을 바꾸면 기존 tmux 스크롤백의 줄바꿈이 깨질 수 있어 256열로 고정한다. 세로 행 수는
// 줄바꿈에 영향을 주지 않으므로 데스크톱 패널 높이로 계산해 서버 tmux와 함께 동기화한다.
const TERMINAL_COLS = 256;
const TERMINAL_DEFAULT_ROWS = 36;
const TERMINAL_MIN_ROWS = 12;
const TERMINAL_MAX_ROWS = 120;
const TERMINAL_FONT_SIZE = 13;
// 한 번의 관성 스크롤이 서버 tmux 명령 수십 번이 되지 않도록 짧게 모아서 보낸다.
const TERMINAL_SCROLL_FLUSH_MS = 60;

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

// 기본 글자 크기의 실제 셀 높이로 패널에 들어갈 논리 행 수를 계산한다.
function terminalRowsForHeight(instance: Terminal, hostElement: HTMLElement): number {
  // 모바일은 세로 공간이 키보드에 따라 자주 변하므로 기존 36행 + 스와이프 방식을 유지한다.
  if (window.matchMedia("(max-width: 700px)").matches) return TERMINAL_DEFAULT_ROWS;
  const rowsElement = hostElement.querySelector<HTMLElement>(".xterm-rows");
  const rendered = rowsElement?.getBoundingClientRect().height ?? 0;
  const style = window.getComputedStyle(hostElement);
  const available = hostElement.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - 2;
  if (rendered <= 0 || available <= 0) return instance.rows;
  const cellHeight = rendered / instance.rows;
  return Math.max(TERMINAL_MIN_ROWS, Math.min(TERMINAL_MAX_ROWS, Math.floor(available / cellHeight)));
}

// 선택한 채팅의 실제 tmux PTY를 xterm 화면과 WebSocket으로 연결한다.
// 선택 채팅의 원본 PTY 출력을 xterm에 표시하고 키 입력과 크기를 동기화한다.
export function TerminalPanel({ chat, socket }: { chat: Json | null; socket: WebSocket | null }): React.ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const terminalRows = useRef(TERMINAL_DEFAULT_ROWS);
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

  // 현재 채팅의 tmux 기록(copy-mode)을 lines만큼 옮기도록 요청한다. 양수가 과거 방향이다.
  function sendTerminalScroll(lines: number): void {
    if (chat && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "terminal_scroll", chatId: chat.id, lines }));
  }

  // 브라우저 xterm과 서버 tmux가 같은 세로 행 수를 사용하도록 리사이즈를 요청한다.
  function sendTerminalResize(rows: number): void {
    if (chat && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "terminal_resize", chatId: chat.id, rows }));
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
    // 스크롤백을 클라이언트에 쌓지 않는다(서버 TerminalScreen도 같은 `scrollback: 0` 계약이다).
    // 여기 쌓이는 건 tmux가 pane을 다시 그리며 흘려보낸 잔해라 진짜 CLI 기록이 아닌데, 그게 남아 있으면
    // 휠이 그 잔해 안에서만 맴돌아 실제 tmux 기록까지 닿지 못하고 타이핑해도 맨 아래로 돌아오지 않았다
    // (실제 서버·tmux·Chrome으로 재현). 기록은 tmux copy-mode 하나만 정본으로 쓴다.
    const instance = new Terminal({ cols: TERMINAL_COLS, rows: TERMINAL_DEFAULT_ROWS, scrollback: 0, cursorBlink: true, fontSize: TERMINAL_FONT_SIZE, lineHeight: 1, theme: { background: "#0b1110", foreground: "#d8e5de" } });
    instance.open(hostElement);
    instance.focus();
    terminal.current = instance;
    // 상자 크기가 바뀌면 글자 배율은 그대로 두고 실제 행 수를 패널 높이에 맞춘다.
    let resizeFrame = 0;
    const syncRows = (): void => {
      const rows = terminalRowsForHeight(instance, hostElement);
      if (rows === instance.rows) return;
      instance.resize(TERMINAL_COLS, rows);
      terminalRows.current = rows;
      sendTerminalResize(rows);
    };
    const scheduleResize = (): void => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(syncRows);
    };
    terminalRows.current = instance.rows;
    scheduleResize();
    const sizeObserver = new ResizeObserver(scheduleResize);
    sizeObserver.observe(hostElement);
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
    // 서버가 tmux 명령을 실행해야 하는 요청이라, 휠 한 번에 한 건씩 보내지 않고 잠깐 모아서 보낸다.
    let pendingScrollLines = 0;
    let scrollTimer: number | undefined;
    const flushScroll = (): void => {
      scrollTimer = undefined;
      const lines = Math.trunc(pendingScrollLines);
      pendingScrollLines -= lines;
      if (lines) sendTerminalScroll(lines);
    };
    const requestHistoryScroll = (lines: number): void => {
      pendingScrollLines += lines;
      if (scrollTimer === undefined) scrollTimer = window.setTimeout(flushScroll, TERMINAL_SCROLL_FLUSH_MS);
    };
    // 진짜 이전 내역은 tmux 기록에 있다. xterm 스크롤백은 0이지만 모바일의 잘린 고정 화면처럼 내부
    // viewport가 움직일 수 있는 경우를 먼저 처리하고, 끝에 닿으면 tmux 기록으로 이어간다. 그대로 두면
    // xterm이 휠을 위·아래 방향키로 바꿔 CLI에 보내거나, 휠이 바깥으로 새어 페이지가 밀렸다.
    instance.attachCustomWheelEventHandler((event) => {
      // TUI가 mouse mode를 켠 동안에는 휠이 그 TUI의 입력이다 — 우리가 가로채면 안 된다.
      if (instance.modes.mouseTrackingMode !== "none") return true;
      const buffer = instance.buffer.active;
      const scrollbackEnd = event.deltaY < 0 ? buffer.viewportY <= 0 : buffer.viewportY >= buffer.baseY;
      if (buffer.type === "normal" && buffer.baseY > 0 && !scrollbackEnd) return true;
      // 모바일처럼 고정 행이 상자보다 큰 경우에는 먼저 상자를 굴려 잘린 행을 보여준다.
      const overflow = hostElement.scrollHeight - hostElement.clientHeight;
      if (overflow > 0 && (event.deltaY < 0 ? hostElement.scrollTop > 0 : hostElement.scrollTop < overflow)) return true;
      const cell = Math.max(1, (hostElement.querySelector<HTMLElement>(".xterm-rows")?.getBoundingClientRect().height ?? 0) / instance.rows);
      const rows = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? event.deltaY * instance.rows
          : event.deltaY / cell;
      requestHistoryScroll(-rows);
      event.preventDefault();
      event.stopPropagation();
      return false;
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
            gesture.remainder -= rows * Math.max(12, instance.options.fontSize ?? TERMINAL_FONT_SIZE);
            if (instance.buffer.active.viewportY === before) {
              // 스크롤백이 없는 고정 화면에서는 먼저 잘린 행을 볼 수 있도록 호스트 자체를 이동하고,
              // 더 이동할 곳이 없으면 휠과 마찬가지로 tmux 기록(copy-mode)을 옮긴다.
              const overflow = hostElement.scrollHeight - hostElement.clientHeight;
              const movable = deltaY < 0 ? hostElement.scrollTop > 0 : hostElement.scrollTop < overflow;
              if (overflow > 0 && movable) hostElement.scrollTop += deltaY;
              else requestHistoryScroll(-rows);
            }
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
      cancelAnimationFrame(resizeFrame);
      sizeObserver.disconnect();
      if (scrollTimer !== undefined) clearTimeout(scrollTimer);
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
    const frame = requestAnimationFrame(() => {
      terminal.current?.clear();
      socket.send(JSON.stringify({ type: "subscribe_terminal", chatId: chat.id, rows: terminalRows.current }));
    });
    return () => cancelAnimationFrame(frame);
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
