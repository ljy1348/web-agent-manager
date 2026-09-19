import { expect, test } from "@playwright/test";

test("remote task dispatch는 명시 확인·멱등 키·즉시 피드백으로 한 번만 실행하고 상태를 갱신한다", async ({ page }) => {
  const dispatchRequests: Array<{ body: Record<string, unknown>; key: string | null; csrf: string | null }> = [];
  let refreshRequests = 0;
  let state = "queued";
  const task = { id: "task-remote-ui", project_id: 1, project_name: "샘플 프로젝트", chat_id: 4, chat_title: "원격 검증", state: "running", goal: "원격 테스트 확인", activityKind: "active", acceptanceCriteria: [], checkpoints: [] };
  const dispatch = () => ({ id: "local-dispatch-1", taskId: task.id, mappingId: "mapping-1", hostId: "host-1", hostName: "QA worker", projectName: "샘플 프로젝트", capability: "verify", state, remoteDispatchId: "remote-run-1", summary: state === "completed" ? "all checks passed" : "verification queued", lastError: null, lastLatencyMs: 410 });
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (pathname === `/api/tasks/${task.id}/remote-dispatches` && method === "GET") {
      await route.fulfill({ json: { mapping: { id: "mapping-1", projectId: 1, projectName: "샘플 프로젝트", hostId: "host-1", hostName: "QA worker", remotePath: "/srv/wam/projects/sample", enabled: true, hostStatus: "ready", capabilities: ["test", "verify"] }, dispatches: [] } }); return;
    }
    if (pathname === `/api/tasks/${task.id}/remote-dispatches` && method === "POST") {
      dispatchRequests.push({ body: JSON.parse(route.request().postData() || "{}"), key: route.request().headers()["idempotency-key"] ?? null, csrf: route.request().headers()["x-csrf-token"] ?? null });
      await new Promise((resolve) => setTimeout(resolve, 350));
      await route.fulfill({ status: 202, json: { dispatch: dispatch(), replayed: false } }); return;
    }
    if (pathname === `/api/tasks/${task.id}/remote-dispatches/local-dispatch-1/refresh` && method === "POST") {
      refreshRequests += 1; await new Promise((resolve) => setTimeout(resolve, 350)); state = "completed";
      await route.fulfill({ json: { dispatch: dispatch() } }); return;
    }
    if (pathname === "/api/task-board") {
      await route.fulfill({ json: { columns: { working: [task], needs_input: [], verifying: [], failed: [], completed: [], scheduled: [] }, limits: [] } }); return;
    }
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "remote-admin", role: "admin", access_scope: "standard" }, csrfToken: "remote-csrf", temporary: false },
      "/api/providers": { providers: [] }, "/api/projects": { projects: [{ id: 1, name: "샘플 프로젝트", path: "/workspace/sample" }], defaultPath: "/workspace" },
      "/api/chats": { chats: [] }, "/api/usage": { usage: [] }, "/api/system": { latest: null }, "/api/runtime": {}, "/api/slack": { enabled: false }, "/api/ntfy": { enabled: false }, "/api/approvals": { approvals: [] },
    };
    await route.fulfill({ json: pathname in responses ? responses[pathname] : {} });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?tab=tasks");
  const card = page.locator(".task-board-card").filter({ hasText: "원격 테스트 확인" });
  await expect(card).toBeVisible();
  await card.getByText("Remote worker dispatch", { exact: true }).click();
  await expect(card.getByText("QA worker · /srv/wam/projects/sample", { exact: true })).toBeVisible();
  await card.getByLabel("Remote capability").selectOption("verify");
  page.once("dialog", (dialog) => dialog.accept());
  const button = card.getByRole("button", { name: "확인 후 원격 실행", exact: true });
  const feedbackMs = await button.evaluate((element) => new Promise<number>((resolve) => {
    const startedAt = performance.now();
    const observer = new MutationObserver(() => {
      if ((element as HTMLButtonElement).disabled && element.textContent?.includes("전달 중")) { observer.disconnect(); resolve(performance.now() - startedAt); }
    });
    observer.observe(element, { attributes: true, childList: true, subtree: true });
    (element as HTMLButtonElement).click();
  }));
  expect(feedbackMs).toBeLessThan(500);
  await expect(card.getByRole("button", { name: "전달 중…", exact: true })).toBeDisabled();
  await expect(card.getByText("Verify · queued", { exact: true })).toBeVisible();
  expect(dispatchRequests).toHaveLength(1);
  expect(dispatchRequests[0].body).toEqual({ capability: "verify" });
  expect(dispatchRequests[0].key).toMatch(/^[0-9a-f-]{36}$/);
  expect(dispatchRequests[0].csrf).toBe("remote-csrf");

  const refresh = card.getByRole("button", { name: "상태 확인", exact: true });
  const refreshFeedbackMs = await refresh.evaluate((element) => new Promise<number>((resolve) => {
    const startedAt = performance.now();
    const observer = new MutationObserver(() => {
      if ((element as HTMLButtonElement).disabled && element.textContent?.includes("확인 중")) { observer.disconnect(); resolve(performance.now() - startedAt); }
    });
    observer.observe(element, { attributes: true, childList: true, subtree: true });
    (element as HTMLButtonElement).click();
  }));
  expect(refreshFeedbackMs).toBeLessThan(500);
  await expect(card.getByText("Verify · completed", { exact: true })).toBeVisible();
  await expect(card.getByText("all checks passed", { exact: true })).toBeVisible();
  expect(refreshRequests).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
