import * as HeadlessModule from "@xterm/headless";

const headless = (HeadlessModule as unknown as { default?: typeof HeadlessModule }).default ?? HeadlessModule;

// ANSI TUI 출력을 실제 터미널 화면과 스크롤백 텍스트로 재구성한다.
export class TerminalScreen {
  private readonly terminal: InstanceType<typeof headless.Terminal>;

  // 화면 용도에 맞는 크기와 스크롤백으로 headless 터미널을 생성한다.
  constructor(options: { cols?: number; rows?: number; scrollback?: number } = {}) {
    this.terminal = new headless.Terminal({
      allowProposedApi: true,
      cols: options.cols ?? 120,
      rows: options.rows ?? 40,
      scrollback: options.scrollback ?? 2_000,
    });
  }

  // PTY 출력 조각을 순서대로 터미널 에뮬레이터에 반영한다.
  write(data: string, callback?: () => void): void {
    this.terminal.write(data, callback);
  }

  // 현재 버퍼의 공백이 아닌 줄을 하나의 파싱용 문자열로 반환한다.
  text(): string {
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let index = 0; index < buffer.length; index += 1) {
      const line = buffer.getLine(index)?.translateToString(true).trimEnd();
      if (line?.trim()) lines.push(line);
    }
    return lines.join("\n");
  }

  // 스크롤백을 제외하고 현재 보이는 행만 파싱용 문자열로 반환한다.
  visibleText(): string {
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    const end = Math.min(buffer.length, buffer.viewportY + this.terminal.rows);
    for (let index = buffer.viewportY; index < end; index += 1) {
      const line = buffer.getLine(index)?.translateToString(true).trimEnd();
      if (line?.trim()) lines.push(line);
    }
    return lines.join("\n");
  }

  // 이전 조회 화면과 스크롤백을 제거한다.
  reset(): void {
    this.terminal.reset();
  }

  // 터미널 에뮬레이터 자원을 해제한다.
  dispose(): void {
    this.terminal.dispose();
  }
}
