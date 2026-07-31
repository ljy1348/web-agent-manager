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

// 긴 프롬프트를 tmux 버퍼로 붙여 넣어 현재 pane 입력창에 안전하게 전달한다.
export function pastePromptToTmux(tmuxName: string, text: string): void {
  const bufferName = `web_agent_manager_prompt_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const load = spawnSync("tmux", ["load-buffer", "-b", bufferName, "-"], { input: text, encoding: "utf8" });
  assertTmuxSuccess(load, "tmux 입력 버퍼를 만들지 못했습니다.");
  try {
    const paste = spawnSync("tmux", ["paste-buffer", "-t", tmuxName, "-b", bufferName], { encoding: "utf8" });
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

// tmux pane에 짧은 리터럴 키 입력을 보낸다.
export function sendTmuxText(tmuxName: string, text: string): void {
  if (!text) return;
  const result = spawnSync("tmux", ["send-keys", "-t", tmuxName, "-l", "--", text], { encoding: "utf8" });
  assertTmuxSuccess(result, "tmux에 텍스트 키 입력을 보내지 못했습니다.");
}
