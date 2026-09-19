import { expect, test } from "@playwright/test";

test("CLI canary 지연 응답과 결과를 관리자 대시보드에서 안전하게 다룬다", async ({ page }) => {
  let latest: unknown[] = [];
  let latestUpdates: unknown[] = [];
  let requestCount = 0;
  const updateBodies: unknown[] = [];
  let rollbackCount = 0;
  let releaseRun!: () => void;
  const runGate = new Promise<void>((resolve) => { releaseRun = resolve; });
  await page.routeWebSocket("**/ws", () => undefined);
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "qa-admin", role: "admin" }, csrfToken: "qa-csrf" },
      "/api/providers": { providers: [{ id: "codex", label: "Codex", supportsCliUpdate: true }] },
      "/api/projects": { projects: [] },
      "/api/usage": { usage: [] },
      "/api/system": { latest: null },
      "/api/runtime": { codex: "codex 1.0.0", git: "git test" },
      "/api/slack": { enabled: false },
      "/api/ntfy": { enabled: false },
      "/api/approvals": { approvals: [] },
    };
    if (pathname === "/api/providers/capabilities") {
      await route.fulfill({ json: { providers: [{ provider: "codex", structuredSession: false, fallbackReasons: ["tui_required"] }], canaries: latest, updates: latestUpdates } });
      return;
    }
    if (pathname === "/api/providers/codex/canaries" && request.method() === "POST") {
      requestCount += 1;
      expect(request.headers()["idempotency-key"]?.length).toBeGreaterThan(20);
      expect(request.postDataJSON()).toEqual({ candidateVersion: "codex 2.0.0" });
      await runGate;
      const canary = {
        run: {
          id: "canary-1", provider: "codex", state: "passed", currentVersion: "codex 1.0.0",
          candidateVersion: "codex 2.0.0", reportedVersion: "codex 2.0.0",
          capabilityDiff: [{ field: "transport", before: "hook_jsonl_tui", after: "app_server", change: "changed" }],
          summary: { reason: "canary_passed", isolatedHome: true, isolatedWorkspace: true },
        },
        steps: ["login", "new_session", "resume", "idle_input", "follow_up", "approval", "interrupt", "completion", "rate_limit_sample", "usage_read"]
          .map((name, index) => ({ ordinal: index + 1, name, state: "passed", durationMs: 40 + index * 10, evidence: { code: `${name}_ok` } })),
      };
      latest = [canary];
      await route.fulfill({ status: 201, json: { canary } });
      return;
    }
    if (pathname === "/api/providers/codex/update" && request.method() === "POST") {
      expect(request.headers()["idempotency-key"]?.length).toBeGreaterThan(20);
      updateBodies.push(request.postDataJSON());
      latestUpdates = [{ id: "update-1", provider: "codex", state: "applied", previousVersion: "codex 1.0.0", candidateVersion: "codex 2.0.0", installedVersion: "codex 2.0.0" }];
      await route.fulfill({ json: { status: "completed", provider: "codex", updateRunId: "update-1", previousVersion: "codex 1.0.0", currentVersion: "codex 2.0.0", failures: [], warnings: [] } });
      return;
    }
    if (pathname === "/api/providers/codex/updates/update-1/rollback" && request.method() === "POST") {
      expect(request.headers()["idempotency-key"]?.length).toBeGreaterThan(20);
      rollbackCount += 1;
      latestUpdates = [{ id: "update-1", provider: "codex", state: "rolled_back", previousVersion: "codex 1.0.0", candidateVersion: "codex 2.0.0", installedVersion: "codex 1.0.0" }];
      await route.fulfill({ json: { status: "rolled_back", provider: "codex", restoredVersion: "codex 1.0.0", failures: [] } });
      return;
    }
    await route.fulfill({ json: pathname in responses ? responses[pathname] : {} });
  });

  await page.goto("/?tab=overview");
  await expect(page.getByText("Codex canary", { exact: false })).toBeVisible();
  await page.getByLabel("Codex 후보 CLI 버전").fill("codex 2.0.0");
  const feedbackMs = await page.getByRole("button", { name: "canary 실행", exact: true }).evaluate((element) => new Promise<number>((resolve) => {
    const startedAt = performance.now();
    let timer = 0;
    const observer = new MutationObserver(() => {
      const button = element.parentElement?.querySelector("button") as HTMLButtonElement | null;
      if (!button?.disabled || !button.textContent?.includes("실행 중")) return;
      observer.disconnect();
      clearTimeout(timer);
      resolve(performance.now() - startedAt);
    });
    observer.observe(element.parentElement!, { attributes: true, subtree: true, childList: true, characterData: true });
    (element as HTMLButtonElement).click();
    timer = window.setTimeout(() => { observer.disconnect(); resolve(5_000); }, 5_000);
  }));
  const running = page.getByRole("button", { name: "canary 실행 중…" });
  await expect(running).toBeDisabled();
  expect(feedbackMs).toBeLessThan(500);
  await expect.poll(() => requestCount).toBe(1);
  await running.click({ force: true }).catch(() => undefined);
  await page.waitForTimeout(250);
  expect(requestCount).toBe(1);

  releaseRun();
  const canaryCard = page.locator(".runtime-canary");
  await expect(canaryCard.getByText("통과", { exact: true })).toBeVisible();
  await expect(canaryCard.getByText("codex 1.0.0 → codex 2.0.0 · capability 변경 1개", { exact: true })).toBeVisible();
  await expect(canaryCard.getByText("단계 증거 10/10 · 최대 130ms", { exact: true })).toBeVisible();
  await canaryCard.locator(".canary-evidence summary").click();
  await expect(canaryCard.getByText(/approval passed · 90ms · approval_ok/)).toBeVisible();
  const updateButton = page.getByRole("button", { name: "업데이트", exact: true });
  await expect(updateButton).toBeEnabled();
  page.on("dialog", (dialog) => void dialog.accept());
  await updateButton.click();
  await expect.poll(() => updateBodies).toEqual([{ canaryRunId: "canary-1" }]);
  const rollbackButton = page.getByRole("button", { name: "롤백", exact: true });
  await expect(rollbackButton).toBeEnabled();
  await rollbackButton.click();
  await expect.poll(() => rollbackCount).toBe(1);
  await expect(rollbackButton).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(canaryCard).toBeVisible();
  expect(await canaryCard.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test("테스트 전용 계정은 canary·verification UI만 조작하고 운영 UI는 사용할 수 없다", async ({ page }) => {
  await page.routeWebSocket("**/ws", () => undefined);
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const chat = { id: 1, project_id: 1, provider: "codex", status: "running", title: "테스트 대상", model: "gpt-test", busy: 0 };
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 3, username: "qa-tester", role: "user", access_scope: "test_only", last_project_id: 1, last_chat_id: 1 }, csrfToken: "qa-csrf" },
      "/api/providers": { providers: [{ id: "codex", label: "Codex", supportsCliUpdate: true, supportsPermissionMode: false }] },
      "/api/providers/capabilities": { providers: [{ provider: "codex", structuredSession: false, fallbackReasons: [] }], canaries: [] },
      "/api/projects": { projects: [{ id: 1, name: "QA project", path: "/workspace/qa" }] },
      "/api/chats": { chats: [chat] },
      "/api/chats/1": { chat },
      "/api/chats/1/messages": { messages: [], hasMore: false },
      "/api/chats/1/current-task": { task: { id: "task-test-only", state: "running", profile_name: "QA", profile_version: 1 }, verifications: [] },
      "/api/usage": { usage: [] },
      "/api/system": { latest: null },
      "/api/runtime": { codex: "codex 1.0.0" },
      "/api/slack": { enabled: false },
      "/api/ntfy": { enabled: false },
      "/api/approvals": { approvals: [] },
    };
    await route.fulfill({ json: pathname in responses ? responses[pathname] : {} });
  });

  await page.goto("/?tab=overview");
  await expect(page.getByText("테스트 전용", { exact: true })).toBeVisible();
  await expect(page.getByLabel("작업 프로젝트")).toBeDisabled();
  await expect(page.getByRole("button", { name: "프로젝트", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "canary 실행", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "업데이트", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "단계 시작", exact: true })).toHaveCount(0);

  await page.locator("header nav").getByRole("button", { name: "채팅", exact: true }).click();
  const panel = page.locator(".verification-panel");
  await expect(panel).toBeVisible();
  await panel.locator("summary").click();
  await expect(panel.getByRole("button", { name: "검증 실행", exact: true })).toBeVisible();
  await expect(page.getByRole("note")).toContainText("채팅 입력과 운영 제어를 사용할 수 없습니다");
  await expect(page.locator("textarea[placeholder*='질문을 입력']")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "승인 후 실행", exact: true })).toHaveCount(0);
});

test("관리자는 후보 신규 채팅 quota를 채운 뒤에만 전체 적용할 수 있다", async ({ page }) => {
  let rollout: any = null;
  let rolloutRequests = 0;
  let updateBody: unknown;
  await page.routeWebSocket("**/ws", () => undefined);
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/providers/capabilities") {
      await route.fulfill({ json: {
        providers: [{ provider: "codex", structuredSession: false, fallbackReasons: [] }],
        canaries: [{ run: { id: "canary-stage", provider: "codex", state: "passed", currentVersion: "codex 1.0.0", candidateVersion: "codex 2.0.0", capabilityDiff: [] } }],
        updates: [], rollouts: rollout ? [rollout] : [], rolloutConfigured: true,
      } }); return;
    }
    if (pathname === "/api/providers/codex/rollouts" && request.method() === "POST") {
      expect(request.postDataJSON()).toEqual({ canaryRunId: "canary-stage", maxNewChats: 1 });
      rolloutRequests += 1;
      rollout = { id: "rollout-1", provider: "codex", canaryRunId: "canary-stage", state: "active", assignedCount: 0, maxNewChats: 1, errorCount: 0 };
      await route.fulfill({ status: 201, json: { rollout } }); return;
    }
    if (pathname === "/api/providers/codex/update" && request.method() === "POST") {
      updateBody = request.postDataJSON();
      rollout = { ...rollout, state: "promoted" };
      await route.fulfill({ json: { status: "completed", previousVersion: "codex 1.0.0", currentVersion: "codex 2.0.0", failures: [], warnings: [] } }); return;
    }
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "admin", role: "admin" }, csrfToken: "qa" },
      "/api/providers": { providers: [{ id: "codex", label: "Codex", supportsCliUpdate: true }] },
      "/api/projects": { projects: [] }, "/api/usage": { usage: [] }, "/api/system": { latest: null },
      "/api/runtime": { codex: "codex 1.0.0" }, "/api/slack": {}, "/api/ntfy": {}, "/api/approvals": { approvals: [] },
    };
    await route.fulfill({ json: pathname in responses ? responses[pathname] : {} });
  });
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto("/?tab=overview");
  const stage = page.getByRole("button", { name: "단계 시작", exact: true });
  const feedbackMs = await stage.evaluate((element) => new Promise<number>((resolve) => {
    const startedAt = performance.now();
    const observer = new MutationObserver(() => {
      if (!element.textContent?.includes("준비 중")) return;
      observer.disconnect(); resolve(performance.now() - startedAt);
    });
    observer.observe(element, { childList: true, characterData: true, subtree: true });
    (element as HTMLButtonElement).click();
    window.setTimeout(() => { observer.disconnect(); resolve(5_000); }, 5_000);
  }));
  expect(feedbackMs).toBeLessThan(500);
  await expect.poll(() => rolloutRequests).toBe(1);
  const promote = page.getByRole("button", { name: "전체 적용", exact: true });
  await expect(promote).toBeDisabled();
  await expect(page.getByText(/rollout active 0\/1 · 오류 0/)).toBeVisible();
  rollout = { ...rollout, assignedCount: 1 };
  await page.locator(".section-head").getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(promote).toBeEnabled();
  await promote.click();
  await expect.poll(() => updateBody).toEqual({ canaryRunId: "canary-stage", rolloutRunId: "rollout-1" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.locator(".runtime-list").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});
