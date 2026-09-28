import { expect, test, type Page } from "@playwright/test";

// 프로젝트 12개(긴 이름 포함)·재구성 단계 3개·경고가 있는 프로젝트 이동 목 응답. 작업 상태는 조회할 때마다 진행된다.
async function mockApi(page: Page) {
  const requests: Array<{ path: string; body: unknown }> = [];
  const projects = Array.from({ length: 12 }, (_, index) => ({ id: index + 1, name: index === 0 ? "company-monorepo-with-a-really-long-descriptive-name" : `project-${index}`, path: `/home/me/Projects/project-${index}` }));
  const steps = [
    { label: "Git worktree 기록 정리", command: "git worktree prune" },
    { label: "Python 가상환경 재구성 (backend/.venv)", command: "uv venv .venv --python 3.12 && uv pip install -r requirements.txt --python .venv/bin/python" },
    { label: "Node 의존성 설치 (루트)", command: "pnpm install --frozen-lockfile" },
  ];
  let polls = 0;
  let transferPolls = 0;
  const job = (status: "running" | "failed") => ({
    id: "11111111-2222-3333-4444-555555555555", projectPath: "/home/sub/Projects/company-monorepo-with-a-really-long-descriptive-name", status,
    steps: steps.map((step, index) => ({ ...step, status: status === "running" ? (index === 0 ? "succeeded" : index === 1 ? "running" : "pending") : index === 2 ? "failed" : "succeeded",
      output: index === 2 && status === "failed" ? "$ pnpm install --frozen-lockfile\n✗ 대상 컴퓨터에 pnpm이(가) 설치되어 있지 않습니다. 설치 후 프로젝트 폴더에서 'pnpm install --frozen-lockfile'를 실행하세요.\n" : "" })),
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() !== "GET") requests.push({ path: pathname, body: request.postDataJSON?.() ?? null });
    const preview = pathname.match(/^\/api\/projects\/(\d+)\/transfer-preview$/);
    if (preview) return route.fulfill({ json: {
      fileCount: 18342, bytes: 734_003_200, busyChats: preview[1] === "2" ? [1204] : [],
      steps: [{ kind: "python", dir: "backend", venvName: ".venv", pythonVersion: "3.12" }, { kind: "node", dir: "" }],
      warnings: ["config/local-cert.pem → /etc/ssl/private/dev-cert.pem (프로젝트 밖을 가리키는 링크라 대상에서 깨질 수 있음)"],
    } });
    const transfer = (state: string, sentBytes: number) => ({ id: "t1", nodeId: "n1", state, destination: "/home/sub/Projects/company-monorepo-with-a-really-long-descriptive-name", sentBytes, sourceBytes: 734_003_200, ...(state === "done" ? { remoteJob: job("running") } : {}) });
    if (/\/transfer$/.test(pathname)) return route.fulfill({ status: 202, json: { transfer: transfer("uploading", 0), warnings: [] } });
    if (pathname === "/api/project-transfers/t1") {
      transferPolls += 1;
      return route.fulfill({ json: { transfer: transferPolls < 3 ? transfer("uploading", transferPolls * 167_772_160) : transferPolls < 4 ? transfer("extracting", 402_653_184) : transfer("done", 402_653_184) } });
    }
    if (/\/project-transfer\/jobs\//.test(pathname)) { polls += 1; return route.fulfill({ json: { job: job(polls > 1 ? "failed" : "running") } }); }
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "layout-admin", role: "admin", access_scope: "standard" }, csrfToken: "layout-csrf", temporary: false },
      "/api/providers": { providers: [] }, "/api/projects": { projects, defaultPath: "/home/me" }, "/api/usage": { usage: [] },
      "/api/system": { latest: null }, "/api/runtime": {}, "/api/slack": { enabled: false }, "/api/ntfy": { enabled: false }, "/api/approvals": { approvals: [] },
      "/api/auth/sessions": { sessions: [], hasMore: false }, "/api/chats": { chats: [] },
      "/api/projects/1/session-backups": { backups: [] }, "/api/projects/1/git": { status: "## main", commits: [], remotes: "" },
      "/api/projects/1/git/changes": { changes: [] }, "/api/projects/1/git/workspaces": { workspaces: [] },
      "/api/projects/1/github/repositories": { repositories: [], organizations: [] },
      "/api/federation/nodes": { nodes: [
        { id: "n1", name: "사무실 데스크톱(RTX 워크스테이션)", base_url: "http://192.168.0.21:14003", settings_mode: "follow", created_at: "2026-09-20", updated_at: "2026-09-26" },
        { id: "n2", name: "home-nas", base_url: "http://100.88.12.4:14003", settings_mode: "independent", created_at: "2026-09-22", updated_at: "2026-09-26" },
      ] },
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
  await page.getByRole("navigation", { name: "설정 항목" }).getByRole("button", { name: /프로젝트 이동/ }).click();
  const card = page.locator(".project-transfer-card");
  await expect(card).toBeVisible();
  return card;
}

const noHorizontalOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test("1440px: 작업 중 채팅이 있으면 막고, 보내면 대상의 재구성 단계와 실패 원인을 보여준다", async ({ page }) => {
  const requests = await mockApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const card = await openCard(page, false);
  page.on("dialog", (dialog) => void dialog.accept());
  const send = card.getByRole("button", { name: "복사해서 보내기" });

  await card.getByLabel("프로젝트").selectOption("2");
  await expect(card.getByText(/작업 중인 채팅\(#1204\)/)).toBeVisible();
  await expect(send).toBeDisabled();

  await card.getByLabel("프로젝트").selectOption("1");
  await expect(card.getByText("파일 18,342개 · 700.0MB")).toBeVisible();
  await expect(card.getByText(/Python 가상환경 \(backend\/.venv, 3.12\)/)).toBeVisible();
  await expect(card.getByLabel("대상에서 쓸 이름")).toHaveValue("company-monorepo-with-a-really-long-descriptive-name");
  await page.screenshot({ path: "artifacts/ui-project-transfer-1440.png", fullPage: true });

  await send.click();
  await expect(card.getByText(/보내는 중 · 160.0MB 보냄/)).toBeVisible();
  await page.screenshot({ path: "artifacts/ui-project-transfer-1440-uploading.png", fullPage: true });
  await expect(card.getByText("대상 컴퓨터에서 압축을 푸는 중…")).toBeVisible({ timeout: 10_000 });
  await expect(card.getByText(/실행 환경 재구성 진행 중/)).toBeVisible({ timeout: 10_000 });
  await expect(card.getByText(/실행 환경 재구성 일부 실패/)).toBeVisible({ timeout: 10_000 });
  await expect(card.getByText(/pnpm이\(가\) 설치되어 있지 않습니다/)).toBeVisible();
  expect(requests).toContainEqual({ path: "/api/projects/1/transfer", body: { nodeId: "n1", name: "company-monorepo-with-a-really-long-descriptive-name" } });
  await page.screenshot({ path: "artifacts/ui-project-transfer-1440-job.png", fullPage: true });
  expect(await noHorizontalOverflow(page)).toBe(true);
});

test("390px: 긴 경로·명령·경고에서도 가로 넘침이 없다", async ({ page }) => {
  await mockApi(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const card = await openCard(page, true);
  page.on("dialog", (dialog) => void dialog.accept());
  await card.getByLabel("프로젝트").selectOption("1");
  await card.getByRole("button", { name: "복사해서 보내기" }).click();
  await expect(card.getByText(/실행 환경 재구성 일부 실패/)).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: "artifacts/ui-project-transfer-mobile.png", fullPage: true });
  expect(await noHorizontalOverflow(page)).toBe(true);
});
