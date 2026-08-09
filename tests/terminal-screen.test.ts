import { describe, expect, it } from "vitest";
import { TerminalScreen } from "../src/server/services/terminal-screen";

describe("headless 터미널 화면", () => {
  it("ANSI 커서 이동을 적용한 현재 화면만 반환한다", async () => {
    const screen = new TerminalScreen({ cols: 20, rows: 3, scrollback: 10 });
    await new Promise<void>((resolve) => screen.write("첫 줄\r\n둘째 줄\r\n셋째 줄\r\n넷째 줄\u001b[1A\r교체", resolve));

    expect(screen.text()).toContain("첫 줄");
    expect(screen.visibleText()).not.toContain("첫 줄");
    expect(screen.visibleText()).toContain("교체 줄");
    screen.dispose();
  });

  it("새 클라이언트용 화면 초기화와 실제 커서 위치를 함께 반환한다", async () => {
    const screen = new TerminalScreen({ cols: 20, rows: 3, scrollback: 0 });
    await new Promise<void>((resolve) => screen.write("현재 화면\u001b[2;4H", resolve));

    const snapshot = screen.ansiSnapshot();
    expect(snapshot).toContain("\u001b[2J\u001b[H현재 화면");
    expect(snapshot).toMatch(/\u001b\[2;4H$/);
    screen.dispose();
  });

  it("리사이즈한 행 수로 새 클라이언트 스냅샷을 만든다", () => {
    const screen = new TerminalScreen({ cols: 20, rows: 3, scrollback: 0 });

    screen.resize(20, 5);

    expect(screen.ansiSnapshot().split("\r\n")).toHaveLength(5);
    screen.dispose();
  });
});
