import { expect, test, type Page } from "@playwright/test";

// 모바일 채팅 탭 위에 "에이전트 연동 필요" 안내가 있어도 입력창이 하단 탭바에 가리지 않아야 한다(#149).
async function mockChat(page: Page, integrationPending: boolean) {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "ui-test", role: "admin" }, csrfToken: "ui-test" },
      "/api/providers": { providers: [{ id: "codex", label: "Codex", usageWindowId: "weekly", supportsPermissionMode: false }] },
      "/api/projects": { projects: [{ id: 1, name: "샘플 프로젝트", path: "/workspace/sample" }] },
      "/api/chats": { chats: [{ id: 11, project_id: 1, provider: "codex", status: "stopped", title: "모바일 입력창 위치 확인" }] },
      "/api/chats/11/messages": { messages: Array.from({ length: 30 }, (_, index) => ({ id: `m${index}`, role: index % 2 ? "assistant" : "user", kind: "text", content: `메시지 ${index} — 긴 대화에서도 입력창이 보여야 합니다.`, createdAt: "2026-09-27T00:00:00.000Z" })), hasMore: false },
      "/api/agent-integrations": { integrations: integrationPending ? [{ provider: "codex", cliInstalled: true, cliPath: "/usr/bin/codex", version: null, skillsInstalled: false, mcpInstalled: false, ready: false }] : [] },
      "/api/projects/1/session-backups": { backups: [] },
      "/api/models/codex": { options: { provider: "codex", models: [], efforts: [] } },
      "/api/usage": { usage: [] }, "/api/system": { latest: null }, "/api/runtime": {}, "/api/slack": { enabled: false }, "/api/ntfy": { enabled: false }, "/api/approvals": { approvals: [] },
    };
    await route.fulfill({ json: pathname in responses ? responses[pathname] : {} });
  });
}

async function composerGap(page: Page): Promise<{ composerBottom: number; tabbarTop: number; noticeVisible: boolean }> {
  await page.goto("/?chat=11");
  await expect(page.locator("form.composer")).toBeVisible();
  return page.evaluate(() => ({
    composerBottom: document.querySelector("form.composer")!.getBoundingClientRect().bottom,
    tabbarTop: document.querySelector(".mobile-tabbar")!.getBoundingClientRect().top,
    noticeVisible: Boolean(document.querySelector(".agent-integration-notice")),
  }));
}

for (const pending of [true, false]) {
  test(`390px 채팅: 연동 안내 ${pending ? "있음" : "없음"}에서도 입력창이 탭바 위에 있다`, async ({ page }) => {
    await mockChat(page, pending);
    await page.setViewportSize({ width: 390, height: 844 });
    const layout = await composerGap(page);
    expect(layout.noticeVisible).toBe(pending);
    expect(layout.composerBottom).toBeLessThanOrEqual(layout.tabbarTop + 1);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(true);
    if (pending) await page.screenshot({ path: "artifacts/ui-chat-mobile-notice-layout.png" });
  });
}
