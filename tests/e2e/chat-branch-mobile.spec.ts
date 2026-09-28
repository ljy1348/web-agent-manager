import { expect, test, type Page } from "@playwright/test";

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
// 모바일 채팅 헤더의 브랜치 칩이 긴 브랜치명에서도 이름을 알아볼 수 있는지 확인한다(#132).
test("모바일 채팅 헤더 브랜치 칩은 긴 이름의 뒷부분을 보여주고 편집 창에 전체 이름을 표시한다", async ({ page }) => {
  const branchRequests: Record<string, unknown>[] = [];
  const worktreeChatRequests: Record<string, unknown>[] = [];
  const diffRequests: string[] = [];
  let workspace = {
    chatId: 11,
    branch: "feat/multi-wam-federation",
    path: "/workspace/sample",
    mode: "shared",
    dirty: false,
    canSwitch: true,
    branches: [
      { name: "main", remote: false, checkedOutPath: null },
      { name: "feat/multi-wam-federation", remote: false, checkedOutPath: "/workspace/sample" },
      { name: "feature/existing", remote: false, checkedOutPath: null },
    ],
    worktrees: [{ path: "/workspace/agent-worktree", branch: "feature/agent", main: false, appManaged: false, assignedChatId: null }],
  };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "ui-test", role: "admin" }, csrfToken: "ui-test" },
      "/api/providers": { providers: [{ id: "codex", label: "Codex", usageWindowId: "weekly", supportsPermissionMode: false }] },
      "/api/projects": { projects: [{ id: 1, name: "샘플 프로젝트", path: "/workspace/sample" }] },
      "/api/chats": { chats: [{ id: 11, project_id: 1, provider: "codex", status: "stopped", title: "브랜치 작업 본인인증 지문인식 및 메시지 표시 개선", git_branch: workspace.branch, worktree_path: workspace.mode === "worktree" ? workspace.path : null }] },
      "/api/chats/11/messages": { messages: [], hasMore: false },
      "/api/chats/12/messages": { messages: [], hasMore: false },
      "/api/projects/1/session-backups": { backups: [] },
      "/api/models/codex": { options: { provider: "codex", models: [], efforts: [] } },
      "/api/projects/1/git": { status: `## ${workspace.branch}`, commits: [], remotes: "" },
      "/api/projects/1/git/changes": { changes: [{ path: "src/selected.ts", indexStatus: " ", worktreeStatus: "M" }, { path: "src/deleted.ts", indexStatus: " ", worktreeStatus: "D" }] },
      "/api/projects/1/git/workspaces": { workspaces: [{ path: "/workspace/sample", branch: "main", main: true, appManaged: false, assignedChatId: null }, ...workspace.worktrees] },
      "/api/projects/1/github/repositories": { repositories: [], organizations: [] },
      "/api/usage": { usage: [] },
      "/api/system": { latest: null },
      "/api/runtime": { codex: "disabled", claude: "disabled" },
      "/api/slack": { enabled: false },
      "/api/ntfy": { enabled: false },
      "/api/approvals": { approvals: [] },
    };
    if (pathname === "/api/projects/1/git/workspace") {
      await route.fulfill({ json: workspace });
      return;
    }
    if (pathname === "/api/chats/worktree" && route.request().method() === "POST") {
      worktreeChatRequests.push(JSON.parse(route.request().postData() || "{}"));
      await route.fulfill({ status: 201, json: { chat: { id: 12, project_id: 1, provider: "codex", status: "stopped", title: "feature/agent 작업", git_branch: "feature/agent", worktree_path: "/workspace/agent-worktree", workspace_validation_status: "needs_review", workspace_validation_json: JSON.stringify({ issues: ["profile_not_pinned"] }) } } });
      return;
    }
    if (pathname === "/api/projects/1/git/branch" && route.request().method() === "POST") {
      const body = JSON.parse(route.request().postData() || "{}");
      branchRequests.push(body);
      workspace = { ...workspace, branch: String(body.branch), mode: body.mode, path: body.mode === "worktree" ? "/data/git-worktrees/1/11" : "/workspace/sample" };
      await route.fulfill({ json: workspace });
      return;
    }
    if (pathname === "/api/projects/1/git/diff") {
      diffRequests.push(url.search);
      const deletedDiff = url.searchParams.getAll("file").includes("src/deleted.ts") ? "\ndiff --git a/src/deleted.ts b/src/deleted.ts\n--- a/src/deleted.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-deleted change" : "";
      await route.fulfill({ json: { diff: `diff --git a/src/selected.ts b/src/selected.ts\n--- a/src/selected.ts\n+++ b/src/selected.ts\n@@ -1 +1 @@\n-old\n+selected change${deletedDiff}` } });
      return;
    }
    if (pathname in responses) {
      await route.fulfill({ json: responses[pathname] });
      return;
    }
    await route.fulfill({ json: {} });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "채팅", exact: true }).click();
  // 채팅이 하나도 없는 worktree도 묶음으로 남아야 한다. 채팅 목록만으로 묶음을 만들면 워크트리가
  // 지워진 것인지 채팅만 없는 것인지 화면에서 구분할 수 없다.
  const emptyGroup = page.locator(".chat-list .chat-group").filter({ hasText: "feature/agent 워크트리" });
  await expect(emptyGroup.locator(".chat-group-count")).toHaveText("0");
  await expect(emptyGroup.locator(".chat-group-empty")).toBeVisible();
  await emptyGroup.getByRole("button", { name: "+ Codex" }).click();
  // 브랜치만 넘기면 앱 관리 경로에 새 worktree를 만들려 하므로, 기존 폴더 경로를 함께 보내야 한다.
  expect(worktreeChatRequests).toEqual([{ projectId: 1, provider: "codex", accountId: null, branch: "feature/agent", worktreePath: "/workspace/agent-worktree", create: false, title: "feature/agent 작업" }]);
  await expect(page.getByText("Worktree profile·지침 검토 필요", { exact: true })).toBeVisible();
  await page.locator(".chat-list .chat-item").filter({ hasText: "브랜치 작업" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  const control = page.locator(".git-branch-control").first();
  await expect(control).toBeVisible();
  // 접두어·배지·화살표를 숨겨 좁은 칩에 이름 뒷부분이 60px 넘게 보여야 한다.
  await expect(control.locator(".git-branch-prefix")).toBeHidden();
  await expect(control.locator(".git-workspace-badge")).toBeHidden();
  expect(await control.locator(".git-branch-trigger code").evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(60);
  await page.screenshot({ path: "artifacts/ui-chat-branch-mobile-long.png" });
  await control.getByRole("button", { name: "Git 작업공간 변경" }).click();
  await expect(control.locator(".git-branch-editor")).toBeVisible();
  await page.screenshot({ path: "artifacts/ui-chat-branch-mobile-long-open.png" });
  await expect(control.locator(".git-branch-current code")).toHaveText("feat/multi-wam-federation");
  expect(await noOverflow(page)).toBe(true);
});
