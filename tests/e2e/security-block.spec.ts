import { expect, test, type Page } from "@playwright/test";

// 설정 화면에 필요한 기본 목 응답을 깔고, webhook 테스트 전송 요청만 시나리오별 처리기로 넘긴다.
type Mocked = { status?: number; json: unknown };
async function mockApi(page: Page, onWebhookTest: () => Mocked, reauthCalls: Array<Record<string, unknown>>, extra: Record<string, (body: Record<string, unknown>) => Mocked> = {}) {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const custom = extra[`${method} ${pathname}`];
    if (custom) { await route.fulfill(custom(JSON.parse(route.request().postData() || "{}"))); return; }
    if (pathname === "/api/webhook/test" && method === "POST") { await route.fulfill(onWebhookTest()); return; }
    if (pathname === "/api/auth/reauth" && method === "POST") {
      const body = JSON.parse(route.request().postData() || "{}");
      reauthCalls.push(body);
      const valid = body.currentPassword === "correct-password" && body.code === "123456";
      await route.fulfill(valid
        ? { json: { reauthenticatedAt: "2026-09-27 00:00:00", validUntil: "2026-09-27 00:15:00" } }
        : { status: 403, json: { error: "비밀번호 또는 인증 코드가 올바르지 않습니다." } });
      return;
    }
    if (pathname === "/api/auth/sessions") { await route.fulfill({ json: { sessions: [], hasMore: false } }); return; }
    if (pathname === "/api/auth/mfa") { await route.fulfill({ json: { enabled: true, recoveryCodesRemaining: 8 } }); return; }
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "security-admin", role: "admin", access_scope: "standard" }, csrfToken: "security-csrf", temporary: false },
      "/api/providers": { providers: [] }, "/api/projects": { projects: [], defaultPath: "/workspace" }, "/api/usage": { usage: [] },
      "/api/system": { latest: null }, "/api/runtime": {}, "/api/slack": { enabled: false }, "/api/ntfy": { enabled: false }, "/api/approvals": { approvals: [] },
      "/api/admin/webhook-settings": { enabled: true, endpointConfigured: true, signingSecretConfigured: true, endpointHost: "hooks.example.com" },
      "/api/admin/slack-settings": { botTokenConfigured: false, channelId: null }, "/api/admin/ntfy-settings": { topic: null, serverUrl: "https://ntfy.sh" },
      "/api/admin/idle-chat-settings": { enabled: true, timeoutHours: 24 }, "/api/admin/full-backups": { backups: [] }, "/api/remote-workers": { hosts: [] },
    };
    await route.fulfill({ json: pathname in responses ? responses[pathname] : {} });
  });
}

// 모바일 더보기 메뉴에서 설정 화면으로 이동해 webhook 테스트 전송 버튼을 누른다.
async function openSettingsAndSendWebhookTest(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "더보기", exact: true }).click();
  await page.getByRole("dialog", { name: "더보기" }).getByRole("button", { name: /설정/ }).click();
  await page.getByRole("navigation", { name: "설정 항목" }).getByRole("button", { name: /Webhook/ }).click();
  await page.locator(".webhook-settings-card").getByRole("button", { name: "테스트 전송", exact: true }).click();
}

test("재인증이 필요하면 중앙 안내창에서 바로 확인하고 원래 요청을 자동 재시도한다", async ({ page }) => {
  const reauthCalls: Array<Record<string, unknown>> = [];
  let sends = 0;
  await mockApi(page, () => (++sends === 1
    ? { status: 403, json: { error: "중요 작업 전에 설정에서 본인 확인을 다시 해주세요.", reauthRequired: true } }
    : { status: 200, json: { sent: true } }), reauthCalls);
  await page.setViewportSize({ width: 390, height: 844 });
  await openSettingsAndSendWebhookTest(page);

  const dialog = page.getByRole("dialog", { name: "본인 확인 필요" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("MFA 코드")).toBeVisible();
  await page.screenshot({ path: "artifacts/ui-security-block-reauth-mobile.png" });

  // 틀린 비밀번호는 안내창 안에 오류로 보이고 로그인 화면으로 튕기지 않는다.
  await dialog.getByLabel("비밀번호").fill("wrong-password");
  await dialog.getByLabel("MFA 코드").fill("000000");
  await dialog.getByRole("button", { name: "확인하고 계속" }).click();
  await expect(dialog.getByText("비밀번호 또는 인증 코드가 올바르지 않습니다.")).toBeVisible();
  await expect(page.locator(".webhook-settings-card")).toBeVisible();

  await dialog.getByLabel("비밀번호").fill("correct-password");
  await dialog.getByLabel("MFA 코드").fill("123456");
  await dialog.getByRole("button", { name: "확인하고 계속" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".webhook-settings-card").getByText("서명된 테스트 webhook을 보냈습니다.", { exact: true })).toBeVisible();
  expect(sends).toBe(2);
  expect(reauthCalls).toHaveLength(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("외부망 차단은 원인과 해결 방법을 중앙 안내창으로 보여준다", async ({ page }) => {
  await mockApi(page, () => ({ status: 403, json: { error: "되돌릴 수 없는 작업은 내부망에서만 할 수 있습니다.", networkRestricted: true } }), []);
  await page.setViewportSize({ width: 390, height: 844 });
  await openSettingsAndSendWebhookTest(page);

  const dialog = page.getByRole("dialog", { name: "외부망 접속 차단" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("이 기기 앱 인증");
  await page.screenshot({ path: "artifacts/ui-security-block-network-mobile.png" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: "artifacts/ui-security-block-network-desktop.png" });
  await dialog.getByRole("button", { name: "확인", exact: true }).click();
  await expect(dialog).toBeHidden();
});

// 앱 WebView의 지문 브리지를 흉내 낸다. signReauth는 cancelFirst면 첫 호출만 취소로 응답한다.
async function installFakeBridge(page: Page, cancelFirst: boolean) {
  await page.addInitScript((cancel) => {
    let calls = 0;
    const reply = (id: string, result: unknown) => setTimeout(() => (window as any).__wamBiometricCallback?.(id, result), 50);
    (window as any).WamAndroidBiometric = {
      isAvailable: () => true,
      signReauth: (challenge: string, id: string) => reply(id, cancel && ++calls === 1 ? { ok: false, code: "cancelled", message: "취소" } : { ok: true, signature: `bio-sig:${challenge}` }),
      prepareEnrollment: (challenge: string, id: string) => reply(id, { ok: true, publicKey: "bio-public-key", signature: `device-sig:${challenge}` }),
      removeKey: () => undefined,
    };
  }, cancelFirst);
}

test("앱에서는 본인 확인 안내창이 지문 확인을 띄우고 성공하면 원래 요청을 재시도한다", async ({ page }) => {
  let sends = 0;
  const verified: Array<Record<string, unknown>> = [];
  await installFakeBridge(page, true);
  await mockApi(page, () => (++sends === 1
    ? { status: 403, json: { error: "중요 작업 전에 설정에서 본인 확인을 다시 해주세요.", reauthRequired: true } }
    : { status: 200, json: { sent: true } }), [], {
    "GET /api/mobile/biometric": () => ({ json: { deviceBound: true, enrolled: true } }),
    "POST /api/mobile/biometric/reauth/challenge": () => ({ json: { challenge: "reauth-challenge" } }),
    "POST /api/mobile/biometric/reauth": (body) => { verified.push(body); return { json: { reauthenticated: true } }; },
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await openSettingsAndSendWebhookTest(page);

  const dialog = page.getByRole("dialog", { name: "본인 확인 필요" });
  await expect(dialog.getByText("지문 확인을 취소했습니다.", { exact: false })).toBeVisible();
  await expect(dialog.getByLabel("또는 비밀번호")).not.toBeFocused();
  await page.screenshot({ path: "artifacts/ui-security-block-biometric-mobile.png" });
  await dialog.getByRole("button", { name: "지문으로 확인" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".webhook-settings-card").getByText("서명된 테스트 webhook을 보냈습니다.", { exact: true })).toBeVisible();
  expect(verified).toEqual([{ challenge: "reauth-challenge", signature: "bio-sig:reauth-challenge" }]);
  expect(sends).toBe(2);
});

test("설정에서 지문 등록 시 최근 본인 확인이 없으면 비밀번호 확인 후 등록을 이어간다", async ({ page }) => {
  let challengeCalls = 0;
  const enrolled: Array<Record<string, unknown>> = [];
  const reauthCalls: Array<Record<string, unknown>> = [];
  await installFakeBridge(page, false);
  await mockApi(page, () => ({ json: { sent: true } }), reauthCalls, {
    "GET /api/mobile/biometric": () => ({ json: { deviceBound: true, enrolled: false } }),
    "POST /api/mobile/biometric/enroll/challenge": () => (++challengeCalls === 1
      ? { status: 403, json: { error: "중요 작업 전에 설정에서 본인 확인을 다시 해주세요.", reauthRequired: true } }
      : { json: { challenge: "enroll-challenge" } }),
    "POST /api/mobile/biometric/enroll": (body) => { enrolled.push(body); return { status: 201, json: { enrolled: true } }; },
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "더보기", exact: true }).click();
  await page.getByRole("dialog", { name: "더보기" }).getByRole("button", { name: /설정/ }).click();
  await page.getByRole("navigation", { name: "설정 항목" }).getByRole("button", { name: /로그인 보안/ }).click();
  await page.getByRole("button", { name: "지문 등록" }).click();

  const dialog = page.getByRole("dialog", { name: "본인 확인 필요" });
  await expect(dialog.getByText("설정 › 로그인 보안에서 지문 본인 확인을 등록하면", { exact: false })).toBeVisible();
  await dialog.getByLabel("비밀번호").fill("correct-password");
  await dialog.getByLabel("MFA 코드").fill("123456");
  await dialog.getByRole("button", { name: "확인하고 계속" }).click();
  await expect(page.getByText("지문 본인 확인을 등록했습니다.")).toBeVisible();
  await expect(page.getByRole("button", { name: "지문 해제" })).toBeVisible();
  await page.getByText("지문 본인 확인을 등록했습니다.").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "artifacts/ui-biometric-settings-mobile.png" });
  expect(enrolled).toEqual([{ challenge: "enroll-challenge", publicKey: "bio-public-key", signature: "device-sig:enroll-challenge" }]);
  expect(reauthCalls).toHaveLength(1);
});
