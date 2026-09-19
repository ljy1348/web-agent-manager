import { expect, test } from "@playwright/test";

test("PR check를 polling하고 조건부 자동 merge를 head pin과 즉시 피드백으로 예약한다", async ({ page }) => {
  test.setTimeout(45_000);
  let detailRequests = 0;
  let autoEnabled = false;
  const mutations: Array<{ body: Record<string, unknown>; csrf: string | null }> = [];
  const head = "a".repeat(40);
  const detail = () => ({
    number: 7, title: "조건부 병합 QA", state: "OPEN", url: "https://github.example/pr/7", body: "설명", headRefName: "feature/qa", baseRefName: "main",
    headRefOid: head, isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED", autoMergeEnabled: autoEnabled,
    checkSummary: { state: "pending", totalCount: 3, passedCount: 2, pendingCount: 1, failedCount: 0, unavailableCount: 0 }, comments: [], reviews: [], updatedAt: "2026-09-13T00:00:00Z",
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url()); const pathname = url.pathname; const method = route.request().method();
    if (pathname === "/api/projects/1/github/pr/7" && method === "GET") {
      detailRequests += 1; await new Promise((resolve) => setTimeout(resolve, 350));
      await route.fulfill({ json: { pullRequest: detail(), cachedAt: new Date().toISOString() } }); return;
    }
    if (pathname === "/api/projects/1/github/pr/7/auto-merge" && method === "POST") {
      mutations.push({ body: JSON.parse(route.request().postData() || "{}"), csrf: route.request().headers()["x-csrf-token"] ?? null });
      await new Promise((resolve) => setTimeout(resolve, 350)); autoEnabled = true;
      await route.fulfill({ json: { pullRequest: detail() } }); return;
    }
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "merge-admin", role: "admin", access_scope: "standard" }, csrfToken: "merge-csrf" },
      "/api/providers": { providers: [] }, "/api/projects": { projects: [{ id: 1, name: "QA", path: "/workspace/qa" }] }, "/api/chats": { chats: [] },
      "/api/usage": { usage: [] }, "/api/system": { latest: null }, "/api/runtime": {}, "/api/slack": { enabled: false }, "/api/ntfy": { enabled: false }, "/api/approvals": { approvals: [] },
      "/api/projects/1/git": { status: "", commits: [], remotes: "" }, "/api/projects/1/git/changes": { changes: [] },
      "/api/projects/1/github": { repository: { url: "https://github.example/x/y", nameWithOwner: "x/y" }, issues: [], pullRequests: [{ number: 7, title: "조건부 병합 QA", state: "OPEN", headRefName: "feature/qa", baseRefName: "main", updatedAt: "2026-09-13T00:00:00Z" }] },
      "/api/projects/1/github/pr/7/diff": { diff: "" },
    };
    await route.fulfill({ json: pathname in responses ? responses[pathname] : {} });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "GitHub", exact: true }).click();
  await page.locator(".git-tabs").getByRole("button", { name: "깃허브", exact: true }).click();
  await page.getByRole("button", { name: "PR", exact: true }).click();
  await page.getByText("#7 조건부 병합 QA").click();
  const monitor = page.getByLabel("PR check 모니터링");
  await expect(monitor).toContainText("check 진행 중");
  await expect(monitor).toContainText("2 통과 · 1 대기 · 0 실패 · 0 판정 불가");
  await expect(monitor).toContainText(`head ${head.slice(0, 12)}`);

  await page.evaluate(() => { window.confirm = () => true; });
  const armButton = page.getByRole("button", { name: "조건부 자동 merge", exact: true });
  const feedbackMs = await armButton.evaluate((button) => new Promise<number>((resolve) => {
    const startedAt = performance.now();
    const observer = new MutationObserver(() => { if ((button as HTMLButtonElement).disabled) { observer.disconnect(); resolve(performance.now() - startedAt); } });
    observer.observe(button, { attributes: true }); (button as HTMLButtonElement).click();
  }));
  expect(feedbackMs).toBeLessThan(500);
  await expect(page.getByText("조건부 자동 merge를 예약하는 중…", { exact: true })).toBeVisible();
  await expect(monitor).toContainText("조건부 자동 merge 예약됨");
  expect(mutations).toEqual([{ body: { enabled: true, expectedHeadSha: head, method: "squash", deleteBranch: true, confirm: true }, csrf: "merge-csrf" }]);

  const afterMutationReads = detailRequests;
  await expect.poll(() => detailRequests, { timeout: 20_000 }).toBeGreaterThan(afterMutationReads);
  expect(mutations).toHaveLength(1);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
