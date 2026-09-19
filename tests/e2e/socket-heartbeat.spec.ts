import { expect, test } from "@playwright/test";

// 목 API 응답 한 벌. 소켓 동작만 보면 되므로 화면이 뜨는 데 필요한 최소만 채운다.
const API_RESPONSES: Record<string, unknown> = {
  "/api/auth/me": { user: { id: 1, username: "ws-test", role: "admin", chat_view_mode: "chat" }, csrfToken: "ws-test" },
  "/api/providers": { providers: [{ id: "claude", label: "Claude", usageWindowId: "session", supportsPermissionMode: true }] },
  "/api/projects": { projects: [{ id: 1, name: "샘플 프로젝트", path: "/home/testuser/myagent" }] },
  "/api/usage": { usage: [] },
  "/api/system": { latest: null },
  "/api/runtime": { claude: "disabled" },
  "/api/slack": { enabled: false },
  "/api/approvals": { approvals: [] },
  "/api/chats": { chats: [] },
};

// 실제 브라우저에서 서버 하트비트에 응답하는지 확인한다. 모바일에서 연결이 조용히 죽는 문제(#54)의
// 감지가 성립하려면 클라이언트가 ping에 실제로 답해야 서버가 그 연결을 살아있다고 볼 수 있다.
test("서버 하트비트 ping에 pong으로 답한다", async ({ page }) => {
  const received: string[] = [];
  let sendPing: () => void = () => undefined;

  await page.routeWebSocket("**/ws", (webSocket) => {
    sendPing = () => webSocket.send(JSON.stringify({ type: "ping", payload: { at: Date.now() } }));
    webSocket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (typeof message.type === "string") received.push(message.type);
    });
  });

  await mockApi(page);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "운영 대시보드" })).toBeVisible();

  sendPing();
  await expect.poll(() => received.filter((type) => type === "pong").length, { timeout: 5_000 }).toBe(1);

  // 하트비트가 화면 상태를 건드리지 않아야 한다 — ping/pong은 연결 유지 신호일 뿐이다.
  await expect(page.getByRole("heading", { name: "운영 대시보드" })).toBeVisible();
});

// 목 API를 한 번에 걸어준다.
async function mockApi(page: import("@playwright/test").Page): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname in API_RESPONSES) {
      await route.fulfill({ json: API_RESPONSES[pathname] });
      return;
    }
    await route.fulfill({ json: {} });
  });
}

// 앱을 켜둔 채 대기하는 동안 소켓이 close 없이 죽으면, 서버 하트비트가 끊긴 걸 감시자가 알아채고
// 소켓을 새로 연결해야 한다(#54). 실제 70초를 기다리지 않도록 가상 시계로 시간을 돌린다.
test("하트비트가 끊기면 소켓을 새로 연결한다", async ({ page }) => {
  let connections = 0;
  await page.routeWebSocket("**/ws", () => { connections += 1; });
  await mockApi(page);
  await page.clock.install();

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "운영 대시보드" })).toBeVisible();
  await expect.poll(() => connections, { timeout: 5_000 }).toBe(1);

  // 서버 ping이 25초마다 오므로 이 정도 침묵은 정상이다.
  await page.clock.fastForward(30_000);
  await expect.poll(() => connections, { timeout: 2_000 }).toBe(1);

  // 한계를 넘긴 침묵은 죽은 연결로 보고 갈아끼워야 한다.
  await page.clock.fastForward(60_000);
  await expect.poll(() => connections, { timeout: 5_000 }).toBe(2);
});
