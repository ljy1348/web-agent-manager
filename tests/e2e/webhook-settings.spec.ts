import { expect, test } from "@playwright/test";

test("signed webhook 설정과 테스트는 지연을 즉시 알리고 URL·secret을 다시 렌더링하지 않는다", async ({ page }) => {
  const updates: Array<{ body: Record<string, unknown>; csrf: string | null }> = [];
  let tests = 0;
  let configured = false;
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (pathname === "/api/admin/webhook-settings" && method === "GET") {
      await route.fulfill({ json: configured
        ? { enabled: true, endpointConfigured: true, signingSecretConfigured: true, endpointHost: "hooks.example.com" }
        : { enabled: false, endpointConfigured: false, signingSecretConfigured: false, endpointHost: null } }); return;
    }
    if (pathname === "/api/admin/webhook-settings" && method === "PUT") {
      updates.push({ body: JSON.parse(route.request().postData() || "{}"), csrf: route.request().headers()["x-csrf-token"] ?? null });
      await new Promise((resolve) => setTimeout(resolve, 350)); configured = true;
      await route.fulfill({ json: { enabled: true, endpointConfigured: true, signingSecretConfigured: true, endpointHost: "hooks.example.com" } }); return;
    }
    if (pathname === "/api/webhook/test" && method === "POST") {
      tests += 1; await new Promise((resolve) => setTimeout(resolve, 350));
      await route.fulfill({ json: { sent: true } }); return;
    }
    if (pathname === "/api/auth/sessions") { await route.fulfill({ json: { sessions: [], hasMore: false } }); return; }
    if (pathname === "/api/auth/mfa") { await route.fulfill({ json: { enabled: false, recoveryCodesRemaining: 0 } }); return; }
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "webhook-admin", role: "admin", access_scope: "standard" }, csrfToken: "webhook-csrf", temporary: false },
      "/api/providers": { providers: [] }, "/api/projects": { projects: [], defaultPath: "/workspace" }, "/api/usage": { usage: [] },
      "/api/system": { latest: null }, "/api/runtime": {}, "/api/slack": { enabled: false }, "/api/ntfy": { enabled: false }, "/api/approvals": { approvals: [] },
      "/api/admin/slack-settings": { botTokenConfigured: false, channelId: null }, "/api/admin/ntfy-settings": { topic: null, serverUrl: "https://ntfy.sh" },
      "/api/admin/idle-chat-settings": { enabled: true, timeoutHours: 24 }, "/api/admin/full-backups": { backups: [] }, "/api/remote-workers": { hosts: [] },
    };
    await route.fulfill({ json: pathname in responses ? responses[pathname] : {} });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "더보기", exact: true }).click();
  await page.getByRole("dialog", { name: "더보기" }).getByRole("button", { name: /설정/ }).click();
  const card = page.locator(".webhook-settings-card");
  await expect(card.getByText("Signed outbound webhook", { exact: true })).toBeVisible();

  const endpoint = "https://hooks.example.com/DO-NOT-RENDER-ENDPOINT?token=DO-NOT-RENDER-ENDPOINT";
  const secret = "DO-NOT-RENDER-SIGNING-SECRET-0123456789";
  await card.getByLabel("Webhook endpoint", { exact: true }).fill(endpoint);
  await card.getByLabel("HMAC signing secret", { exact: true }).fill(secret);
  await card.getByLabel("전송 활성화", { exact: true }).check();
  const save = card.getByRole("button", { name: "저장", exact: true });
  const saveFeedbackMs = await save.evaluate((button) => new Promise<number>((resolve) => {
    const startedAt = performance.now();
    const observer = new MutationObserver(() => {
      if ((button as HTMLButtonElement).disabled && button.textContent?.includes("저장 중")) { observer.disconnect(); resolve(performance.now() - startedAt); }
    });
    observer.observe(button, { attributes: true, childList: true, subtree: true });
    (button as HTMLButtonElement).click();
  }));
  expect(saveFeedbackMs).toBeLessThan(500);
  await expect(card.getByRole("button", { name: "저장 중…", exact: true })).toBeDisabled();
  await expect(card.getByText("Webhook 설정을 저장했습니다.", { exact: true })).toBeVisible();
  expect(updates).toEqual([{ body: { endpointUrl: endpoint, signingSecret: secret, enabled: true }, csrf: "webhook-csrf" }]);
  await expect(card.getByLabel("Webhook endpoint", { exact: true })).toHaveValue("");
  await expect(card.getByLabel("HMAC signing secret", { exact: true })).toHaveValue("");
  await expect(card).toContainText("등록 host: hooks.example.com");
  expect(await page.locator("body").textContent()).not.toContain("DO-NOT-RENDER-ENDPOINT");
  expect(await page.locator("body").textContent()).not.toContain("DO-NOT-RENDER-SIGNING-SECRET");

  const send = card.getByRole("button", { name: "테스트 전송", exact: true });
  const testFeedbackMs = await send.evaluate((button) => new Promise<number>((resolve) => {
    const startedAt = performance.now();
    const observer = new MutationObserver(() => {
      if ((button as HTMLButtonElement).disabled && button.textContent?.includes("전송 중")) { observer.disconnect(); resolve(performance.now() - startedAt); }
    });
    observer.observe(button, { attributes: true, childList: true, subtree: true });
    (button as HTMLButtonElement).click();
  }));
  expect(testFeedbackMs).toBeLessThan(500);
  await expect(card.getByRole("button", { name: "전송 중…", exact: true })).toBeDisabled();
  await expect(card.getByText("서명된 테스트 webhook을 보냈습니다.", { exact: true })).toBeVisible();
  expect(tests).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
