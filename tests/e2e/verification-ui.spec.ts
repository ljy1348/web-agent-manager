import { expect, test } from "@playwright/test";

test("검증 패널에서 PR 연결 실행·명시 승인·재검증 timeline을 실제 Chrome으로 조작한다", async ({ page }) => {
  test.setTimeout(60_000);
  let mode: "empty" | "blocked" | "passed" | "rerun" | "long" = "empty";
  let role: "admin" | "user" = "admin";
  const requests: Array<{ path: string; body: unknown; idempotencyKey: string | null }> = [];
  let resolveInitialLoad!: () => void;
  const initialLoadGate = new Promise<void>((resolve) => { resolveInitialLoad = resolve; });
  let initialLoadReleased = false;
  const releaseInitialLoad = (): void => { initialLoadReleased = true; resolveInitialLoad(); };
  let releaseRun!: () => void;
  const runGate = new Promise<void>((resolve) => { releaseRun = resolve; });
  await page.routeWebSocket("**/ws", () => undefined);
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const json = (body: unknown) => route.fulfill({ json: body });
    const baseResponses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "qa", role, last_project_id: 1, last_chat_id: 1, chat_view_mode: "chat" }, csrfToken: "qa-csrf" },
      "/api/providers": { providers: [{ id: "codex", label: "Codex", supportsPermissionMode: false }] },
      "/api/projects": { projects: [{ id: 1, name: "검증 프로젝트", path: "/workspace/project" }] },
      "/api/chats": { chats: [{ id: 1, project_id: 1, provider: "codex", status: "running", title: "검증 UI QA", model: "gpt-5" }] },
      "/api/chats/1/messages": { messages: [{ id: "a1", role: "assistant", kind: "text", content: "검증 결과를 확인하세요." }], hasMore: false },
      "/api/usage": { usage: [] }, "/api/system": { latest: null }, "/api/runtime": {}, "/api/slack": { enabled: false },
      "/api/approvals": { approvals: [] }, "/api/prompt-schedules": { schedules: [] },
    };
    if (pathname in baseResponses) { await json(baseResponses[pathname]); return; }

    const pullRequest = { number: 27, state: "passed", headSha: "a".repeat(40), totalCount: 3, passedCount: 3, failedCount: 0, pendingCount: 0, unavailableCount: 0, reason: "pull_request_checks_passed" };
    const passedRun = {
      run: {
        id: "run-approved", task_id: "task-123456789", state: "passed", trigger: "manual", pull_request_number: 27,
        commit_hash: "a".repeat(40), diff_hash: "b".repeat(64), summary_json: JSON.stringify({
          result: "passed", reason: "pull_request_checks_passed", local: { state: "passed" }, pullRequest,
          selection: { changedFileCount: 1, selected: [{ ordinal: 1, kind: "live", reason: "unconditional" }], skipped: [{ ordinal: 2, kind: "ui", reason: "no_changed_path_matched" }] },
        }),
      },
      steps: [{ id: "step-live", ordinal: 1, kind: "live", state: "passed", duration_ms: 12 }],
      artifacts: [{ id: "artifact-safe", sha256: "c".repeat(64), redaction_status: "safe" }],
    };
    const blockedRun = {
      run: {
        id: "run-approved", task_id: "task-123456789", state: "blocked", trigger: "manual", pull_request_number: 27,
        commit_hash: "a".repeat(40), diff_hash: "b".repeat(64), summary_json: JSON.stringify({
          reason: "explicit_approval_required",
          selection: { changedFileCount: 1, selected: [{ ordinal: 1, kind: "live", reason: "unconditional" }], skipped: [{ ordinal: 2, kind: "ui", reason: "no_changed_path_matched" }] },
        }),
      }, steps: [], artifacts: [],
    };
    const rerun = {
      ...passedRun,
      run: { ...passedRun.run, id: "run-rerun", trigger: "reverification", source_run_id: "run-approved" },
    };
    if (pathname === "/api/chats/1/current-task" && request.method() === "GET") {
      if (!initialLoadReleased) await initialLoadGate;
      const taskState = mode === "empty" ? "running" : mode === "blocked" ? "needs_input" : "completed";
      const stateReason = mode === "blocked" ? "explicit_approval_required" : mode === "empty" ? null : "pull_request_checks_passed";
      const longRuns = Array.from({ length: 20 }, (_item, index) => ({
        ...passedRun,
        run: { ...passedRun.run, id: `run-history-${index}`, trigger: index ? "reverification" : "manual", source_run_id: index ? `run-history-${index - 1}` : null },
        steps: passedRun.steps.map((step) => ({ ...step, id: `${step.id}-${index}` })),
        artifacts: passedRun.artifacts.map((artifact) => ({ ...artifact, id: `${artifact.id}-${index}` })),
      }));
      const verifications = mode === "empty" ? [] : mode === "blocked" ? [blockedRun] : mode === "passed" ? [passedRun] : mode === "rerun" ? [rerun, passedRun] : longRuns;
      await json({ task: { id: "task-123456789", state: taskState, state_reason: stateReason, profile_name: "일반 구현", profile_version: 4 }, verifications, hasMore: mode === "long" });
      return;
    }
    if (pathname === "/api/tasks/task-123456789/verifications" && request.method() === "POST") {
      requests.push({ path: pathname, body: request.postDataJSON(), idempotencyKey: request.headers()["idempotency-key"] ?? null });
      await runGate;
      mode = "blocked";
      await route.fulfill({ status: 202, json: { verification: blockedRun } });
      return;
    }
    if (pathname === "/api/verifications/run-approved/decision" && request.method() === "POST") {
      requests.push({ path: pathname, body: request.postDataJSON(), idempotencyKey: request.headers()["idempotency-key"] ?? null });
      mode = "passed";
      await json({ verification: passedRun });
      return;
    }
    if (pathname === "/api/verifications/run-approved/rerun" && request.method() === "POST") {
      requests.push({ path: pathname, body: null, idempotencyKey: request.headers()["idempotency-key"] ?? null });
      mode = "rerun";
      await route.fulfill({ status: 202, json: { verification: rerun } });
      return;
    }
    await json({});
  });

  await page.goto("/?tab=chat&project=1&chat=1");
  await expect(page.getByRole("heading", { name: "검증 UI QA" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "검증 정보 불러오는 중…" })).toBeVisible();
  releaseInitialLoad();
  const panel = page.locator(".verification-panel");
  await expect(panel).toBeVisible();
  await panel.locator("summary").click();
  await page.getByLabel("검증에 연결할 PR 번호").fill("27");
  const feedbackMs = await page.getByRole("button", { name: "검증 실행" }).evaluate((element) => new Promise<number>((resolve) => {
    const button = element as HTMLButtonElement;
    const container = button.parentElement!;
    const startedAt = performance.now();
    let timer = 0;
    const observer = new MutationObserver(() => {
      const pending = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent?.includes("검증 중")) as HTMLButtonElement | undefined;
      if (!pending?.disabled) return;
      observer.disconnect();
      window.clearTimeout(timer);
      resolve(performance.now() - startedAt);
    });
    observer.observe(container, { attributes: true, childList: true, subtree: true, characterData: true });
    button.click();
    timer = window.setTimeout(() => { observer.disconnect(); resolve(5_000); }, 5_000);
  }));
  const runningButton = page.getByRole("button", { name: "검증 중…" });
  await expect(runningButton).toBeDisabled();
  expect(feedbackMs).toBeLessThan(500);
  await expect.poll(() => requests.filter((item) => item.path.includes("/tasks/")).length).toBe(1);
  await page.waitForTimeout(250);
  expect(requests.filter((item) => item.path.includes("/tasks/")).length).toBe(1);
  releaseRun();
  await expect(panel.locator(".verification-reason").getByText("live/human 검증 승인 필요", { exact: true })).toBeVisible();
  await expect(panel.getByText("#2 ui · no_changed_path_matched", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "승인 후 실행" }).click();
  await expect(panel.getByText("PR #27 · 통과", { exact: true })).toBeVisible();
  await expect(panel.getByText("통과 3 · 실패 0 · 대기 0 · 확인불가 0", { exact: true })).toBeVisible();
  await expect(panel.getByRole("link", { name: "로그 받기" })).toHaveAttribute("href", "/api/verification-artifacts/artifact-safe");
  await page.getByRole("button", { name: "같은 변경 재검증" }).click();
  await expect(panel.getByText("재검증", { exact: true }).first()).toBeVisible();
  await expect(panel.getByText("원본", { exact: false }).first()).toBeVisible();
  expect(requests.map((item) => [item.path, item.body])).toEqual([
    ["/api/tasks/task-123456789/verifications", { pullRequestNumber: 27 }],
    ["/api/verifications/run-approved/decision", { decision: "approve" }],
    ["/api/verifications/run-approved/rerun", null],
  ]);
  expect(requests.every((item) => typeof item.idempotencyKey === "string" && item.idempotencyKey.length > 20)).toBe(true);

  role = "user";
  mode = "long";
  await page.reload();
  const readonlyPanel = page.locator(".verification-panel");
  await readonlyPanel.locator("summary").click();
  await expect(readonlyPanel.getByText("PR #27 · 통과", { exact: true }).first()).toBeVisible();
  await expect(readonlyPanel.locator(".verification-run")).toHaveCount(20);
  await expect(readonlyPanel.getByText("최근 20회만 표시합니다.", { exact: false })).toBeVisible();
  await expect(readonlyPanel.getByRole("button", { name: "같은 변경 재검증" })).toHaveCount(0);
  await expect(readonlyPanel.getByRole("link", { name: "로그 받기" })).toHaveCount(0);

  const panelBody = readonlyPanel.locator(".verification-panel-body");
  expect(await panelBody.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await panelBody.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  expect(await panelBody.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(readonlyPanel).toBeVisible();
  expect(await readonlyPanel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});
