import fs from "node:fs";
import { expect, test } from "@playwright/test";

// 요청한 개수만큼 커밋을 만들어 준다. 실제 서버처럼 요청 개수보다 많으면 hasMore를 세운다.
function commitPage(limit: number, total: number): Record<string, unknown> {
  const commits = Array.from({ length: Math.min(limit, total) }, (_item, index) => ({
    hash: `c${String(total - index).padStart(4, "0")}`,
    author: "tester",
    date: "2026-08-10T00:00:00+09:00",
    subject: `커밋 ${total - index}`,
  }));
  return { status: "", log: "", commits, hasMoreCommits: total > limit, remotes: "" };
}

// GitHub 목록도 같은 방식으로 요청 개수만큼 잘라서 준다.
function githubPage(pullLimit: number, totalPulls: number): Record<string, unknown> {
  const pullRequests = Array.from({ length: Math.min(pullLimit, totalPulls) }, (_item, index) => ({
    number: totalPulls - index,
    title: `PR 제목 ${totalPulls - index}`,
    state: "MERGED",
    url: "https://example.com",
    headRefName: "feat/x",
    baseRefName: "main",
    updatedAt: "2026-08-10T00:00:00Z",
    author: { login: "tester" },
  }));
  return {
    repository: { nameWithOwner: "tester/sample", url: "https://example.com", defaultBranchRef: { name: "main" } },
    issues: [],
    pullRequests,
    runs: [],
    hasMore: { issues: false, pullRequests: totalPulls > pullLimit, runs: false },
    errors: {},
  };
}

// 좁은 화면에서 이슈를 고르면 목록 아래 상세로 옮겨 주는지 본다.
test("모바일에서 이슈를 고르면 상세가 화면 안으로 들어온다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/projects/1/github") {
      const issues = Array.from({ length: 40 }, (_item, index) => ({
        number: 40 - index,
        title: `이슈 제목 ${40 - index}`,
        state: "OPEN",
        url: "https://example.com",
        updatedAt: "2026-08-10T00:00:00Z",
        author: { login: "tester" },
      }));
      await route.fulfill({ json: {
        repository: { nameWithOwner: "tester/sample", url: "https://example.com", defaultBranchRef: { name: "main" } },
        issues, pullRequests: [], runs: [],
        hasMore: { issues: false, pullRequests: false, runs: false }, errors: {},
      } });
      return;
    }
    if (/^\/api\/projects\/1\/github\/issue\/\d+$/.test(pathname)) {
      await route.fulfill({ json: { issue: {
        number: 40, title: "이슈 제목 40", state: "OPEN", url: "https://example.com",
        body: Array.from({ length: 40 }, (_item, index) => `이슈 본문 ${index + 1}번째 줄입니다.`).join("\n\n"), author: { login: "tester" }, updatedAt: "2026-08-10T00:00:00Z", comments: [],
      } } });
      return;
    }
    if (pathname === "/api/projects/1/git") {
      await route.fulfill({ json: { status: "", log: "", commits: [], hasMoreCommits: false, remotes: "" } });
      return;
    }
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "ui-test", role: "admin" }, csrfToken: "ui-test" },
      "/api/providers": { providers: [] },
      "/api/projects": { projects: [{ id: 1, name: "샘플 프로젝트", path: "/home/testuser/myagent" }] },
      "/api/usage": { usage: [] },
      "/api/system": { latest: null },
      "/api/runtime": { codex: "disabled", claude: "disabled" },
      "/api/slack": { enabled: false },
      "/api/ntfy": { enabled: false },
      "/api/approvals": { approvals: [] },
      "/api/chats": { chats: [] },
      "/api/projects/1/git/changes": { changes: [] },
      "/api/projects/1/git/diff": { diff: "" },
    };
    await route.fulfill({ json: pathname in responses ? responses[pathname] : {} });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "GitHub", exact: true }).click();
  await page.locator(".git-tabs").getByRole("button", { name: "깃허브", exact: true }).click();

  // 목록이 길어 상세는 처음엔 화면 밖에 있다.
  const detail = page.locator(".github-detail");
  const list = page.locator(".github-list");
  await expect(list).toBeVisible();
  await expect(detail).not.toBeInViewport();
  await page.locator(".github-list > button").first().click();

  // 고르고 나면 목록이 접히고 상세가 화면 위로 올라온다.
  await expect(list).toBeHidden();
  await expect(detail).toContainText("이슈 제목 40");
  await expect(detail).toContainText("이슈 본문 1번째 줄입니다.");
  await expect(detail).toBeInViewport();
  // 화면 안에 걸치기만 해서는 안 된다 — 상세 위쪽이 화면 상단 근처에 와야 바로 읽을 수 있다.
  // (스크롤이 접힘과 겹치면 상세 중간에서 멈춰 위쪽이 화면 밖으로 밀려났었다.)
  await expect.poll(async () => (await detail.boundingBox())?.y ?? -1, { timeout: 5000 }).toBeLessThan(200);
  // 화면 맨 위에 딱 붙으면 서브픽셀 오차로 살짝 음수가 나올 수 있다 — 위로 크게 밀려나지만 않으면 된다.
  expect((await detail.boundingBox())?.y ?? -9999).toBeGreaterThan(-20);

  fs.mkdirSync("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/ui-git-issue-detail-mobile.png" });

  // 본문은 안쪽에서 따로 스크롤되지 않고 내용 전체 높이만큼 늘어난다.
  const body = page.locator(".github-body");
  const overflow = await body.evaluate((element) => ({
    scrollable: element.scrollHeight > element.clientHeight + 1,
    overflowY: getComputedStyle(element).overflowY,
  }));
  expect(overflow.scrollable).toBe(false);
  expect(overflow.overflowY).toBe("visible");

  // 토글로 목록을 다시 펼 수 있다.
  await page.locator(".github-list-toggle").click();
  await expect(list).toBeVisible();
});

// 서버가 저장소 정보 없는 응답을 주더라도(캐시 경쟁으로 `{cachedAt}`만 나가던 사례) 화면이 살아 있어야 한다.
test("GitHub 응답에 저장소 정보가 없어도 흰 화면이 되지 않는다", async ({ page }) => {
  const crashes: string[] = [];
  page.on("pageerror", (error) => crashes.push(error.message));
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (/^\/api\/projects\/\d+\/github$/.test(pathname)) {
      // 첫 조회가 끝나기 전 두 번째 요청이 받던 바로 그 응답이다.
      await route.fulfill({ json: { cachedAt: "1970-01-01T00:00:00.000Z" } });
      return;
    }
    if (/^\/api\/projects\/\d+\/git$/.test(pathname)) {
      await route.fulfill({ json: { status: "", log: "", commits: [], hasMoreCommits: false, remotes: "" } });
      return;
    }
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "ui-test", role: "admin" }, csrfToken: "ui-test" },
      "/api/providers": { providers: [] },
      "/api/projects": { projects: [
        { id: 1, name: "프로젝트 하나", path: "/home/testuser/one" },
        { id: 2, name: "프로젝트 둘", path: "/home/testuser/two" },
      ] },
      "/api/usage": { usage: [] },
      "/api/system": { latest: null },
      "/api/runtime": { codex: "disabled", claude: "disabled" },
      "/api/slack": { enabled: false },
      "/api/ntfy": { enabled: false },
      "/api/approvals": { approvals: [] },
      "/api/chats": { chats: [] },
    };
    if (pathname in responses) { await route.fulfill({ json: responses[pathname] }); return; }
    if (/git\/changes$/.test(pathname)) { await route.fulfill({ json: { changes: [] } }); return; }
    if (/git\/diff$/.test(pathname)) { await route.fulfill({ json: { diff: "" } }); return; }
    if (/git\/workspaces$/.test(pathname)) { await route.fulfill({ json: { workspaces: [] } }); return; }
    if (/git\/workspace$/.test(pathname)) { await route.fulfill({ json: { branches: [] } }); return; }
    await route.fulfill({ json: {} });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "GitHub", exact: true }).click();
  await page.locator(".git-tabs").getByRole("button", { name: "깃허브", exact: true }).click();
  await expect(page.getByText("gh 인증 또는 원격 저장소가 필요합니다.")).toBeVisible();

  // 프로젝트를 바꿔도 화면이 사라지지 않는다.
  await page.locator(".project-bar select").selectOption("2");
  await expect(page.getByText("gh 인증 또는 원격 저장소가 필요합니다.")).toBeVisible();
  await expect(page.locator(".git-tabs")).toBeVisible();
  expect(crashes).toEqual([]);
});

// 모바일에서 커밋을 고르면 긴 목록을 접고 상세로 이동하는지, 설명이 안쪽에서 따로 스크롤되지 않는지 본다.
test("모바일에서 커밋을 고르면 목록을 접고 상세를 보여주며 설명은 페이지 흐름을 따른다", async ({ page }) => {
  const longBody = Array.from({ length: 60 }, (_item, index) => `설명 ${index + 1}번째 줄`).join("\n");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/projects/1/git") {
      await route.fulfill({ json: commitPage(30, 45) });
      return;
    }
    if (pathname.startsWith("/api/projects/1/git/commit/")) {
      await route.fulfill({ json: { diff: "", commit: { subject: "커밋 45", author: "tester", date: "2026-08-10T00:00:00+09:00", body: longBody } } });
      return;
    }
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "ui-test", role: "admin" }, csrfToken: "ui-test" },
      "/api/providers": { providers: [] },
      "/api/projects": { projects: [{ id: 1, name: "샘플 프로젝트", path: "/home/testuser/myagent" }] },
      "/api/usage": { usage: [] },
      "/api/system": { latest: null },
      "/api/runtime": { codex: "disabled", claude: "disabled" },
      "/api/slack": { enabled: false },
      "/api/ntfy": { enabled: false },
      "/api/approvals": { approvals: [] },
      "/api/chats": { chats: [] },
      "/api/projects/1/git/changes": { changes: [] },
      "/api/projects/1/git/diff": { diff: "" },
    };
    await route.fulfill({ json: pathname in responses ? responses[pathname] : {} });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "GitHub", exact: true }).click();

  // 좁은 화면에서는 목록이 접혀 있다. 펼쳐서 커밋을 고른다.
  const sidebar = page.locator(".git-sidebar");
  await expect(sidebar).toBeHidden();
  await page.locator(".git-sidebar-toggle").click();
  await expect(sidebar).toBeVisible();
  await page.locator(".commit-list button").first().click();

  // 목록이 다시 접히고 커밋 상세가 화면 안에 들어온다.
  await expect(sidebar).toBeHidden();
  const detail = page.locator(".commit-detail");
  await expect(detail).toBeVisible();
  await expect(detail).toBeInViewport();
  await expect.poll(async () => (await detail.boundingBox())?.y ?? -1, { timeout: 5000 }).toBeLessThan(200);
  // 화면 맨 위에 딱 붙으면 서브픽셀 오차로 살짝 음수가 나올 수 있다 — 위로 크게 밀려나지만 않으면 된다.
  expect((await detail.boundingBox())?.y ?? -9999).toBeGreaterThan(-20);

  // 설명은 안쪽에서 따로 스크롤되지 않고 내용 전체 높이만큼 늘어난다.
  const body = page.locator("pre.commit-body");
  await expect(body).toBeVisible();
  const overflow = await body.evaluate((element) => ({
    scrollable: element.scrollHeight > element.clientHeight + 1,
    overflowY: getComputedStyle(element).overflowY,
  }));
  expect(overflow.scrollable).toBe(false);
  expect(overflow.overflowY).toBe("visible");

  fs.mkdirSync("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/ui-git-commit-detail-mobile.png" });
});

test("커밋과 PR 목록을 더 보기로 이어서 불러온다", async ({ page }) => {
  const commitLimits: number[] = [];
  const pullLimits: number[] = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    if (pathname === "/api/projects/1/git") {
      const limit = Number(url.searchParams.get("commits") ?? 30);
      commitLimits.push(limit);
      await route.fulfill({ json: commitPage(limit, 45) });
      return;
    }
    if (pathname === "/api/projects/1/github") {
      const limit = Number(url.searchParams.get("pulls") ?? 50);
      pullLimits.push(limit);
      await route.fulfill({ json: githubPage(limit, 70) });
      return;
    }
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "ui-test", role: "admin" }, csrfToken: "ui-test" },
      "/api/providers": { providers: [] },
      "/api/projects": { projects: [{ id: 1, name: "샘플 프로젝트", path: "/home/testuser/myagent" }] },
      "/api/usage": { usage: [] },
      "/api/system": { latest: null },
      "/api/runtime": { codex: "disabled", claude: "disabled" },
      "/api/slack": { enabled: false },
      "/api/ntfy": { enabled: false },
      "/api/approvals": { approvals: [] },
      "/api/chats": { chats: [] },
      "/api/projects/1/git/changes": { changes: [] },
      "/api/projects/1/git/diff": { diff: "" },
    };
    await route.fulfill({ json: pathname in responses ? responses[pathname] : {} });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "GitHub", exact: true }).click();

  // 커밋: 첫 조회는 30개까지만 오고 더 보기 버튼이 보인다.
  const commitButtons = page.locator(".commit-list button");
  await expect(commitButtons).toHaveCount(30);
  await expect(page.getByRole("button", { name: "커밋 더 보기" })).toBeVisible();
  fs.mkdirSync("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/ui-git-commit-more.png", fullPage: true });

  // 더 보기를 누르면 남은 15개까지 채워지고, 더 없으면 버튼이 사라진다.
  await page.getByRole("button", { name: "커밋 더 보기" }).click();
  await expect(commitButtons).toHaveCount(45);
  await expect(page.getByRole("button", { name: "커밋 더 보기" })).toHaveCount(0);
  // 개발 모드 StrictMode가 effect를 두 번 실행하므로 횟수 대신 요청된 개수만 확인한다.
  expect(commitLimits.at(-1)).toBe(60);
  expect([...new Set(commitLimits)].sort((a, b) => a - b)).toEqual([30, 60]);
  await page.screenshot({ path: "artifacts/ui-git-commit-loaded.png", fullPage: true });

  // PR: 같은 방식으로 50개 → 70개까지 이어서 불러온다.
  await page.locator(".git-tabs").getByRole("button", { name: "깃허브", exact: true }).click();
  await page.locator(".git-subtabs").getByRole("button", { name: "PR", exact: true }).click();
  const pullButtons = page.locator(".github-list > button:not(.list-more)");
  await expect(pullButtons).toHaveCount(50);
  await expect(page.getByRole("button", { name: "PR 더 보기" })).toBeVisible();
  await page.screenshot({ path: "artifacts/ui-git-pr-more.png", fullPage: true });

  await page.getByRole("button", { name: "PR 더 보기" }).click();
  await expect(pullButtons).toHaveCount(70);
  await expect(page.getByRole("button", { name: "PR 더 보기" })).toHaveCount(0);
  expect(pullLimits.at(-1)).toBe(100);
  await page.screenshot({ path: "artifacts/ui-git-pr-loaded.png", fullPage: true });

  // 커밋 더 보기가 GitHub 목록까지 다시 읽게 만들지는 않는지 확인한다.
  const githubCallsBefore = pullLimits.length;
  await page.locator(".git-tabs").getByRole("button", { name: "로컬", exact: true }).click();
  await expect(commitButtons).toHaveCount(45);
  expect(pullLimits.length).toBe(githubCallsBefore);
});
