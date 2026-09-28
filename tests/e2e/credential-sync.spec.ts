import { expect, test, type Page } from "@playwright/test";

const status = (provider: string, authenticated: boolean, extra: Record<string, unknown> = {}) => ({ provider, accountId: null, accountLabel: null, key: provider, installed: true, authenticated, running: false, exitCode: null, ...extra });

// 이 WAM은 모두 로그인, 대상은 gh·Claude 미로그인 상태. 원격 로그인 WebSocket은 구독 뒤 로그인 안내를 보낸다.
async function mockApi(page: Page) {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const subscriptions: string[] = [];
  let remoteGh = false;
  let claudeLogin = false;
  await page.routeWebSocket("**/ws?node=n1", (socket) => {
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type !== "subscribe_auth_terminal") return;
      subscriptions.push(message.provider);
      socket.send(JSON.stringify({ type: "auth_terminal_output", payload: { provider: message.provider, data: "Browser didn't open? Use the url below to sign in:\r\n\r\nhttps://claude.ai/oauth/authorize?code=true&client_id=fixture\r\n\r\nPaste code here if prompted > " } }));
    });
  });
  await page.routeWebSocket("**/ws", () => undefined);
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() !== "GET") requests.push({ method: request.method(), path: pathname, body: request.postDataJSON?.() ?? null });
    if (pathname === "/api/federation/nodes/n1/credentials/github/sync") { remoteGh = true; return route.fulfill({ json: { provider: "github", backedUp: true } }); }
    if (pathname === "/api/federation/nodes/n1/api/cli-auth") return route.fulfill({ json: { providers: [status("codex", true), status("claude", false, { running: claudeLogin }), status("grok", false, { installed: false }), status("github", remoteGh), status("claude", true, { accountId: 3, key: "claude:3" })] } });
    if (pathname === "/api/federation/nodes/n2/api/cli-auth") return route.fulfill({ status: 404, body: "<html>old</html>", contentType: "text/html" });
    if (/\/cli-auth\/claude\/(start|stop)$/.test(pathname)) claudeLogin = pathname.endsWith("start");
    if (/\/cli-auth\/[a-z]+\/(start|stop)$/.test(pathname)) return route.fulfill({ status: pathname.endsWith("start") ? 202 : 204, json: { accepted: true } });
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "layout-admin", role: "admin", access_scope: "standard" }, csrfToken: "layout-csrf", temporary: false },
      "/api/providers": { providers: [] }, "/api/projects": { projects: [], defaultPath: "/workspace" }, "/api/usage": { usage: [] },
      "/api/system": { latest: null }, "/api/runtime": {}, "/api/slack": { enabled: false }, "/api/ntfy": { enabled: false }, "/api/approvals": { approvals: [] },
      "/api/auth/sessions": { sessions: [], hasMore: false },
      "/api/cli-auth": { providers: [status("codex", true), status("claude", true), status("grok", true), status("github", true)] },
      "/api/federation/nodes": { nodes: [
        { id: "n1", name: "사무실 데스크톱(RTX 워크스테이션)", base_url: "http://192.168.0.21:14003", settings_mode: "follow", created_at: "2026-09-20", updated_at: "2026-09-26" },
        { id: "n2", name: "home-nas", base_url: "https://nas.example.com", settings_mode: "independent", created_at: "2026-09-22", updated_at: "2026-09-26" },
      ] },
    };
    await route.fulfill({ json: pathname in responses ? responses[pathname] : {} });
  });
  return { requests, subscriptions };
}

async function openCard(page: Page, mobile: boolean) {
  await page.goto("/");
  if (mobile) {
    await page.getByRole("button", { name: "더보기", exact: true }).click();
    await page.getByRole("dialog", { name: "더보기" }).getByRole("button", { name: /설정/ }).click();
  } else {
    await page.locator("header nav").getByRole("button", { name: "설정" }).click();
  }
  await page.getByRole("navigation", { name: "설정 항목" }).getByRole("button", { name: /인증 동기화/ }).click();
  const card = page.locator(".credential-sync-card");
  await expect(card).toBeVisible();
  return card;
}

const noHorizontalOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test("1440px: gh는 복사하고 Claude는 대상 컴퓨터 로그인 터미널을 원격으로 띄운다", async ({ page }) => {
  const { requests, subscriptions } = await mockApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const card = await openCard(page, false);
  page.on("dialog", (dialog) => void dialog.accept());
  await expect(card.getByText(/암호화되지 않은 HTTP/)).toBeVisible();
  const row = (label: string) => card.locator(".session-security-row", { hasText: label });
  await expect(row("GitHub (gh)")).toContainText("사무실 데스크톱(RTX 워크스테이션): 로그인 필요");
  await expect(row("Grok")).toContainText("CLI 없음");
  await expect(row("Claude").getByRole("button", { name: "복사해서 보내기" })).toHaveCount(0);
  await page.screenshot({ path: "artifacts/ui-credential-sync-1440.png", fullPage: true });

  await row("GitHub (gh)").getByRole("button", { name: "복사해서 보내기" }).click();
  await expect(card.getByText(/GitHub \(gh\) 로그인 정보를 복사했습니다/)).toBeVisible();
  await expect(row("GitHub (gh)")).toContainText("사무실 데스크톱(RTX 워크스테이션): 로그인됨");

  await row("Claude").getByRole("button", { name: "원격 로그인" }).click();
  await expect(card.getByText(/Claude 로그인 중/)).toBeVisible();
  await expect.poll(() => subscriptions).toEqual(["claude"]);
  await expect(card.locator(".xterm-rows")).toContainText("Paste code here", { timeout: 10_000 });
  expect(requests).toContainEqual({ method: "POST", path: "/api/federation/nodes/n1/api/cli-auth/claude/start", body: { accountId: null } });
  await page.screenshot({ path: "artifacts/ui-credential-sync-1440-login.png", fullPage: true });
  await card.getByRole("button", { name: "로그인 중단" }).click();
  expect(requests).toContainEqual({ method: "POST", path: "/api/federation/nodes/n1/api/cli-auth/claude/stop", body: { accountId: null } });
  expect(await noHorizontalOverflow(page)).toBe(true);

  // 옛 버전 WAM이면 카드만 안내하고 버튼을 막는다.
  await card.getByLabel("대상 컴퓨터").selectOption("n2");
  await expect(card.getByRole("alert")).toBeVisible();
  await expect(row("Codex").getByRole("button", { name: "복사해서 보내기" })).toBeDisabled();
});

test("390px: 공급자 행과 원격 로그인 터미널이 가로로 넘치지 않는다", async ({ page }) => {
  const { subscriptions } = await mockApi(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const card = await openCard(page, true);
  await card.locator(".session-security-row", { hasText: "Claude" }).getByRole("button", { name: "원격 로그인" }).click();
  await expect.poll(() => subscriptions).toEqual(["claude"]);
  // xterm은 화면 밖 터미널의 렌더링을 멈추므로 터미널을 화면 안으로 가져온 뒤 확인한다.
  await card.locator(".credential-remote-login .xterm").scrollIntoViewIfNeeded();
  await expect(card.locator(".xterm-rows")).toContainText("Paste code here", { timeout: 10_000 });
  await page.screenshot({ path: "artifacts/ui-credential-sync-mobile.png", fullPage: true });
  expect(await noHorizontalOverflow(page)).toBe(true);
});
