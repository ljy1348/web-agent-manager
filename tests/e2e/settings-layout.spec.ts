import { expect, test, type Page } from "@playwright/test";

// 실사용 규모(세션 8개, 연결 컴퓨터 2대, 로그 수백 줄)의 설정 화면 목 응답을 깐다.
async function mockSettingsApi(page: Page) {
  const sessions = Array.from({ length: 8 }, (_, index) => ({
    id: index + 1, current: index === 0, mobileTrusted: index % 3 === 1,
    deviceLabel: index === 0 ? null : ["Chrome · Windows", "SM-S918N 앱", "Safari · iPad", "Firefox · Ubuntu 데스크톱 작업용 긴 이름의 브라우저"][index % 4],
    lastSeenAt: "2026-09-27 01:00:00", expiresAt: "2026-10-04 01:00:00",
  }));
  const logLines = Array.from({ length: 300 }, (_, index) => `2026-09-27T01:${String(index % 60).padStart(2, "0")}:00.000Z ${index % 17 === 0 ? "WARN" : "INFO"} http GET /api/chats/${index} 200 ${index % 90}ms`);
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "layout-admin", role: "admin", access_scope: "standard" }, csrfToken: "layout-csrf", temporary: false },
      "/api/providers": { providers: [] }, "/api/projects": { projects: [], defaultPath: "/workspace" }, "/api/usage": { usage: [] },
      "/api/system": { latest: null }, "/api/runtime": {}, "/api/slack": { enabled: true }, "/api/ntfy": { enabled: false }, "/api/approvals": { approvals: [] },
      "/api/auth/sessions": { sessions, hasMore: false }, "/api/auth/mfa": { enabled: true, recoveryCodesRemaining: 6 },
      "/api/federation/nodes": { nodes: [
        { id: "n1", name: "사무실 데스크톱(RTX 워크스테이션)", base_url: "http://192.168.0.21:14003", created_at: "2026-09-20", updated_at: "2026-09-26" },
        { id: "n2", name: "home-nas", base_url: "http://100.88.12.4:14003", created_at: "2026-09-22", updated_at: "2026-09-26" },
      ] },
      "/api/logs/server": { lines: logLines, dates: ["2026-09-27", "2026-09-26", "2026-09-25"], date: "2026-09-27", matched: 300, truncated: false },
      "/api/mobile/push": { enabled: true, projectConfigured: true, registeredDevices: 2 },
      "/api/admin/webhook-settings": { enabled: true, endpointConfigured: true, signingSecretConfigured: true, endpointHost: "hooks.example.com" },
      "/api/admin/slack-settings": { botTokenConfigured: true, channelId: "C0123456" }, "/api/admin/ntfy-settings": { topic: null, serverUrl: "https://ntfy.sh" },
      "/api/admin/idle-chat-settings": { enabled: true, timeoutHours: 24 }, "/api/admin/full-backups": { backups: [] }, "/api/remote-workers": { hosts: [] },
    };
    await route.fulfill({ json: pathname in responses ? responses[pathname] : {} });
  });
}

// 데스크톱은 상단 탭, 모바일은 더보기 시트에서 설정으로 이동한다.
async function openSettings(page: Page, mobile: boolean) {
  await page.goto("/");
  if (mobile) {
    await page.getByRole("button", { name: "더보기", exact: true }).click();
    await page.getByRole("dialog", { name: "더보기" }).getByRole("button", { name: /설정/ }).click();
  } else {
    await page.locator("header nav").getByRole("button", { name: "설정" }).click();
  }
  await expect(page.getByRole("navigation", { name: "설정 항목" })).toBeVisible();
}

const noHorizontalOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

for (const width of [1440, 1024]) {
  test(`${width}px에서는 설정 목록과 선택 항목 상세를 2단으로 보여주고 폼은 접어 둔다`, async ({ page }) => {
    await mockSettingsApi(page);
    await page.setViewportSize({ width, height: 900 });
    await openSettings(page, false);
    const menu = page.getByRole("navigation", { name: "설정 항목" });
    await expect(menu.getByRole("button", { name: /로그인 보안/ })).toHaveAttribute("aria-current", "true");
    const detail = page.locator(".settings-detail");
    await expect(detail.locator(".session-security-card")).toBeVisible();
    // 비밀번호 변경 폼은 접혀 있다가 눌러야 펼쳐진다.
    await expect(detail.getByLabel("새 비밀번호", { exact: true })).toBeHidden();
    await page.screenshot({ path: `artifacts/ui-settings-${width}.png` });
    await detail.getByText("비밀번호 변경", { exact: true }).click();
    await expect(detail.getByLabel("새 비밀번호", { exact: true })).toBeVisible();

    // 상세로 여는 모든 항목이 한 번에 하나씩만 보인다.
    for (const title of ["2단계 인증", "일회용 임시 로그인", "브라우저 알림", "Android 앱 푸시", "Slack 알림", "ntfy 알림", "Webhook", "유휴 채팅 자동 종료", "전체 암호화 백업", "컴퓨터 연결", "서버 로그", "원격 worker", "프로젝트 Agent profile", "Codex structured shadow"]) {
      await menu.getByRole("button", { name: new RegExp(title) }).click();
      await expect(detail).toHaveAttribute("aria-label", title);
      await expect(detail.locator(".card")).toHaveCount(1);
    }
    await menu.getByRole("button", { name: /서버 로그/ }).click();
    await page.screenshot({ path: `artifacts/ui-settings-${width}-logs.png` });
    expect(await noHorizontalOverflow(page)).toBe(true);
  });
}

test("390px에서는 목록에서 항목을 열고 뒤로가기로 목록에 돌아온다", async ({ page }) => {
  await mockSettingsApi(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await openSettings(page, true);
  const menu = page.getByRole("navigation", { name: "설정 항목" });
  await expect(page.locator(".settings-detail")).toHaveCount(0);
  await page.screenshot({ path: "artifacts/ui-settings-mobile-list.png", fullPage: true });

  await menu.getByRole("button", { name: /로그인 보안/ }).click();
  await expect(menu).toHaveCount(0);
  await expect(page.locator(".settings-detail .session-security-card")).toBeVisible();
  await page.screenshot({ path: "artifacts/ui-settings-mobile-detail.png", fullPage: true });
  expect(await noHorizontalOverflow(page)).toBe(true);

  await page.goBack();
  await expect(menu).toBeVisible();
  await menu.getByRole("button", { name: /2단계 인증/ }).click();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await expect(menu).toBeVisible();
  expect(await noHorizontalOverflow(page)).toBe(true);
});
