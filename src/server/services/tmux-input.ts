import { spawnSync } from "node:child_process";

interface TmuxResult {
  status: number | null;
  stderr?: string | Buffer;
}

// tmux 명령 실패를 사용자가 이해할 수 있는 오류로 변환한다.
function assertTmuxSuccess(result: TmuxResult, fallback: string): void {
  if (result.status === 0) return;
  const message = typeof result.stderr === "string" ? result.stderr.trim() : result.stderr?.toString().trim();
  throw new Error(message || fallback);
}

// 프롬프트를 브래킷 붙여넣기로 보내 TUI가 빠른 키 입력 burst로 오인하지 않게 한다.
export function pastePromptToTmux(tmuxName: string, text: string): void {
  const bufferName = `web_agent_manager_prompt_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const load = spawnSync("tmux", ["load-buffer", "-b", bufferName, "-"], { input: text, encoding: "utf8" });
  assertTmuxSuccess(load, "tmux 입력 버퍼를 만들지 못했습니다.");
  try {
    const paste = spawnSync("tmux", ["paste-buffer", "-p", "-t", tmuxName, "-b", bufferName], { encoding: "utf8" });
    assertTmuxSuccess(paste, "tmux 입력 버퍼를 붙여 넣지 못했습니다.");
  } finally {
    spawnSync("tmux", ["delete-buffer", "-b", bufferName], { stdio: "ignore" });
  }
}

// tmux pane에 실제 Enter 키 이벤트를 보낸다.
export function sendTmuxEnter(tmuxName: string): void {
  const result = spawnSync("tmux", ["send-keys", "-t", tmuxName, "Enter"], { encoding: "utf8" });
  assertTmuxSuccess(result, "tmux에 Enter 키를 보내지 못했습니다.");
}

// tmux pane에 실제 Escape 키 이벤트를 보낸다. attach된 클라이언트 pty에 raw 0x1b 바이트를 직접 쓰면
// 클라이언트 쪽 이스케이프 시퀀스 파서(화살표·함수 키 등과 구분하기 위한)에 걸려 응답 생성이나 실행
// 중인 도구를 실제로는 중단시키지 못하는 경우가 있었다. tmux의 이름 있는 키 전송은 서버 쪽에서
// 곧바로 처리되어 실제로 중단이 확인됐다(Bash 도구 실행 중 Escape로 "Interrupted" 확인).
export function sendTmuxEscape(tmuxName: string): void {
  const result = spawnSync("tmux", ["send-keys", "-t", tmuxName, "Escape"], { encoding: "utf8" });
  assertTmuxSuccess(result, "tmux에 Escape 키를 보내지 못했습니다.");
}

// tmux pane에 실제 Backspace 키 이벤트를 count번 보낸다.
export function sendTmuxBackspace(tmuxName: string, count: number): void {
  if (count <= 0) return;
  const result = spawnSync("tmux", ["send-keys", "-t", tmuxName, "-N", String(count), "BSpace"], { encoding: "utf8" });
  assertTmuxSuccess(result, "tmux에 Backspace 키를 보내지 못했습니다.");
}

// tmux pane에 실제 Shift+Tab 키 이벤트를 보낸다. Claude Code CLI는 이 키로 기본(매번 권한 요청)·
// auto-accept edits·plan mode를 순환한다. raw 이스케이프 시퀀스를 pty에 직접 쓰면 다른 이름 있는
// 키들과 마찬가지로 클라이언트 파서에 걸려 CLI에 전달되지 않을 수 있어 tmux 이름 있는 키로 보낸다.
export function sendTmuxShiftTab(tmuxName: string): void {
  const result = spawnSync("tmux", ["send-keys", "-t", tmuxName, "BTab"], { encoding: "utf8" });
  assertTmuxSuccess(result, "tmux에 Shift+Tab 키를 보내지 못했습니다.");
}

// tmux pane에 실제 왼쪽 화살표 키 이벤트를 보낸다.
export function sendTmuxLeft(tmuxName: string): void {
  const result = spawnSync("tmux", ["send-keys", "-t", tmuxName, "Left"], { encoding: "utf8" });
  assertTmuxSuccess(result, "tmux에 왼쪽 화살표 키를 보내지 못했습니다.");
}

// tmux pane에 실제 오른쪽 화살표 키 이벤트를 보낸다.
export function sendTmuxRight(tmuxName: string): void {
  const result = spawnSync("tmux", ["send-keys", "-t", tmuxName, "Right"], { encoding: "utf8" });
  assertTmuxSuccess(result, "tmux에 오른쪽 화살표 키를 보내지 못했습니다.");
}

// tmux pane 기록(스크롤백)을 lines만큼 위(양수)·아래(음수)로 이동시키고, 이동 후에도 copy-mode에
// 남아 있는지를 돌려준다. 웹 터미널은 tmux attach 클라이언트라 xterm 자체 스크롤백이 비어 있어,
// 실제 CLI에서처럼 이전 내역을 보려면 tmux의 copy-mode를 대신 움직여야 한다. `-e`로 진입하면 맨
// 아래까지 되돌아왔을 때 tmux가 알아서 copy-mode를 빠져나간다.
export function scrollTmuxHistory(tmuxName: string, lines: number): boolean {
  if (!lines) return isTmuxCopyMode(tmuxName);
  // 이미 최신 화면인데 "더 아래로"를 요청하면 아무것도 하지 않는다. 여기서 copy-mode에 새로 들어가면
  // 화면만 기록 보기로 바뀌어 오히려 실시간 화면에서 벗어난다.
  if (lines < 0 && !isTmuxCopyMode(tmuxName)) return false;
  const enter = spawnSync("tmux", ["copy-mode", "-e", "-t", tmuxName], { encoding: "utf8" });
  assertTmuxSuccess(enter, "tmux 기록 보기로 전환하지 못했습니다.");
  const command = lines > 0 ? "scroll-up" : "scroll-down";
  // 아래로 내려가다 맨 아래에 닿으면 tmux(-e)가 스스로 copy-mode를 끝내므로, 그 직후의 이동 명령은
  // "not in a mode"로 실패하는 게 정상이다. 실패를 오류로 올리지 않고 현재 상태만 알려준다.
  spawnSync("tmux", ["send-keys", "-X", "-t", tmuxName, "-N", String(Math.abs(lines)), command], { stdio: "ignore" });
  return isTmuxCopyMode(tmuxName);
}

// 해당 pane이 지금 copy-mode(기록 보기) 상태인지 확인한다.
export function isTmuxCopyMode(tmuxName: string): boolean {
  const result = spawnSync("tmux", ["display-message", "-p", "-t", tmuxName, "#{pane_in_mode}"], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() === "1";
}

// 기록 보기를 끝내고 실시간 화면으로 되돌린다. copy-mode가 아니면 조용히 무시한다.
export function exitTmuxCopyMode(tmuxName: string): void {
  spawnSync("tmux", ["send-keys", "-X", "-t", tmuxName, "cancel"], { stdio: "ignore" });
}

// tmux 창을 웹 xterm과 같은 논리 그리드 크기로 맞춘다.
export function resizeTmuxWindow(tmuxName: string, cols: number, rows: number): void {
  const result = spawnSync("tmux", ["resize-window", "-t", tmuxName, "-x", String(cols), "-y", String(rows)], { encoding: "utf8" });
  assertTmuxSuccess(result, "tmux 터미널 크기를 바꾸지 못했습니다.");
}

// tmux pane에 짧은 리터럴 키 입력을 보낸다.
export function sendTmuxText(tmuxName: string, text: string): void {
  if (!text) return;
  const result = spawnSync("tmux", ["send-keys", "-t", tmuxName, "-l", "--", text], { encoding: "utf8" });
  assertTmuxSuccess(result, "tmux에 텍스트 키 입력을 보내지 못했습니다.");
}
