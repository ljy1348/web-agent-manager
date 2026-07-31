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
});
