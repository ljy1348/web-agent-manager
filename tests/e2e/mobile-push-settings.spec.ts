import { expect, test } from "@playwright/test";

test("개인 Firebase 앱의 중앙 WAM 직접 푸시 상태와 테스트 요청을 보여준다", async ({ page }) => {
  let testRequests = 0;
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/mobile/push" && route.request().method() === "GET") {
      return route.fulfill({ json: { enabled: true, projectConfigured: true, registeredDevices: 1, deliveryMode: "direct" } });
    }
    if (pathname === "/api/mobile/push/test" && route.request().method() === "POST") {
      testRequests += 1;
      return route.fulfill({ json: { requested: true } });
    }
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "admin", role: "admin", access_scope: "standard" }, csrfToken: "csrf", temporary: false },
      "/api/providers": { providers: [] }, "/api/projects": { projects: [], defaultPath: "/work" }, "/api/usage": { usage: [] },
      "/api/system": {}, "/api/runtime": {}, "/api/slack": {}, "/api/ntfy": {}, "/api/approvals": { approvals: [] },
      "/api/auth/sessions": { sessions: [], hasMore: false }, "/api/auth/mfa": { enabled: false, recoveryCodesRemaining: 0 },
    };
    return route.fulfill({ json: responses[pathname] ?? {} });
  });

  await page.goto("/");
  await page.locator("header nav").getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("navigation", { name: "설정 항목" }).getByRole("button", { name: /Android 앱 푸시/ }).click();
  const card = page.locator(".settings-page article").filter({ hasText: "Android 앱 푸시" });
  await expect(card).toContainText("프로젝트 ID 설정됨 · 등록 기기 1대");
  await expect(card).not.toContainText("릴레이");
  await card.getByRole("button", { name: "테스트 알림" }).click();
  await expect(card).toContainText("실제 휴대폰 수신을 확인하세요.");
  expect(testRequests).toBe(1);
});
