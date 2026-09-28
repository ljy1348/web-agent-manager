import { expect, test, type Page } from "@playwright/test";

// 실사용 규모의 연결 컴퓨터 화면: Windows 노드(Claude 앱·Codex 앱 외부 채팅), 긴 프로젝트·채팅 제목, 도구·시스템 기록이 섞인 대화.
// 본문 없는 도구·시스템 메시지가 빈 칸으로 보이던 문제(Windows 실사용)와 좁은 폭 레이아웃을 확인한다.
const projects = [
  { id: 4, name: "ssem", path: "C:\\Users\\me\\Desktop\\ssem" },
  { id: 5, name: "company-internal-billing-dashboard-renewal-2026", path: "C:\\work\\company-internal-billing-dashboard-renewal-2026" },
  ...Array.from({ length: 8 }, (_, index) => ({ id: 10 + index, name: `project-${index}`, path: `C:\\work\\project-${index}` })),
];
const chats = Array.from({ length: 30 }, (_, index) => ({
  id: 26 + index,
  project_id: 4,
  provider: index % 3 === 0 ? "claude" : "codex",
  title: index === 0 ? "Codex 앱에서 시작한 대화: 결제 대시보드 월별 합계가 전월 이월분을 두 번 더하는 버그 원인 찾고 테스트까지 추가" : index % 5 === 0 ? "" : `대화 ${index} — 로그인 화면 문구 정리`,
  status: index === 0 ? "running" : index % 4 === 0 ? "error" : "stopped",
  model: index % 3 === 0 ? "claude-opus-5-5" : "gpt-5.6-sol high",
  updated_at: `2026-09-28T0${index % 10}:00:00.000Z`,
}));
const messages = [
  { id: "m1", role: "user", content: "월별 합계가 이상해. 9월에 8월 이월분이 두 번 들어가는 것 같은데 원인 찾아줘." },
  { id: "m2", role: "system", kind: "project_instructions", content: "# AGENTS.md\n작업 전 history.md를 갱신한다." },
  { id: "m3", role: "tool", content: "rg -n carryOver src/\nsrc/billing/summary.ts:42: total += carryOver" },
  { id: "m4", role: "assistant", content: "원인을 찾았습니다. `summary.ts`에서 이월분을 **두 번** 더합니다.\n\n- 42행: `total += carryOver`\n- 57행: `applyCarryOver(total)`\n\n42행을 지우고 테스트를 추가하겠습니다." },
  { id: "m5", role: "tool", content: "npm test -- billing\n✓ 12 passed" },
  { id: "m6", role: "assistant", content: "수정했고 테스트 12개가 통과했습니다." },
];

async function mockApi(page: Page) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    if (pathname === "/api/federation/nodes") return route.fulfill({ json: { nodes: [
      { id: "node-1", name: "windows-pc", base_url: "http://100.100.20.30:4317", created_at: "2026-09-28", updated_at: "2026-09-28" },
      { id: "node-2", name: "사무실 데스크톱(RTX 워크스테이션)", base_url: "http://192.168.0.21:14003", created_at: "2026-09-28", updated_at: "2026-09-28" },
    ] } });
    if (pathname.startsWith("/api/federation/nodes/node-1/api/")) {
      const remote = pathname.slice("/api/federation/nodes/node-1/api".length);
      if (remote === "/projects") return route.fulfill({ json: { projects } });
      if (remote === "/providers") return route.fulfill({ json: { providers: [{ id: "claude", label: "Claude" }, { id: "codex", label: "Codex" }] } });
      if (remote === "/usage") return route.fulfill({ json: { usage: [
        { provider: "claude", data_status: "fresh", details_json: JSON.stringify({ windows: [{ id: "session", label: "Current session", usedPercent: 12, resetAt: "2026-09-28T09:00:00.000Z" }, { id: "weekly_all", label: "Current week (all models)", usedPercent: 48, resetAt: "2026-10-02T00:00:00.000Z" }] }) },
        { provider: "codex", data_status: "fresh", details_json: JSON.stringify({ windows: [{ id: "primary", label: "5h", usedPercent: 3, resetAt: "2026-09-28T08:00:00.000Z" }, { id: "secondary", label: "Weekly", usedPercent: 61, resetAt: "2026-10-03T17:12:37.000Z" }] }) },
      ] } });
      if (remote === "/approvals") return route.fulfill({ json: { approvals: [] } });
      if (remote === "/chats") return route.fulfill({ json: { chats: chats.filter((chat) => String(chat.project_id) === url.searchParams.get("projectId")) } });
      if (/^\/chats\/\d+\/messages$/.test(remote)) return route.fulfill({ json: { messages } });
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
}

const noHorizontalOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

for (const viewport of [{ name: "desktop", width: 1440, height: 1000 }, { name: "laptop", width: 1024, height: 800 }, { name: "mobile", width: 390, height: 844 }]) {
  test(`연결 컴퓨터 화면은 도구·시스템 기록을 빈 칸으로 보여주지 않는다 (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await mockApi(page);
    await page.goto("/");
    if (viewport.width < 700) {
      await page.getByRole("button", { name: "더보기", exact: true }).click();
      await page.getByRole("dialog", { name: "더보기" }).getByRole("button", { name: /컴퓨터/ }).click();
    } else {
      await page.locator("header nav").getByRole("button", { name: "컴퓨터", exact: true }).click();
    }
    const view = page.locator(".federation-page");
    await expect(view).toContainText("수정했고 테스트 12개가 통과했습니다.");
    await page.screenshot({ path: `artifacts/ui-federation-${viewport.name}.png`, fullPage: false });
    // 본문 없는 메시지(도구 실행·프로젝트 지침)는 빈 칸으로 렌더링되지 않아야 한다.
    const emptyCards = await view.locator(".federation-messages .message").evaluateAll((items) => items.filter((item) => !(item.textContent || "").replace(/^(user|assistant|tool|system)/, "").trim()).length);
    expect(emptyCards).toBe(0);
    expect(await noHorizontalOverflow(page)).toBe(true);
  });
}
