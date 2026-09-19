import { expect, test } from "@playwright/test";

test("hunk 승인과 라인 주석 재전송은 지연 중 즉시 피드백하고 한 번만 요청한다", async ({ page }) => {
  test.setTimeout(60_000);
  const decisions: Array<{ body: Record<string, unknown>; csrf: string | null }> = [];
  const comments: Array<{ body: Record<string, unknown>; key: string | null; csrf: string | null }> = [];
  let reviewOpen = true;
  const diff = `diff --git a/src/app.ts b/src/app.ts
index 3367afd..3e75765 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,2 @@
-old value
+new value
 context`;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    if (pathname === "/api/projects/1/git/review" && route.request().method() === "GET") {
      await route.fulfill({ json: reviewOpen ? { diff, files: [{ path: "src/app.ts", fileHash: "b".repeat(64), decisionAllowed: true, reason: null, hunks: [{ id: "a".repeat(64), oldStart: 1, newStart: 1, header: "@@ -1,2 +1,2 @@" }] }] } : { diff: "", files: [{ path: "src/app.ts", fileHash: "0".repeat(64), decisionAllowed: false, reason: "unstaged 변경 없음", hunks: [] }] } });
      return;
    }
    if (pathname === "/api/projects/1/git/hunks/decision" && route.request().method() === "POST") {
      decisions.push({ body: JSON.parse(route.request().postData() || "{}"), csrf: route.request().headers()["x-csrf-token"] ?? null });
      await new Promise((resolve) => setTimeout(resolve, 350)); reviewOpen = false;
      await route.fulfill({ json: { diff: "", files: [] } }); return;
    }
    if (pathname === "/api/chats/11/messages" && route.request().method() === "POST") {
      comments.push({ body: JSON.parse(route.request().postData() || "{}"), key: route.request().headers()["idempotency-key"] ?? null, csrf: route.request().headers()["x-csrf-token"] ?? null });
      await new Promise((resolve) => setTimeout(resolve, 350));
      await route.fulfill({ status: 202, json: { accepted: true, replayed: false } }); return;
    }
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "review-admin", role: "admin", access_scope: "standard", last_project_id: 1, last_chat_id: 11 }, csrfToken: "review-csrf" },
      "/api/providers": { providers: [{ id: "codex", label: "Codex" }] },
      "/api/projects": { projects: [{ id: 1, name: "샘플", path: "/workspace/sample" }] },
      "/api/chats": { chats: [{ id: 11, project_id: 1, provider: "codex", status: "stopped", title: "리뷰 채팅" }] },
      "/api/chats/11/messages": { messages: [], hasMore: false },
      "/api/projects/1/git": { status: "## feature/review", commits: [], remotes: "" },
      "/api/projects/1/git/changes": { changes: [{ path: "src/app.ts", indexStatus: " ", worktreeStatus: "M" }] },
      "/api/projects/1/git/workspace": { branch: "feature/review", path: "/workspace/sample", mode: "shared", branches: [] },
      "/api/projects/1/git/workspaces": { workspaces: [{ path: "/workspace/sample", branch: "feature/review", main: true }] },
      "/api/projects/1/git/diff": { diff },
      "/api/usage": { usage: [] }, "/api/system": { latest: null }, "/api/runtime": {}, "/api/slack": { enabled: false }, "/api/ntfy": { enabled: false }, "/api/approvals": { approvals: [] },
    };
    await route.fulfill({ json: pathname in responses ? responses[pathname] : {} });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "GitHub", exact: true }).click();
  await page.getByRole("button", { name: /변경 파일 · 커밋/ }).click();
  await page.getByRole("checkbox", { name: /^app\.ts/ }).check();
  await expect(page.getByRole("heading", { name: "미결정 hunk 검토", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "승인·stage", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "src/app.ts new 1행에 주석", exact: true }).click();
  await page.getByLabel("라인 주석", { exact: true }).fill("이 이름을 더 명확하게 바꿔줘");
  const resend = page.getByRole("button", { name: "현재 채팅에 재전송", exact: true });
  const resendFeedbackMs = await resend.evaluate((button) => new Promise<number>((resolve) => {
    const startedAt = performance.now();
    const observer = new MutationObserver(() => { if ((button as HTMLButtonElement).disabled && button.textContent?.includes("재전송 중")) { observer.disconnect(); resolve(performance.now() - startedAt); } });
    observer.observe(button, { attributes: true, childList: true, subtree: true }); (button as HTMLButtonElement).click();
  }));
  expect(resendFeedbackMs).toBeLessThan(500);
  await expect(page.getByText("라인 주석을 prompt 원장으로", { exact: false })).toBeVisible();
  expect(comments).toHaveLength(1);
  expect(comments[0].key).toMatch(/^diff-comment-/);
  expect(comments[0].csrf).toBe("review-csrf");
  expect(String(comments[0].body.text)).toContain("File: src/app.ts\nLine: new 1\nHunk: " + "a".repeat(64));

  const accept = page.getByRole("button", { name: "승인·stage", exact: true });
  const decisionFeedbackMs = await accept.evaluate((button) => new Promise<number>((resolve) => {
    const startedAt = performance.now();
    const observer = new MutationObserver(() => { if ((button as HTMLButtonElement).disabled && button.textContent?.includes("처리 중")) { observer.disconnect(); resolve(performance.now() - startedAt); } });
    observer.observe(button, { attributes: true, childList: true, subtree: true }); (button as HTMLButtonElement).click();
  }));
  expect(decisionFeedbackMs).toBeLessThan(500);
  await expect(page.getByText("선택 hunk만 stage했습니다.", { exact: true })).toBeVisible();
  expect(decisions).toEqual([{ body: { path: "src/app.ts", fileHash: "b".repeat(64), hunkId: "a".repeat(64), decision: "accept", chatId: 11, worktree: null }, csrf: "review-csrf" }]);
  await expect(page.getByText("stage되지 않은 text hunk가 없습니다.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
