import { chromium, type CDPSession, type Page } from "@playwright/test";

interface BrowserMetrics {
  heapBytes: number;
  nodes: number;
  listeners: number;
}

// Chromium 성능 지표에서 장기 누적 여부를 볼 핵심 값만 추출한다.
async function browserMetrics(session: CDPSession): Promise<BrowserMetrics> {
  await session.send("HeapProfiler.collectGarbage");
  const response = await session.send("Performance.getMetrics");
  const values = Object.fromEntries(response.metrics.map((metric) => [metric.name, metric.value]));
  return {
    heapBytes: values.JSHeapUsedSize ?? 0,
    nodes: values.Nodes ?? 0,
    listeners: values.JSEventListeners ?? 0,
  };
}

// 인증된 관리 화면을 외부 계정 없이 재현하도록 읽기 API를 고정 응답으로 대체한다.
async function mockApplication(page: Page): Promise<void> {
  await page.addInitScript(() => {
    class FakeWebSocket {
      static OPEN = 1;
      readyState = 1;
      onopen?: () => void;
      onclose?: () => void;
      constructor() { setTimeout(() => this.onopen?.(), 0); }
      send(): void {}
      close(): void { this.onclose?.(); }
    }
    Object.defineProperty(window, "WebSocket", { value: FakeWebSocket });
  });
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "resource-test", role: "admin" }, csrfToken: "resource-test" },
      "/api/providers": { providers: [{ id: "codex", label: "Codex", usageWindowId: "weekly", supportsPermissionMode: false }, { id: "claude", label: "Claude", usageWindowId: "session", supportsPermissionMode: true }] },
      "/api/projects": { projects: [{ id: 1, name: "리소스 점검", path: "/tmp" }] },
      "/api/chats": { chats: [{ id: 1, project_id: 1, provider: "codex", status: "running", title: "리소스 점검", busy: 0 }] },
      "/api/chats/1/messages": { messages: [{ id: "a1", role: "assistant", kind: "text", content: "화면 전환 리소스 점검" }], hasMore: false },
      "/api/usage": { usage: [] },
      "/api/system": { latest: null, recent: [] },
      "/api/runtime": { codex: "disabled", claude: "disabled" },
      "/api/slack": { enabled: false },
      "/api/ntfy": { enabled: false },
      "/api/approvals": { approvals: [] },
      "/api/projects/1/session-backups": { backups: [] },
      "/api/projects/1/files": { path: "", entries: [] },
      "/api/projects/1/instructions": { project: {}, global: {} },
      "/api/projects/1/git/status": { branch: "main", files: [] },
      "/api/projects/1/git/log": { commits: [] },
      "/api/projects/1/github": { authenticated: false },
      "/api/tools": { items: [] },
      "/api/agent-integrations": { providers: [] },
    };
    await route.fulfill({ json: responses[pathname] ?? {} });
  });
}

// 동일 SPA에서 주요 탭을 반복 전환한 전후의 heap·DOM·이벤트 리스너 증가를 검사한다.
async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await mockApplication(page);
    await page.goto(process.env.WEB_AGENT_MANAGER_TEST_URL ?? "http://127.0.0.1:14003");
    await page.getByRole("heading", { name: "운영 대시보드" }).waitFor();
    const session = await page.context().newCDPSession(page);
    await session.send("Performance.enable");
    const before = await browserMetrics(session);
    const tabs = ["채팅", "파일", "지침", "GitHub", "도구", "대시보드"];
    for (let round = 0; round < 20; round += 1) {
      for (const tab of tabs) await page.getByRole("button", { name: tab, exact: true }).click();
    }
    await page.waitForTimeout(500);
    const after = await browserMetrics(session);
    const heapGrowth = after.heapBytes - before.heapBytes;
    const nodeGrowth = after.nodes - before.nodes;
    const listenerGrowth = after.listeners - before.listeners;
    process.stdout.write(`브라우저 리소스: heap ${before.heapBytes} -> ${after.heapBytes}, DOM ${before.nodes} -> ${after.nodes}, listener ${before.listeners} -> ${after.listeners}\n`);
    if (heapGrowth > 8 * 1024 * 1024 || nodeGrowth > 500 || listenerGrowth > 200) {
      throw new Error(`반복 화면 전환 뒤 리소스가 과도하게 증가했습니다: heap=${heapGrowth}, DOM=${nodeGrowth}, listener=${listenerGrowth}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
