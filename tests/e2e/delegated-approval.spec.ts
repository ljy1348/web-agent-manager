import { expect, test, type Page } from "@playwright/test";

// 실제 API처럼 위임 자식 채팅(#1249)은 채팅 목록에서 빠진 상태에서, 그 권한 요청이 부모(#1070)·자식 화면에
// 보이고 다른 프로젝트의 요청은 섞이지 않는지 확인한다(#150, 2026-09-28 운영에서 요청이 안 보여 Codex가 우회함).
async function mockApi(page: Page) {
  const decisions: unknown[] = [];
  let pending = true;
  await page.routeWebSocket("**/ws", () => undefined);
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/approvals") {
      return route.fulfill({ json: { approvals: [
        ...(pending ? [{
          id: "child-approval", chat_id: 1249, chat_title: "긴 메시지 원문을 다음 첨부 파일에 저장했습니다", chat_project_id: 1, chat_origin: "delegation",
          provider: "codex", status: "pending", request_type: "permission", delegation_source_chat_id: 1070,
          request_payload: JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -f /tmp/review-list-1249.json; node - <<'NODE' …" } }),
        }] : []),
        {
          id: "other-project", chat_id: 77, chat_title: "다른 프로젝트 작업", chat_project_id: 2, chat_origin: "user",
          provider: "claude", status: "pending", request_type: "permission",
          request_payload: JSON.stringify({ tool_name: "Bash", tool_input: { command: "echo other-project-secret" } }),
        },
      ] } });
    }
    if (pathname === "/api/approvals/child-approval/decision" && request.method() === "POST") {
      decisions.push(request.postDataJSON());
      pending = false;
      return route.fulfill({ json: { ok: true } });
    }
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "ui-test", role: "admin" }, csrfToken: "ui-test" },
      "/api/providers": { providers: [{ id: "codex", label: "Codex", usageWindowId: "weekly", supportsPermissionMode: false }] },
      "/api/projects": { projects: [{ id: 1, name: "resume", path: "/workspace/resume" }] },
      // 위임 자식 #1249는 목록에 없다(실제 API는 origin=delegation을 목록에서 뺀다).
      "/api/chats": { chats: [{ id: 1070, project_id: 1, provider: "codex", status: "stopped", title: "매일마다 사람인·잡코리아·원티드를 조회해서 이력서를 새로 만들고", busy: 0 }] },
      "/api/chats/1249": { chat: { id: 1249, project_id: 1, provider: "codex", status: "running", busy: 1, origin: "delegation", title: "긴 메시지 원문을 다음 첨부 파일에 저장했습니다" } },
      "/api/chats/1070/messages": { messages: [{ id: "m1", role: "assistant", kind: "text", content: "하위 작업을 위임했습니다." }], hasMore: false },
      "/api/chats/1249/messages": { messages: [{ id: "m2", role: "user", kind: "text", content: "공고를 수집해 주세요." }], hasMore: false },
      "/api/projects/1/session-backups": { backups: [] }, "/api/projects/1/agent-delegations": { delegations: [] },
      "/api/models/codex": { options: { provider: "codex", models: [], efforts: [] } },
      "/api/usage": { usage: [] }, "/api/system": { latest: null }, "/api/runtime": {}, "/api/slack": { enabled: false }, "/api/ntfy": { enabled: false },
    };
    await route.fulfill({ json: pathname in responses ? responses[pathname] : {} });
  });
  return decisions;
}

test("위임 자식 채팅의 권한 요청이 부모 화면에 보이고 승인할 수 있으며 다른 프로젝트 요청은 섞이지 않는다", async ({ page }) => {
  const decisions = await mockApi(page);
  await page.goto("/?chat=1070");
  await expect(page.getByText("rm -f /tmp/review-list-1249.json").first()).toBeVisible();
  await expect(page.getByText("echo other-project-secret")).toHaveCount(0);
  await page.screenshot({ path: "artifacts/ui-delegated-approval-parent.png", fullPage: true });
  await page.getByRole("button", { name: /^승인|허용/ }).first().click();
  await expect.poll(() => decisions.length).toBe(1);
});

test("푸시로 위임 자식 채팅을 직접 열어도 그 권한 요청이 보인다", async ({ page }) => {
  await mockApi(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?chat=1249");
  await expect(page.getByText("rm -f /tmp/review-list-1249.json").first()).toBeVisible();
  await expect(page.getByText("echo other-project-secret")).toHaveCount(0);
  await page.screenshot({ path: "artifacts/ui-delegated-approval-child-mobile.png", fullPage: true });
});
