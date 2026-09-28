import { expect, test } from "@playwright/test";

// Android 앱이 알림을 누르면 호출하는 window.__webAgentManagerOpenChat__가 페이지를 다시 불러오지 않고
// 채팅만 바꾸는지 확인한다(#151). 전체 새로고침이면 심어 둔 표시값이 사라진다.
test("알림으로 채팅을 열면 새로고침 없이 같은·다른 프로젝트 채팅으로 이동한다", async ({ page }) => {
  await page.routeWebSocket("**/ws", () => undefined);
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    const chats1 = [
      { id: 11, project_id: 1, provider: "codex", status: "stopped", title: "첫 번째 채팅" },
      { id: 12, project_id: 1, provider: "claude", status: "stopped", title: "두 번째 채팅" },
    ];
    const chats2 = [{ id: 21, project_id: 2, provider: "codex", status: "stopped", title: "다른 프로젝트 채팅" }];
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "ui-test", role: "admin" }, csrfToken: "ui-test" },
      "/api/providers": { providers: [{ id: "codex", label: "Codex" }, { id: "claude", label: "Claude" }] },
      "/api/projects": { projects: [{ id: 1, name: "프로젝트 A", path: "/workspace/a" }, { id: 2, name: "프로젝트 B", path: "/workspace/b" }] },
      "/api/chats": { chats: url.searchParams.get("projectId") === "2" ? chats2 : chats1 },
      "/api/chats/21": { chat: chats2[0] },
      "/api/chats/11/messages": { messages: [{ id: "a", role: "assistant", kind: "text", content: "첫 번째 채팅 내용" }], hasMore: false },
      "/api/chats/12/messages": { messages: [{ id: "b", role: "assistant", kind: "text", content: "두 번째 채팅 내용" }], hasMore: false },
      "/api/chats/21/messages": { messages: [{ id: "c", role: "assistant", kind: "text", content: "다른 프로젝트 채팅 내용" }], hasMore: false },
      "/api/usage": { usage: [] }, "/api/system": { latest: null }, "/api/runtime": {}, "/api/slack": { enabled: false }, "/api/ntfy": { enabled: false }, "/api/approvals": { approvals: [] },
    };
    await route.fulfill({ json: pathname in responses ? responses[pathname] : {} });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?chat=11");
  await expect(page.getByText("첫 번째 채팅 내용")).toBeVisible();
  await page.evaluate(() => { (window as unknown as { __noReloadMarker: boolean }).__noReloadMarker = true; });
  expect(await page.evaluate(() => typeof window.__webAgentManagerOpenChat__)).toBe("function");

  await page.evaluate(() => window.__webAgentManagerOpenChat__!(12));
  await expect(page.getByText("두 번째 채팅 내용")).toBeVisible();
  await page.evaluate(() => window.__webAgentManagerOpenChat__!(21));
  await expect(page.getByText("다른 프로젝트 채팅 내용")).toBeVisible();

  expect(await page.evaluate(() => (window as unknown as { __noReloadMarker?: boolean }).__noReloadMarker)).toBe(true);
  expect(new URL(page.url()).searchParams.get("chat")).toBe("21");
});
