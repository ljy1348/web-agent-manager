import { expect, test, type Page } from "@playwright/test";

// 실사용 규모(스킬 15개·긴 이름, 백업 12개, 연결 컴퓨터 2대)의 공급자 설정 목 응답을 깔고, 보낸 요청을 기록한다.
async function mockApi(page: Page) {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const nodes = [
    { id: "n1", name: "사무실 데스크톱(RTX 워크스테이션)", base_url: "http://192.168.0.21:14003", settings_mode: "independent", created_at: "2026-09-20", updated_at: "2026-09-26" },
    { id: "n2", name: "home-nas", base_url: "http://100.88.12.4:14003", settings_mode: "follow", created_at: "2026-09-22", updated_at: "2026-09-26" },
  ];
  const skills = Array.from({ length: 15 }, (_, index) => index % 4 === 0 ? `company-internal-release-checklist-${index}` : `skill-${index}`);
  const summary = { providers: [
    { provider: "claude", instructions: [".claude/CLAUDE.md"], skills, hooks: ["settings.json hooks.Stop", "settings.json hooks.PreToolUse"] },
    { provider: "codex", instructions: [".codex/AGENTS.md", ".codex/AGENTS.override.md"], skills: skills.slice(0, 6), hooks: [".codex/hooks.json"] },
    { provider: "grok", instructions: [], skills: [], hooks: [".grok/hooks/notify-slack-when-long-running-task-finishes.json"] },
  ] };
  const backups = Array.from({ length: 12 }, (_, index) => ({
    id: `2026-09-27T0${index % 10}-00-00-000Z-abcd${index}`, createdAt: `2026-09-${String(27 - index).padStart(2, "0")}T0${index % 10}:00:00.000Z`,
    reason: ["manual", "before-restore", "before-sync"][index % 3], providers: index % 2 ? ["claude", "codex", "grok"] : ["codex"], fileCount: 40 + index, bytes: 180_000 + index * 9000,
  }));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() !== "GET") requests.push({ method: request.method(), path: pathname, body: request.postDataJSON?.() ?? null });
    const patch = pathname.match(/^\/api\/federation\/nodes\/(n\d)$/);
    if (patch && request.method() === "PATCH") {
      const node = nodes.find((item) => item.id === patch[1])!;
      node.settings_mode = request.postDataJSON().settingsMode;
      return route.fulfill({ json: { settingsMode: node.settings_mode } });
    }
    if (/\/provider-settings\/sync$/.test(pathname)) return route.fulfill({ json: { sentFiles: 58, written: 58, removed: 3, backup: { id: "x", reason: "before-sync" }, warnings: ["Claude settings.json 훅 명령이 Linux 경로나 셸을 씁니다: bash /home/me/notify.sh", "스킬의 셸 스크립트는 Windows에서 실행되지 않을 수 있습니다: .claude/skills/deploy/run.sh"] } });
    if (/\/restore$/.test(pathname)) return route.fulfill({ json: { written: 41, removed: 2, skipped: [], backup: { id: "y" } } });
    if (/\/provider-settings\/summary$/.test(pathname)) return route.fulfill({ json: summary });
    if (/\/provider-settings\/backups$/.test(pathname)) return route.fulfill({ json: request.method() === "POST" ? { backup: { fileCount: 58 } } : { backups } });
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "layout-admin", role: "admin", access_scope: "standard" }, csrfToken: "layout-csrf", temporary: false },
      "/api/providers": { providers: [] }, "/api/projects": { projects: [], defaultPath: "/workspace" }, "/api/usage": { usage: [] },
      "/api/system": { latest: null }, "/api/runtime": {}, "/api/slack": { enabled: false }, "/api/ntfy": { enabled: false }, "/api/approvals": { approvals: [] },
      "/api/auth/sessions": { sessions: [], hasMore: false }, "/api/federation/nodes": { nodes },
    };
    await route.fulfill({ json: pathname in responses ? responses[pathname] : {} });
  });
  return requests;
}

async function openCard(page: Page, mobile: boolean) {
  await page.goto("/");
  if (mobile) {
    await page.getByRole("button", { name: "더보기", exact: true }).click();
    await page.getByRole("dialog", { name: "더보기" }).getByRole("button", { name: /설정/ }).click();
  } else {
    await page.locator("header nav").getByRole("button", { name: "설정" }).click();
  }
  await page.getByRole("navigation", { name: "설정 항목" }).getByRole("button", { name: /공급자 설정 백업·동기화/ }).click();
  const card = page.locator(".provider-settings-card");
  await expect(card).toBeVisible();
  await expect(card.getByText("이 WAM의 백업")).toBeVisible();
  return card;
}

const noHorizontalOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test("1440px: 따로 구성 컴퓨터는 동기화를 막고, 메인 따르기로 바꾸면 선택 공급자만 보낸다", async ({ page }) => {
  const requests = await mockApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const card = await openCard(page, false);
  page.on("dialog", (dialog) => void dialog.accept());
  const office = card.locator(".session-security-row", { hasText: "사무실 데스크톱" });
  await expect(office.getByRole("button", { name: "지금 동기화" })).toBeDisabled();
  await expect(card.locator(".session-security-row", { hasText: "home-nas" }).getByRole("button", { name: "지금 동기화" })).toBeEnabled();
  await page.screenshot({ path: "artifacts/ui-provider-settings-1440.png", fullPage: true });

  await office.getByRole("combobox").selectOption("follow");
  await expect(office.getByRole("button", { name: "지금 동기화" })).toBeEnabled();
  await card.getByLabel("Grok").uncheck();
  await office.getByRole("button", { name: "지금 동기화" }).click();
  await expect(card.getByText(/파일 58개를 보냈습니다/)).toBeVisible();
  await expect(card.getByText(/Windows에서 동작하지 않을 수 있는 항목 2개/)).toBeVisible();
  expect(requests).toContainEqual({ method: "PATCH", path: "/api/federation/nodes/n1", body: { settingsMode: "follow" } });
  expect(requests).toContainEqual({ method: "POST", path: "/api/federation/nodes/n1/provider-settings/sync", body: { providers: ["claude", "codex"] } });

  // 연결 컴퓨터를 고르면 그 컴퓨터의 백업을 중계 경로로 보고 복원한다.
  await card.getByLabel("컴퓨터").selectOption("n2");
  await expect(card.getByText("home-nas의 백업")).toBeVisible();
  await expect(card.getByText("연결 컴퓨터로 보내기")).toHaveCount(0);
  await card.locator(".provider-settings-backups .session-security-row").first().getByRole("button", { name: "복원" }).click();
  await expect(card.getByText(/복원했습니다/)).toBeVisible();
  expect(requests.some((item) => item.path.startsWith("/api/federation/nodes/n2/api/provider-settings/backups/") && item.path.endsWith("/restore"))).toBe(true);
  await page.screenshot({ path: "artifacts/ui-provider-settings-1440-node.png", fullPage: true });
  expect(await noHorizontalOverflow(page)).toBe(true);
});

test("390px: 긴 컴퓨터 이름·스킬 목록에서도 가로 넘침 없이 조작 버튼이 보인다", async ({ page }) => {
  await mockApi(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const card = await openCard(page, true);
  const syncButton = card.locator(".session-security-row", { hasText: "사무실 데스크톱" }).getByRole("button", { name: "지금 동기화" });
  await syncButton.scrollIntoViewIfNeeded();
  const box = await syncButton.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
  await page.screenshot({ path: "artifacts/ui-provider-settings-mobile.png", fullPage: true });
  expect(await noHorizontalOverflow(page)).toBe(true);
});
