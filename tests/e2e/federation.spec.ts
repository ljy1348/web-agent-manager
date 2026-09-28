import { expect, test } from "@playwright/test";

test("one computer keeps the usual tabs; adding a WAM reveals remote chat management", async ({ page }) => {
  const nodes: Array<{ id: string; name: string; base_url: string; created_at: string; updated_at: string }> = [];
  const sent: string[] = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    const method = route.request().method();
    if (pathname === "/api/federation/nodes" && method === "GET") return route.fulfill({ json: { nodes } });
    if (pathname === "/api/federation/nodes" && method === "POST") {
      const body = JSON.parse(route.request().postData() || "{}");
      nodes.push({ id: "node-1", name: body.name, base_url: body.url, created_at: "2026-09-24", updated_at: "2026-09-24" });
      return route.fulfill({ status: 201, json: { node: nodes[0] } });
    }
    if (pathname === "/api/federation/agent-tokens" && method === "GET") return route.fulfill({ json: { tokens: [] } });
    if (pathname === "/api/federation/agent-tokens" && method === "POST") return route.fulfill({ status: 201, json: { token: "test-token-012345678901234567890123456789" } });
    if (pathname.startsWith("/api/federation/nodes/node-1/api/")) {
      const remote = pathname.slice("/api/federation/nodes/node-1/api".length);
      if (remote === "/projects") return route.fulfill({ json: { projects: [{ id: 3, name: "원격 프로젝트", path: "/work" }] } });
      if (remote === "/providers") return route.fulfill({ json: { providers: [{ id: "codex", name: "Codex" }] } });
      if (remote === "/usage") return route.fulfill({ json: { usage: [{ provider: "codex", data_status: "fresh" }] } });
      if (remote === "/approvals") return route.fulfill({ json: { approvals: [] } });
      if (remote === "/chats" && method === "GET") return route.fulfill({ json: { chats: [{ id: 9, title: "원격 채팅", provider: "codex", project_id: 3, status: "running" }] } });
      if (remote === "/chats/9/messages" && method === "GET") return route.fulfill({ json: { messages: [] } });
      if (remote === "/chats/9/messages" && method === "POST") { sent.push(JSON.parse(route.request().postData() || "{}").text); return route.fulfill({ status: 202, json: { accepted: true } }); }
      return route.fulfill({ json: {} });
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
  await expect(page.locator("header nav").getByRole("button", { name: "컴퓨터", exact: true })).toHaveCount(0);
  await page.locator("header nav").getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("navigation", { name: "설정 항목" }).getByRole("button", { name: /컴퓨터 연결/ }).click();
  const card = page.locator(".federation-settings-card");
  await expect(card).toContainText("이 컴퓨터만 사용");
  await card.getByRole("button", { name: "이 컴퓨터의 연결 토큰 만들기" }).click();
  await expect(card).toContainText("test-token-012345678901234567890123456789");
  await card.getByLabel("이름").fill("작업용 PC");
  await card.getByLabel("원격 WAM 주소").fill("https://remote.example.test/");
  await card.getByLabel("원격 컴퓨터에서 만든 연결 토큰").fill("test-token-012345678901234567890123456789");
  await card.getByRole("button", { name: "연결 확인·추가" }).click();
  const computers = page.locator("header nav").getByRole("button", { name: "컴퓨터", exact: true });
  await expect(computers).toBeVisible();
  await computers.click();
  await expect(page.locator(".federation-page")).toContainText("원격 프로젝트");
  await expect(page.locator(".federation-page")).toContainText("원격 채팅");
  await page.getByPlaceholder("원격 컴퓨터의 채팅에 메시지 보내기").fill("두 번째 컴퓨터에서 실행해줘");
  await page.locator(".federation-page").getByRole("button", { name: "전송", exact: true }).click();
  await expect.poll(() => sent).toEqual(["두 번째 컴퓨터에서 실행해줘"]);
});
