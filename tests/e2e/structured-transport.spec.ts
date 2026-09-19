import { expect, test } from "@playwright/test";

test("app-server 후보 채팅은 느린 ACK 중에도 즉시 반응하고 TUI 전용 제어를 숨긴다", async ({ page }) => {
  const chat = {
    id: 71,
    project_id: 1,
    provider: "codex",
    account_id: 1,
    status: "running",
    title: "구조화 후보 실사용 QA",
    model: "gpt-6",
    busy: 0,
    interactive_transport: "app_server",
    transport_state: "active",
    transport_cohort: "qa-limited-20260913",
  };
  let messagePosts = 0;
  let lastIdempotencyKey = "";

  await page.routeWebSocket("**/ws", () => undefined);
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/chats/71/messages" && request.method() === "POST") {
      messagePosts += 1;
      lastIdempotencyKey = request.headers()["idempotency-key"] ?? "";
      expect(request.postDataJSON()).toEqual({ text: "느린 응답에서도 한 번만 보내줘" });
      await new Promise((resolve) => setTimeout(resolve, 350));
      await route.fulfill({ status: 202, json: {
        accepted: true,
        replayed: false,
        task: { id: "task-structured", state: "running" },
        command: { id: "command-structured", state: "delivered" },
      } });
      return;
    }
    if (pathname === "/api/chats/71/messages") {
      await route.fulfill({ json: { messages: [{
        id: "assistant-existing",
        role: "assistant",
        kind: "text",
        content: "구조화 세션이 준비됐습니다.",
        createdAt: "2026-09-13T00:00:00.000Z",
      }], hasMore: false } });
      return;
    }
    if (pathname === "/api/chats" || pathname === "/api/chats/71") {
      await route.fulfill({ json: pathname === "/api/chats" ? { chats: [chat] } : { chat } });
      return;
    }
    if (pathname === "/api/auth/last-session" && request.method() === "POST") {
      await route.fulfill({ json: { lastProjectId: 1, lastChatId: 71 } });
      return;
    }
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "qa-admin", role: "admin", chat_view_mode: "terminal", last_project_id: 1, last_chat_id: 71 }, csrfToken: "qa-csrf" },
      "/api/providers": { providers: [{ id: "codex", label: "Codex", supportsSessionRename: true, supportsPermissionMode: true, usageWindowId: "weekly" }] },
      "/api/providers/capabilities": { providers: [{ provider: "codex", structuredSession: true, interactiveTransport: "limited_candidate" }] },
      "/api/projects": { projects: [{ id: 1, name: "QA project", path: "/workspace/qa" }] },
      "/api/usage": { usage: [] },
      "/api/system": { latest: null },
      "/api/runtime": { codex: "codex test" },
      "/api/slack": { enabled: false },
      "/api/ntfy": { enabled: false },
      "/api/approvals": { approvals: [] },
      "/api/security/deployment": { issues: [] },
      "/api/agent-accounts": { accounts: [{ id: 1, provider: "codex", label: "QA A" }, { id: 2, provider: "codex", label: "QA B" }] },
      "/api/projects/1/session-backups": { backups: [] },
      "/api/models/codex": { options: { provider: "codex", models: [{ index: "1", label: "gpt-6", current: true }], efforts: [{ id: "high", label: "high", current: true }] } },
      "/api/chats/71/current-task": { task: null, verifications: [] },
    };
    await route.fulfill({ json: pathname in responses ? responses[pathname] : {} });
  });

  await page.goto("/?tab=chat&project=1&chat=71");
  await expect(page.getByText("app-server 후보", { exact: true })).toBeVisible();
  await expect(page.locator(".conversation")).toBeVisible();
  await expect(page.locator(".terminal-panel")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "터미널 모드", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "세션 종료", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "채팅 이름 변경" })).toHaveCount(0);
  await expect(page.getByLabel("이 채팅의 인증 계정")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "모델 적용", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "모드 전환", exact: true })).toHaveCount(0);

  const composer = page.locator(".composer textarea");
  await composer.fill("느린 응답에서도 한 번만 보내줘");
  const feedbackMs = await page.getByRole("button", { name: "전송", exact: true }).evaluate((element) => new Promise<number>((resolve) => {
    const startedAt = performance.now();
    const observer = new MutationObserver(() => {
      if (!document.querySelector(".busy-indicator")) return;
      observer.disconnect();
      resolve(performance.now() - startedAt);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    (element as HTMLButtonElement).click();
    window.setTimeout(() => { observer.disconnect(); resolve(5_000); }, 5_000);
  }));
  expect(feedbackMs).toBeLessThan(500);
  await expect(page.getByText("느린 응답에서도 한 번만 보내줘", { exact: true })).toBeVisible();
  await expect.poll(() => messagePosts).toBe(1);
  expect(lastIdempotencyKey.length).toBeGreaterThan(20);
  await page.waitForTimeout(500);
  expect(messagePosts).toBe(1);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.locator(".workspace").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});
