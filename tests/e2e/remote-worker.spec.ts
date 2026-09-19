import { expect, test } from "@playwright/test";

test("원격 worker 등록과 probe는 지연을 즉시 알리고 secret을 다시 렌더링하지 않는다", async ({ page }) => {
  const createRequests: Array<{ body: Record<string, unknown>; csrf: string | null }> = [];
  let probeRequests = 0;
  const baseHost = {
    id: "worker-qa-1", name: "QA worker", hostname: "worker.example.test", port: 2222, username: "wam_worker", workspaceRoot: "/srv/wam/projects",
    hostKeyFingerprint: "SHA256:qa-fingerprint", keyConfigured: true, enabled: true, status: "unverified",
    protocolVersion: null, workerVersion: null, capabilities: [], lastLatencyMs: null, lastError: null, lastProbedAt: null,
  };
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (pathname === "/api/remote-workers" && method === "GET") { await route.fulfill({ json: { hosts: [] } }); return; }
    if (pathname === "/api/remote-worker-mappings" && method === "GET") { await route.fulfill({ json: { mappings: [] } }); return; }
    if (pathname === "/api/remote-workers" && method === "POST") {
      createRequests.push({ body: JSON.parse(route.request().postData() || "{}"), csrf: route.request().headers()["x-csrf-token"] ?? null });
      await new Promise((resolve) => setTimeout(resolve, 350));
      await route.fulfill({ status: 201, json: { host: baseHost } }); return;
    }
    if (pathname === "/api/remote-workers/worker-qa-1/probe" && method === "POST") {
      probeRequests += 1;
      await new Promise((resolve) => setTimeout(resolve, 350));
      await route.fulfill({ json: { host: { ...baseHost, status: "ready", protocolVersion: "wam-worker/v1", workerVersion: "1.4.0", capabilities: ["test", "verify"], lastLatencyMs: 418, lastProbedAt: "2026-09-13T00:00:00Z" } } }); return;
    }
    if (pathname === "/api/auth/sessions") { await route.fulfill({ json: { sessions: [], hasMore: false } }); return; }
    if (pathname === "/api/auth/mfa") { await route.fulfill({ json: { enabled: false, recoveryCodesRemaining: 0 } }); return; }
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "worker-admin", role: "admin", access_scope: "standard" }, csrfToken: "worker-csrf", temporary: false },
      "/api/providers": { providers: [] }, "/api/projects": { projects: [], defaultPath: "/workspace" }, "/api/usage": { usage: [] },
      "/api/system": { latest: null }, "/api/runtime": {}, "/api/slack": { enabled: false }, "/api/ntfy": { enabled: false }, "/api/approvals": { approvals: [] },
      "/api/admin/slack-settings": { botTokenConfigured: false, channelId: null }, "/api/admin/ntfy-settings": { topic: null, serverUrl: "https://ntfy.sh" },
      "/api/admin/idle-chat-settings": { enabled: true, timeoutHours: 24 }, "/api/admin/full-backups": { backups: [] },
    };
    await route.fulfill({ json: pathname in responses ? responses[pathname] : {} });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "더보기", exact: true }).click();
  await page.getByRole("dialog", { name: "더보기" }).getByRole("button", { name: /설정/ }).click();
  await expect(page.getByText("원격 worker · SSH host", { exact: true })).toBeVisible();

  await page.getByLabel("Worker 이름", { exact: true }).fill("QA worker");
  await page.getByLabel("Hostname 또는 IP", { exact: true }).fill("worker.example.test");
  await page.getByLabel("SSH port", { exact: true }).fill("2222");
  await page.getByLabel("SSH username", { exact: true }).fill("wam_worker");
  await page.getByLabel("Remote workspace root", { exact: true }).fill("/srv/wam/projects");
  await page.getByLabel("고정 SSH host public key", { exact: true }).fill("ssh-ed25519 AAAATESTHOSTKEY");
  await page.getByLabel("전용 SSH private key", { exact: true }).fill("TEST-ONLY-PRIVATE-KEY-DO-NOT-RENDER");
  const createButton = page.getByRole("button", { name: "Worker 등록", exact: true });
  const createFeedbackMs = await createButton.evaluate((button) => new Promise<number>((resolve) => {
    const startedAt = performance.now();
    const observer = new MutationObserver(() => {
      if ((button as HTMLButtonElement).disabled && button.textContent?.includes("저장 중")) { observer.disconnect(); resolve(performance.now() - startedAt); }
    });
    observer.observe(button, { attributes: true, childList: true, subtree: true });
    (button as HTMLButtonElement).click();
  }));
  expect(createFeedbackMs).toBeLessThan(500);
  await expect(page.getByRole("button", { name: "저장 중…", exact: true })).toBeDisabled();
  const row = page.locator(".remote-worker-row").filter({ hasText: "QA worker" });
  await expect(row).toContainText("SHA256:qa-fingerprint");
  expect(createRequests).toEqual([{ body: { name: "QA worker", hostname: "worker.example.test", port: 2222, username: "wam_worker", workspaceRoot: "/srv/wam/projects", enabled: true, hostKey: "ssh-ed25519 AAAATESTHOSTKEY", privateKey: "TEST-ONLY-PRIVATE-KEY-DO-NOT-RENDER" }, csrf: "worker-csrf" }]);
  await expect(page.getByLabel("전용 SSH private key", { exact: true })).toHaveValue("");
  expect(await page.locator("body").textContent()).not.toContain("TEST-ONLY-PRIVATE-KEY-DO-NOT-RENDER");

  const probeButton = row.getByRole("button", { name: "연결 Probe", exact: true });
  const probeFeedbackMs = await probeButton.evaluate((button) => new Promise<number>((resolve) => {
    const startedAt = performance.now();
    const observer = new MutationObserver(() => {
      if ((button as HTMLButtonElement).disabled && button.textContent?.includes("Probe 중")) { observer.disconnect(); resolve(performance.now() - startedAt); }
    });
    observer.observe(button, { attributes: true, childList: true, subtree: true });
    (button as HTMLButtonElement).click();
  }));
  expect(probeFeedbackMs).toBeLessThan(500);
  await expect(row.getByRole("button", { name: "Probe 중…", exact: true })).toBeDisabled();
  await expect(row).toContainText("wam-worker/v1 · worker 1.4.0 · 418ms");
  await expect(row).toContainText("허용 capability: test, verify");
  expect(probeRequests).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
