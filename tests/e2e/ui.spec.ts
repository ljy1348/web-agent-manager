import fs from "node:fs";
import { expect, test } from "@playwright/test";

test("로그인 후 대시보드와 채팅 화면을 렌더링한다", async ({ page }) => {
  const username = process.env.WEB_AGENT_MANAGER_TEST_USERNAME ?? process.env.MYAGENT_TEST_USERNAME;
  const password = process.env.WEB_AGENT_MANAGER_TEST_PASSWORD ?? process.env.MYAGENT_TEST_PASSWORD;
  if (!username || !password) { test.skip(true, "테스트 계정 환경변수가 없습니다."); return; }
  await page.goto("/");
  await page.getByLabel("아이디").fill(username);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page.getByRole("heading", { name: "운영 대시보드" })).toBeVisible();
  await expect(page.locator(".project-bar select")).not.toHaveValue("");
  fs.mkdirSync("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/ui-dashboard.png", fullPage: true });
});

test("터미널 토글과 모바일 채팅 메뉴를 렌더링한다", async ({ page }) => {
  const renameRequests: Record<string, unknown>[] = [];
  const deleteBackupRequests: string[] = [];
  let backupDeleted = false;
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "ui-test", role: "admin" }, csrfToken: "ui-test" },
      "/api/providers": { providers: [{ id: "codex", label: "Codex", usageWindowId: "weekly", supportsPermissionMode: false }, { id: "claude", label: "Claude", usageWindowId: "session", supportsPermissionMode: true }] },
      "/api/projects": { projects: [{ id: 1, name: "샘플 프로젝트", path: "/home/testuser/myagent" }] },
      "/api/usage": { usage: [] },
      "/api/system": { latest: null },
      "/api/runtime": { codex: "disabled", claude: "disabled" },
      "/api/slack": { enabled: false },
      "/api/approvals": { approvals: [] },
    };
    if (pathname in responses) {
      await route.fulfill({ json: responses[pathname] });
      return;
    }
    if (pathname === "/api/chats") {
      await route.fulfill({ json: { chats: [{ id: 1, provider: "codex", status: "running", title: "모바일 UI 확인" }] } });
      return;
    }
    if (pathname === "/api/projects/1/session-backups") {
      await route.fulfill({ json: { backups: backupDeleted ? [] : [{ id: "codex-backup-1", provider: "codex", title: "백업된 세션", backedUpAt: "2026-07-11T00:00:00.000Z", chatExists: false }] } });
      return;
    }
    if (pathname === "/api/session-backups/codex-backup-1" && route.request().method() === "DELETE") {
      deleteBackupRequests.push(pathname);
      backupDeleted = true;
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    if (pathname === "/api/chats/1/messages") {
      await route.fulfill({ json: { messages: [{ id: "u1", role: "user", kind: "text", content: "모바일에서도 채팅에 집중하고 싶어." }, { id: "a1", role: "assistant", kind: "text", content: "프로젝트와 새 채팅은 햄버거 메뉴에서 관리할 수 있습니다. very_long_unbroken_response_text_that_must_wrap_without_horizontal_scrolling\n```diff\n-old line\n+new line\n```" }, { id: "t1", role: "tool", kind: "function_call_output", content: "diff --git a/file b/file\n도구 실행 결과" }, { id: "a2", role: "assistant", kind: "text", content: "화면 확인: [첨부: artifacts/missing.png]" }] } });
      return;
    }
    if (pathname === "/api/projects/1/files/download") {
      await route.fulfill({ status: 404, json: { error: "ENOENT: no such file or directory" } });
      return;
    }
    if (pathname === "/api/chats/1/rename" && route.request().method() === "POST") {
      renameRequests.push(JSON.parse(route.request().postData() || "{}"));
      await route.fulfill({ json: { accepted: true } });
      return;
    }
    await route.fulfill({ json: {} });
  });

  await page.goto("/");
  await expect(page.locator(".brand b")).toHaveText("web-agent-manager");
  expect(await page.locator("header").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(page.getByRole("heading", { name: "운영 대시보드" })).toBeVisible();
  await page.getByRole("button", { name: "채팅", exact: true }).click();
  await expect(page.getByRole("heading", { name: "채팅", exact: true })).toBeVisible();
  await expect(page.locator(".terminal-panel")).toHaveCount(0);
  await expect(page.getByText("프로젝트와 새 채팅은 햄버거 메뉴에서 관리할 수 있습니다.", { exact: false })).toBeVisible();
  // Claude·Codex 둘 다 CLI 자체 /rename 명령을 지원하므로, 제목의 편집 버튼으로 그 명령을 실제로
  // 보낼 수 있어야 한다. Esc로는 아무 요청도 안 나가고 편집 상태만 닫혀야 한다.
  await page.getByRole("button", { name: "채팅 이름 변경" }).click();
  const titleInput = page.getByLabel("채팅 이름", { exact: true });
  await expect(titleInput).toHaveValue("모바일 UI 확인");
  await titleInput.press("Escape");
  await expect(titleInput).toHaveCount(0);
  expect(renameRequests).toHaveLength(0);
  await page.getByRole("button", { name: "채팅 이름 변경" }).click();
  await titleInput.fill("리네임 테스트");
  await page.getByRole("button", { name: "저장" }).click();
  await expect(titleInput).toHaveCount(0);
  expect(renameRequests).toEqual([{ name: "리네임 테스트" }]);
  // 도구·diff 상세는 기본적으로 꺼져 있어 채팅창에 아예 나타나지 않는다.
  await expect(page.getByText("변경사항 보기", { exact: true })).toHaveCount(0);
  await expect(page.getByText("도구 실행 내용 보기", { exact: true })).toHaveCount(0);
  expect(await page.locator(".messages").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  // 백업 목록에서 삭제 버튼으로 백업 사본만 지울 수 있어야 한다(원본 채팅과는 별개 — 확인 대화상자를 거침).
  await page.getByRole("button", { name: "백업 목록 보기 (1)" }).click();
  await expect(page.getByText("백업된 세션")).toBeVisible();
  fs.mkdirSync("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/ui-backup-delete.png" });
  page.once("dialog", (dialog) => void dialog.accept());
  await page.locator(".backup-item").getByRole("button", { name: "삭제", exact: true }).click();
  await expect(page.getByText("백업된 세션")).toHaveCount(0);
  expect(deleteBackupRequests).toEqual(["/api/session-backups/codex-backup-1"]);
  // 원본 파일이 삭제되는 등으로 첨부 이미지 로딩이 실패해도(404) 깨진 이미지 대신 고정 크기 안내
  // 박스로 바뀌어야 한다 — 크기 없는 img가 로딩 실패 순간 크기 변하며 채팅창이 들썩이던 문제 재현·검증.
  const brokenThumb = page.locator(".attachment-thumb-broken");
  await expect(brokenThumb).toBeVisible();
  await expect(page.locator(".attachment-thumb-link")).toHaveCount(0);
  const brokenHeight1 = await brokenThumb.evaluate((element) => element.getBoundingClientRect().height);
  await page.waitForTimeout(300);
  const brokenHeight2 = await brokenThumb.evaluate((element) => element.getBoundingClientRect().height);
  expect(brokenHeight2).toBe(brokenHeight1);
  fs.mkdirSync("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/ui-broken-attachment.png" });
  await page.getByLabel("도구·diff 상세 보기").check();
  const changeContent = page.locator(".message-details pre").filter({ hasText: "+new line" });
  await expect(changeContent).toBeHidden();
  const changeDetails = page.getByText("변경사항 보기", { exact: true });
  await expect(changeDetails).toBeVisible();
  await changeDetails.click();
  await expect(changeContent).toBeVisible();
  await changeDetails.click();
  await page.getByRole("button", { name: "원본 터미널 켜기" }).click();
  await expect(page.getByLabel("원본 터미널")).toBeVisible();
  await expect(page.locator(".conversation .messages")).toBeVisible();
  fs.mkdirSync("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/ui-chat-terminal.png", fullPage: true });
  await page.getByRole("button", { name: "원본 터미널 끄기" }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.locator(".workspace")).toBeVisible();
  await expect(page.locator(".chat-list")).toBeHidden();
  // placeholder를 길게 두고 min-height로 여러 줄 자리를 미리 잡아뒀더니 빈 입력창이 항상 크게 차지하고
  // (실기기 스크린샷으로 확인) 있었다 — 이제 안내문은 한 줄로 짧게 두고, 실제 입력 길이에 맞춰서만
  // 커지므로 빈 상태는 한 줄 높이 정도로 작아야 한다.
  const composerTextarea = page.locator(".composer textarea");
  const emptyHeight = await composerTextarea.evaluate((element) => element.clientHeight);
  expect(emptyHeight).toBeLessThan(60);
  // 여러 줄을 입력하면 그 내용에 맞춰(최대 높이까지) 실제로 늘어나야 한다.
  await composerTextarea.fill("첫째 줄\n둘째 줄\n셋째 줄\n넷째 줄\n다섯째 줄");
  const grownHeight = await composerTextarea.evaluate((element) => element.clientHeight);
  expect(grownHeight).toBeGreaterThan(emptyHeight);
  await composerTextarea.fill("");
  // 모델·사용량·모델 전환 컨트롤을 담은 상태바가 좁은 화면에서 컨트롤 개수 때문에 4줄까지 밀려
  // 채팅 내용이 나오기도 전에 화면 대부분을 차지했다(실기기 스크린샷으로 확인) — 모바일에서는 한 줄
  // 요약만 보이고, 눌러야 기존 전체 컨트롤이 펼쳐져야 한다.
  await expect(page.locator(".model-bar-summary")).toBeVisible();
  await expect(page.locator(".model-bar")).toBeHidden();
  const summaryHeight = await page.locator(".model-bar-summary").evaluate((element) => element.getBoundingClientRect().height);
  expect(summaryHeight).toBeLessThan(50);
  await page.locator(".model-bar-summary button").click();
  await expect(page.locator(".model-bar")).toBeVisible();
  await page.locator(".model-bar-summary button").click();
  await expect(page.locator(".model-bar")).toBeHidden();
  await page.getByRole("button", { name: "메뉴 열기" }).click();
  await expect(page.getByLabel("모바일 메뉴")).toBeVisible();
  await expect(page.locator(".mobile-menu-head strong")).toHaveText("web-agent-manager");
  await expect(page.locator(".mobile-project-select select")).toBeVisible();
  await expect(page.getByRole("button", { name: "새 Codex 채팅" })).toBeVisible();
  await expect(page.getByRole("button", { name: "새 Claude 채팅" })).toBeVisible();
  await page.screenshot({ path: "artifacts/ui-mobile-menu.png", fullPage: true });
  await page.getByRole("button", { name: "원본 터미널 켜기" }).click();
  await expect(page.locator(".mobile-chat-menu")).toHaveCount(0);
  await expect(page.getByLabel("원본 터미널")).toBeVisible();
  await expect(page.locator(".conversation")).toBeVisible();
  await page.screenshot({ path: "artifacts/ui-mobile-chat.png", fullPage: true });

  // 대시보드도 모바일 폭에서 가로 스크롤이 생기면 안 된다(에이전트 프로세스 표의 nowrap 헤더가
  // content-grid 트랙을 밀어올려 페이지 전체가 가로로 밀렸던 문제 재현·검증).
  await page.getByRole("button", { name: "대시보드", exact: true }).click();
  await expect(page.getByRole("heading", { name: "운영 대시보드" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/ui-mobile-dashboard.png", fullPage: true });
});

test("지연된 갱신이 사용자가 선택한 다른 채팅을 되돌리지 않는다", async ({ page }) => {
  let delayChatRefresh = false;
  const savedChats: number[] = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "ui-test", role: "admin" }, csrfToken: "ui-test" },
      "/api/providers": { providers: [{ id: "codex", label: "Codex", usageWindowId: "weekly", supportsPermissionMode: false }] },
      "/api/projects": { projects: [{ id: 1, name: "샘플 프로젝트", path: "/home/testuser/myagent" }] },
      "/api/usage": { usage: [] },
      "/api/system": { latest: null },
      "/api/runtime": { codex: "disabled", claude: "disabled" },
      "/api/slack": { enabled: false },
      "/api/ntfy": { enabled: false },
      "/api/approvals": { approvals: [] },
      "/api/projects/1/session-backups": { backups: [] },
      "/api/models/codex": { options: { provider: "codex", models: [], efforts: [] } },
    };
    if (pathname in responses) {
      await route.fulfill({ json: responses[pathname] });
      return;
    }
    if (pathname === "/api/chats") {
      if (delayChatRefresh) await new Promise((resolve) => setTimeout(resolve, 350));
      await route.fulfill({ json: { chats: [
        { id: 1, project_id: 1, provider: "codex", status: "running", title: "채팅 1" },
        { id: 2, project_id: 1, provider: "codex", status: "running", title: "채팅 2" },
      ] } });
      return;
    }
    if (pathname === "/api/chats/1/messages") {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.fulfill({ json: { messages: [{ id: "chat-1", role: "assistant", kind: "text", content: "첫 번째 채팅 응답" }], hasMore: false } });
      return;
    }
    if (pathname === "/api/chats/2/messages") {
      await route.fulfill({ json: { messages: [{ id: "chat-2", role: "assistant", kind: "text", content: "두 번째 채팅 응답" }], hasMore: false } });
      return;
    }
    if (pathname === "/api/auth/last-session" && route.request().method() === "POST") {
      const body = JSON.parse(route.request().postData() || "{}");
      savedChats.push(body.chatId);
      await route.fulfill({ json: { lastProjectId: body.projectId, lastChatId: body.chatId } });
      return;
    }
    await route.fulfill({ json: {} });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "채팅", exact: true }).click();
  await expect(page.locator(".title-text")).toHaveText("채팅 1");
  delayChatRefresh = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForTimeout(50);
  await page.locator(".chat-item").filter({ hasText: "채팅 2" }).click();
  await expect(page.locator(".title-text")).toHaveText("채팅 2");
  await expect(page.getByText("두 번째 채팅 응답", { exact: true })).toBeVisible();
  await page.waitForTimeout(700);
  await expect(page.locator(".title-text")).toHaveText("채팅 2");
  await expect(page.getByText("두 번째 채팅 응답", { exact: true })).toBeVisible();
  await expect(page.getByText("첫 번째 채팅 응답", { exact: true })).toHaveCount(0);
  expect(savedChats.at(-1)).toBe(2);
  await page.goBack();
  await expect(page.locator(".title-text")).toHaveText("채팅 1");
  await expect(page).toHaveURL(/tab=chat/);
  await page.goBack();
  await expect(page.getByRole("heading", { name: "운영 대시보드" })).toBeVisible();
  await expect(page).toHaveURL(/tab=overview/);
});

test("하단을 보고 있으면 새 답변을 따라가고 과거를 읽는 중이면 위치를 보존한다", async ({ page }) => {
  let responseVersion = 0;
  let messageRequests = 0;
  const baseMessages = Array.from({ length: 36 }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 ? "assistant" : "user",
    kind: "text",
    content: `${index}번째 메시지 ${"긴 내용 ".repeat(24)}`,
  }));
  await page.addInitScript(() => {
    const sockets: Array<{ onopen?: () => void; onmessage?: (event: { data: string }) => void }> = [];
    class FakeWebSocket {
      static OPEN = 1;
      readyState = 1;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      constructor() {
        sockets.push(this);
        setTimeout(() => this.onopen?.(), 0);
      }
      addEventListener(): void {}
      removeEventListener(): void {}
      send(): void {}
      close(): void { this.onclose?.(); }
    }
    Object.defineProperty(window, "WebSocket", { value: FakeWebSocket });
    (window as any).__emitWebAgentManagerSocket = (message: unknown) => {
      for (const socket of sockets) socket.onmessage?.({ data: JSON.stringify(message) });
    };
  });
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "ui-test", role: "admin" }, csrfToken: "ui-test" },
      "/api/providers": { providers: [{ id: "codex", label: "Codex", usageWindowId: "weekly", supportsPermissionMode: false }] },
      "/api/projects": { projects: [{ id: 1, name: "샘플 프로젝트", path: "/home/testuser/myagent" }] },
      "/api/usage": { usage: [] },
      "/api/system": { latest: null },
      "/api/runtime": { codex: "disabled", claude: "disabled" },
      "/api/slack": { enabled: false },
      "/api/ntfy": { enabled: false },
      "/api/approvals": { approvals: [] },
      "/api/projects/1/session-backups": { backups: [] },
      "/api/chats": { chats: [{ id: 1, project_id: 1, provider: "codex", status: "running", title: "스크롤 확인" }] },
    };
    if (pathname in responses) {
      await route.fulfill({ json: responses[pathname] });
      return;
    }
    if (pathname === "/api/chats/1/messages") {
      messageRequests += 1;
      const appended = [
        ...(responseVersion >= 1 ? [{ id: "new-answer-1", role: "assistant", kind: "text", content: "첫 번째 새 답변" }] : []),
        ...(responseVersion >= 2 ? [{ id: "new-answer-2", role: "assistant", kind: "text", content: "두 번째 새 답변" }] : []),
      ];
      await route.fulfill({ json: { messages: [...baseMessages, ...appended], hasMore: false } });
      return;
    }
    await route.fulfill({ json: {} });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "채팅", exact: true }).click();
  const messageList = page.locator(".messages");
  await expect(messageList).toBeVisible();
  await expect.poll(() => messageList.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(30);

  responseVersion = 1;
  await page.evaluate(() => (window as any).__emitWebAgentManagerSocket({ type: "history_updated", payload: { chatId: 1 } }));
  await expect(page.getByText("첫 번째 새 답변", { exact: true })).toBeVisible();
  await expect.poll(() => messageList.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(30);

  const readingPosition = await messageList.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
    element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2);
    element.dispatchEvent(new Event("scroll"));
    return element.scrollTop;
  });
  responseVersion = 2;
  const requestsBeforeSecondAnswer = messageRequests;
  await page.evaluate(() => (window as any).__emitWebAgentManagerSocket({ type: "history_updated", payload: { chatId: 1 } }));
  await expect.poll(() => messageRequests).toBeGreaterThan(requestsBeforeSecondAnswer);
  const preservedPosition = await messageList.evaluate((element) => element.scrollTop);
  expect(Math.abs(preservedPosition - readingPosition)).toBeLessThan(20);
});

test("작업 중인 Codex·Claude 채팅에도 후속 명령을 전송한다", async ({ page }) => {
  const sent: string[] = [];
  let messageVersion = 0;
  await page.addInitScript(() => {
    const sockets: Array<{ onopen?: () => void; onmessage?: (event: { data: string }) => void }> = [];
    class FakeWebSocket {
      static OPEN = 1;
      readyState = 1;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      constructor() {
        sockets.push(this);
        setTimeout(() => this.onopen?.(), 0);
      }
      addEventListener(): void {}
      removeEventListener(): void {}
      send(): void {}
      close(): void { this.onclose?.(); }
    }
    Object.defineProperty(window, "WebSocket", { value: FakeWebSocket });
    (window as any).__emitWebAgentManagerSocket = (message: unknown) => {
      for (const socket of sockets) socket.onmessage?.({ data: JSON.stringify(message) });
    };
  });
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "ui-test", role: "admin" }, csrfToken: "ui-test" },
      "/api/providers": { providers: [{ id: "codex", label: "Codex", usageWindowId: "weekly", supportsPermissionMode: false }, { id: "claude", label: "Claude", usageWindowId: "session", supportsPermissionMode: true }] },
      "/api/projects": { projects: [{ id: 1, name: "샘플 프로젝트", path: "/home/testuser/myagent" }] },
      "/api/usage": { usage: [] },
      "/api/system": { latest: null },
      "/api/runtime": { codex: "disabled", claude: "disabled" },
      "/api/slack": { enabled: false },
      "/api/ntfy": { enabled: false },
      "/api/approvals": { approvals: [] },
      "/api/projects/1/session-backups": { backups: [] },
      "/api/chats": { chats: [{ id: 1, project_id: 1, provider: "codex", status: "running", title: "작업 중 입력", busy: 1 }] },
    };
    if (pathname === "/api/chats/1/messages" && route.request().method() === "POST") {
      sent.push(JSON.parse(route.request().postData() || "{}").text);
      await route.fulfill({ status: 202, json: { accepted: true } });
      return;
    }
    if (pathname === "/api/chats/1/messages") {
      const messages = [
        { id: "assistant-running", role: "assistant", kind: "text", content: "현재 작업을 진행 중입니다.", createdAt: "2026-07-31T00:00:00.000Z" },
        ...(messageVersion >= 1 ? [{ id: "assistant-progress", role: "assistant", kind: "text", content: "중간 진행 내용", createdAt: "2026-07-31T00:00:01.000Z" }] : []),
        ...(messageVersion >= 2 ? [{ id: "queued-user", role: "user", kind: "text", content: "/review 현재 변경을 확인해", createdAt: "2026-07-31T00:00:02.000Z" }] : []),
      ];
      await route.fulfill({ json: { messages, hasMore: false } });
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
  await expect(page.getByText("작업중…", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "중지", exact: true })).toBeVisible();
  const composer = page.locator(".composer textarea");
  await composer.fill("/review 현재 변경을 확인해");
  await page.getByRole("button", { name: "전송", exact: true }).click();
  await expect.poll(() => sent).toEqual(["/review 현재 변경을 확인해"]);
  await expect(page.getByText("/review 현재 변경을 확인해", { exact: true })).toBeVisible();

  messageVersion = 1;
  await page.evaluate(() => (window as any).__emitWebAgentManagerSocket({ type: "history_updated", payload: { chatId: 1 } }));
  await expect(page.getByText("중간 진행 내용", { exact: true })).toBeVisible();
  await expect(page.getByText("/review 현재 변경을 확인해", { exact: true })).toBeVisible();

  messageVersion = 2;
  await page.evaluate(() => (window as any).__emitWebAgentManagerSocket({ type: "history_updated", payload: { chatId: 1 } }));
  await expect(page.getByText("/review 현재 변경을 확인해", { exact: true })).toHaveCount(1);
});

test("새 서브 에이전트를 만들고 대상 채팅을 중단·종료·열기 할 수 있다", async ({ page }) => {
  const delegationRequests: Record<string, unknown>[] = [];
  const interruptedChats: number[] = [];
  const stoppedChats: number[] = [];
  let childCreated = false;
  let approvalPending = false;
  let existingStatus = "running";
  let existingBusy = 1;
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "ui-test", role: "admin" }, csrfToken: "ui-test" },
      "/api/providers": { providers: [{ id: "codex", label: "Codex", usageWindowId: "weekly", supportsPermissionMode: false }, { id: "claude", label: "Claude", usageWindowId: "session", supportsPermissionMode: true }] },
      "/api/projects": { projects: [{ id: 1, name: "샘플 프로젝트", path: "/home/testuser/myagent" }] },
      "/api/usage": { usage: [] },
      "/api/system": { latest: null },
      "/api/runtime": { codex: "disabled", claude: "disabled" },
      "/api/slack": { enabled: false },
      "/api/ntfy": { enabled: false },
      "/api/projects/1/session-backups": { backups: [] },
      "/api/chats/1/messages": { messages: [{ id: "m1", role: "assistant", kind: "text", content: "부모 작업을 진행합니다." }], hasMore: false },
      "/api/chats/2/messages": { messages: [], hasMore: false },
      "/api/chats/3/messages": { messages: [], hasMore: false },
    };
    if (pathname in responses) {
      await route.fulfill({ json: responses[pathname] });
      return;
    }
    if (pathname === "/api/approvals") {
      await route.fulfill({ json: { approvals: approvalPending ? [{
        id: "approval-test",
        chat_id: 2,
        status: "pending",
        request_type: "permission",
        request_payload: JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm test" } }),
      }] : [] } });
      return;
    }
    if (pathname === "/api/chats") {
      await route.fulfill({ json: { chats: [
        { id: 1, project_id: 1, provider: "codex", status: "running", title: "부모 채팅", busy: 0 },
        { id: 2, project_id: 1, provider: "claude", status: existingStatus, title: "검증 에이전트", busy: existingBusy },
        ...(childCreated ? [{ id: 3, project_id: 1, provider: "claude", status: "running", title: "새 Claude 채팅", busy: 1 }] : []),
      ] } });
      return;
    }
    if (pathname === "/api/projects/1/agent-delegations") {
      await route.fulfill({ json: { delegations: [
        ...(childCreated ? [{
          id: "delegation-new", source_chat_id: 1, target_chat_id: 3, prompt: "테스트를 병렬로 수행하세요.",
          status: "sent", target_provider: "claude", target_title: "새 Claude 채팅", target_status: "running",
          target_busy: 1, updated_at: "2026-07-31 01:00:00",
        }] : []),
        {
          id: "delegation-existing", source_chat_id: 1, target_chat_id: 2, prompt: "기존 검증 작업",
          status: "sent", target_provider: "claude", target_title: "검증 에이전트", target_status: existingStatus,
          target_busy: existingBusy, updated_at: "2026-07-31 00:00:00",
        },
      ] } });
      return;
    }
    if (pathname === "/api/agent-delegations" && route.request().method() === "POST") {
      delegationRequests.push(JSON.parse(route.request().postData() || "{}"));
      childCreated = true;
      await route.fulfill({ status: 201, json: { delegation: { id: "delegation-new", target_chat_id: 3, status: "sent" } } });
      return;
    }
    if (pathname === "/api/chats/2/interrupt" && route.request().method() === "POST") {
      interruptedChats.push(2);
      existingBusy = 0;
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    if (pathname === "/api/chats/2/stop" && route.request().method() === "POST") {
      stoppedChats.push(2);
      existingStatus = "stopped";
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    await route.fulfill({ json: {} });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "채팅", exact: true }).click();
  await page.getByRole("button", { name: "서브 에이전트 관리" }).click();
  const manager = page.getByRole("dialog", { name: "서브 에이전트" });
  await expect(manager).toBeVisible();
  await expect(page.locator(".approval-list")).toHaveCount(0);
  await expect(manager).toContainText("검증 에이전트");
  await expect(manager).toContainText("1개 작업 중");
  await manager.getByRole("button", { name: "새 작업" }).click();
  await manager.getByRole("button", { name: "Claude", exact: true }).click();
  await manager.getByLabel("서브 에이전트 작업").fill("테스트를 병렬로 수행하세요.");
  await manager.getByRole("button", { name: "작업 시작" }).click();
  await expect(manager).toContainText("새 Claude 채팅");
  expect(delegationRequests).toHaveLength(1);
  expect(delegationRequests[0]).toMatchObject({ sourceChatId: 1, projectId: 1, provider: "claude", createNew: true });
  expect(typeof delegationRequests[0].idempotencyKey).toBe("string");

  await manager.getByRole("button", { name: "채팅 #2 응답 중단" }).click();
  expect(interruptedChats).toEqual([2]);
  await manager.getByRole("button", { name: "채팅 #2 터미널 종료" }).click();
  expect(stoppedChats).toEqual([2]);
  await expect(manager.getByRole("button", { name: "채팅 #2 터미널 시작" })).toBeVisible();
  await expect(manager.getByRole("button", { name: "채팅 #3 열기" })).toContainText("채팅 열기");
  fs.mkdirSync("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/ui-subagent-manager.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileBox = await manager.boundingBox();
  expect(mobileBox?.width).toBe(390);
  expect(mobileBox?.height).toBeLessThan(844);
  await page.screenshot({ path: "artifacts/ui-subagent-manager-mobile.png", fullPage: true });
  approvalPending = true;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await expect(page.locator(".approval-list")).toBeVisible();
  await expect(page.locator(".chat-layout")).toHaveClass(/has-approvals/);
  await page.getByRole("button", { name: "서브 에이전트 관리" }).click();
  await expect(manager).toBeVisible();
  await manager.getByRole("button", { name: "채팅 #3 열기" }).click();
  await expect(manager).toHaveCount(0);
  await expect(page.locator(".title-text")).toHaveText("새 Claude 채팅");
});

test("나중에 설치된 Codex를 감지해 스킬과 MCP 연동 버튼을 제공한다", async ({ page }) => {
  let linked = false;
  const installRequests: string[] = [];
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "ui-test", role: "admin" }, csrfToken: "ui-test" },
      "/api/providers": { providers: [] },
      "/api/projects": { projects: [] },
      "/api/usage": { usage: [] },
      "/api/system": { latest: null },
      "/api/runtime": { codex: "disabled", claude: "disabled" },
      "/api/slack": { enabled: false },
      "/api/ntfy": { enabled: false },
      "/api/approvals": { approvals: [] },
    };
    if (pathname in responses) {
      await route.fulfill({ json: responses[pathname] });
      return;
    }
    if (pathname === "/api/agent-integrations" && route.request().method() === "GET") {
      await route.fulfill({ json: { integrations: [
        { provider: "codex", cliInstalled: true, version: "codex 1.0.0", skillsInstalled: linked, mcpInstalled: linked, ready: linked },
        { provider: "claude", cliInstalled: false, version: null, skillsInstalled: false, mcpInstalled: false, ready: false },
      ] } });
      return;
    }
    if (pathname === "/api/agent-integrations/codex/install" && route.request().method() === "POST") {
      installRequests.push(pathname);
      linked = true;
      await route.fulfill({ json: { integration: { provider: "codex", ready: true }, skills: { installed: [], skipped: [], errors: [] } } });
      return;
    }
    await route.fulfill({ json: {} });
  });

  await page.goto("/");
  const notice = page.locator(".agent-integration-notice");
  await expect(notice).toContainText("에이전트 연동 필요");
  fs.mkdirSync("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/ui-agent-integration.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/ui-agent-integration-mobile.png", fullPage: true });
  await notice.getByRole("button", { name: "Codex 연결" }).click();
  await expect(notice).toHaveCount(0);
  expect(installRequests).toEqual(["/api/agent-integrations/codex/install"]);
});

test("도구와 GitHub는 응답 전 로딩을 표시하고 응답 후에만 빈 상태를 표시한다", async ({ page }) => {
  let releaseTools = (): void => undefined;
  let releaseGithub = (): void => undefined;
  const toolsGate = new Promise<void>((resolve) => { releaseTools = resolve; });
  const githubGate = new Promise<void>((resolve) => { releaseGithub = resolve; });
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
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
      "/api/projects/1/git": { status: "", log: "", commits: [], remotes: "" },
      "/api/projects/1/git/changes": { changes: [] },
      "/api/projects/1/git/diff": { diff: "" },
    };
    if (pathname === "/api/tools/catalog") {
      await toolsGate;
      await route.fulfill({ json: { items: [] } });
      return;
    }
    if (pathname === "/api/projects/1/github") {
      await githubGate;
      await route.fulfill({ status: 400, json: { error: "gh 인증이 필요합니다." } });
      return;
    }
    if (pathname in responses) {
      await route.fulfill({ json: responses[pathname] });
      return;
    }
    await route.fulfill({ json: {} });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "도구", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("도구 목록 불러오는 중");
  await expect(page.getByText("이 provider에서 표시할 항목이 없습니다.")).toHaveCount(0);
  fs.mkdirSync("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/ui-tools-loading.png", fullPage: true });
  releaseTools();
  await expect(page.getByText("이 provider에서 표시할 항목이 없습니다.")).toBeVisible();

  await page.getByRole("button", { name: "GitHub", exact: true }).click();
  await page.locator(".git-tabs").getByRole("button", { name: "현재 저장소", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("GitHub 정보 불러오는 중");
  await expect(page.getByText("gh 인증 또는 원격 저장소가 필요합니다.")).toHaveCount(0);
  await page.screenshot({ path: "artifacts/ui-github-loading.png", fullPage: true });
  releaseGithub();
  await expect(page.getByText("gh 인증 또는 원격 저장소가 필요합니다.")).toBeVisible();
});

test("GitHub 저장소 목록에서 연결 프로젝트를 열고 미연결 저장소를 생성한다", async ({ page }) => {
  const cloneRequests: Record<string, unknown>[] = [];
  let secondProjectCreated = false;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    const projects = [
      { id: 1, name: "연결 프로젝트", path: "/workspace/connected", active: 1 },
      ...(secondProjectCreated ? [{ id: 2, name: "new-repo", path: "/workspace/example-org/new-repo", active: 1 }] : []),
    ];
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "ui-test", role: "admin" }, csrfToken: "ui-test" },
      "/api/providers": { providers: [] },
      "/api/projects": { projects, defaultPath: "/workspace" },
      "/api/usage": { usage: [] },
      "/api/system": { latest: null },
      "/api/runtime": { codex: "disabled", claude: "disabled" },
      "/api/slack": { enabled: false },
      "/api/ntfy": { enabled: false },
      "/api/approvals": { approvals: [] },
      "/api/chats": { chats: [] },
      "/api/github/repositories": { owners: [{ login: "owner", type: "user" }, { login: "example-org", type: "organization" }], repositories: [
        { name: "connected", nameWithOwner: "owner/connected", description: "이미 연결된 저장소", isPrivate: true, projectId: 1, localPath: "/workspace/connected" },
        { name: "new-repo", nameWithOwner: "example-org/new-repo", description: "조직의 새 프로젝트", isPrivate: false, projectId: secondProjectCreated ? 2 : null, localPath: "/workspace/example-org/new-repo" },
      ] },
    };
    if (pathname === "/api/github/projects" && route.request().method() === "POST") {
      cloneRequests.push(JSON.parse(route.request().postData() || "{}"));
      secondProjectCreated = true;
      await route.fulfill({ status: 201, json: { project: { id: 2, name: "new-repo", path: "/workspace/example-org/new-repo", active: 1 }, reused: false } });
      return;
    }
    if (pathname in responses) {
      await route.fulfill({ json: responses[pathname] });
      return;
    }
    await route.fulfill({ json: {} });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "GitHub", exact: true }).click();
  const connected = page.locator(".repository-row").filter({ hasText: "owner/connected" });
  await expect(connected).toContainText("연결됨");
  await connected.getByRole("button", { name: "채팅 열기" }).click();
  await expect(page).toHaveURL(/tab=chat/);
  await expect(page).toHaveURL(/project=1/);
  await expect(page.getByRole("heading", { name: "채팅", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "GitHub", exact: true }).click();
  await page.getByLabel("GitHub 소유자 필터").selectOption("example-org");
  await expect(page.locator(".repository-row").filter({ hasText: "owner/connected" })).toHaveCount(0);
  const unconnected = page.locator(".repository-row").filter({ hasText: "example-org/new-repo" });
  await unconnected.getByRole("button", { name: "프로젝트 생성" }).click();
  const createDialog = page.getByRole("dialog", { name: "GitHub 프로젝트 생성" });
  await expect(createDialog).toBeVisible();
  await expect(createDialog.getByLabel("프로젝트 경로")).toHaveValue("/workspace/example-org/new-repo");
  expect(await createDialog.evaluate((element) => element.parentElement?.parentElement?.tagName)).toBe("BODY");
  fs.mkdirSync("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/ui-github-project-popup.png", fullPage: true });
  await createDialog.getByRole("button", { name: "프로젝트 생성", exact: true }).click();
  await expect(page).toHaveURL(/tab=chat/);
  await expect(page).toHaveURL(/project=2/);
  expect(cloneRequests).toEqual([{ repository: "example-org/new-repo", destination: "/workspace/example-org/new-repo" }]);
  await page.getByRole("button", { name: "GitHub", exact: true }).click();
  await page.screenshot({ path: "artifacts/ui-github-repositories.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/ui-github-repositories-mobile.png", fullPage: true });
});

test("CLI 인증은 페이지 레이아웃 밖의 독립 팝업으로 열린다", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "ui-test", role: "admin" }, csrfToken: "ui-test" },
      "/api/providers": { providers: [] },
      "/api/projects": { projects: [], defaultPath: "/workspace" },
      "/api/usage": { usage: [] },
      "/api/system": { latest: null },
      "/api/runtime": { codex: "disabled", claude: "disabled" },
      "/api/slack": { enabled: false },
      "/api/ntfy": { enabled: false },
      "/api/approvals": { approvals: [] },
      "/api/cli-auth": { providers: [
        { provider: "codex", installed: true, authenticated: false, running: false, exitCode: null },
        { provider: "claude", installed: true, authenticated: true, running: false, exitCode: 0 },
        { provider: "github", installed: true, authenticated: true, running: false, exitCode: 0 },
      ] },
    };
    if (pathname in responses) {
      await route.fulfill({ json: responses[pathname] });
      return;
    }
    await route.fulfill({ json: {} });
  });

  await page.goto("/");
  const dialog = page.getByRole("dialog", { name: "CLI 인증 관리" });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((element) => element.parentElement?.parentElement?.tagName)).toBe("BODY");
  await expect(dialog).toContainText("Codex");
  fs.mkdirSync("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/ui-cli-auth-popup.png", fullPage: true });
  await dialog.getByRole("button", { name: "닫기" }).click();
  await expect(dialog).toHaveCount(0);
});

test("로컬 프로젝트 생성에서 GitHub 저장소 생성 옵션을 함께 전송한다", async ({ page }) => {
  const projectRequests: Record<string, unknown>[] = [];
  let created = false;
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const projects = [
      { id: 1, name: "기존 프로젝트", path: "/workspace/existing", active: 1 },
      ...(created ? [{ id: 2, name: "로컬 앱", path: "/workspace/local-app", active: 1 }] : []),
    ];
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "ui-test", role: "admin" }, csrfToken: "ui-test" },
      "/api/providers": { providers: [] },
      "/api/projects": { projects, defaultPath: "/workspace" },
      "/api/usage": { usage: [] },
      "/api/system": { latest: null },
      "/api/runtime": { codex: "disabled", claude: "disabled" },
      "/api/slack": { enabled: false },
      "/api/ntfy": { enabled: false },
      "/api/approvals": { approvals: [] },
      "/api/chats": { chats: [] },
    };
    if (pathname === "/api/projects" && route.request().method() === "POST") {
      projectRequests.push(JSON.parse(route.request().postData() || "{}"));
      created = true;
      await route.fulfill({ status: 201, json: { project: { id: 2, name: "로컬 앱", path: "/workspace/local-app", active: 1 }, repository: { nameWithOwner: "owner/local-app" } } });
      return;
    }
    if (pathname in responses) {
      await route.fulfill({ json: responses[pathname] });
      return;
    }
    await route.fulfill({ json: {} });
  });

  await page.goto("/");
  await page.locator(".project-bar").getByRole("button", { name: "프로젝트", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "프로젝트 생성" });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((element) => element.parentElement?.parentElement?.tagName)).toBe("BODY");
  await dialog.getByLabel("서버의 프로젝트 절대 경로").fill("/workspace/local-app");
  await dialog.getByLabel("표시 이름").fill("로컬 앱");
  await dialog.getByLabel("GitHub 저장소 생성 및 origin 연결").check();
  await dialog.getByLabel("저장소 이름").fill("owner/local-app");
  await dialog.getByLabel("공개 범위").selectOption("private");
  await dialog.getByLabel("설명").fill("로컬에서 시작한 앱");
  fs.mkdirSync("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/ui-project-create.png", fullPage: true });
  await dialog.getByRole("button", { name: "프로젝트 생성", exact: true }).click();

  expect(projectRequests).toEqual([{
    path: "/workspace/local-app",
    name: "로컬 앱",
    createGithub: true,
    repository: "owner/local-app",
    visibility: "private",
    description: "로컬에서 시작한 앱",
  }]);
  await expect(page).toHaveURL(/tab=chat/);
  await expect(page).toHaveURL(/project=2/);
});

test("채팅의 프로젝트 파일 링크는 파일 탭 미리보기로 이동하고 폴더는 한 번 클릭으로 열린다", async ({ page }) => {
  const fileRequests: string[] = [];
  const rootEntries = [
    { name: "docs", directory: true, size: 0, modifiedAt: "2026-07-31T00:00:00.000Z" },
    { name: "README.md", directory: false, size: 30, modifiedAt: "2026-07-31T00:00:00.000Z" },
    { name: "archive.zip", directory: false, size: 1024, modifiedAt: "2026-07-31T00:00:00.000Z" },
    ...["approval-service.test.ts", "attachments.test.ts", "auth-routes.test.ts", "chat-attachments.test.ts", "claude-history.test.ts", "codex-history.test.ts", "file-routes.test.ts", "history-sync-title.test.ts", "rate-limit-resume-tick.test.ts"].map((name, index) => ({
      name, directory: false, size: 1400 + index * 731, modifiedAt: "2026-07-30T12:34:00.000Z",
    })),
  ];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "ui-test", role: "admin" }, csrfToken: "ui-test" },
      "/api/providers": { providers: [{ id: "codex", label: "Codex", usageWindowId: "weekly", supportsPermissionMode: false }] },
      "/api/projects": { projects: [{ id: 1, name: "샘플 프로젝트", path: "/home/testuser/myagent" }] },
      "/api/usage": { usage: [] },
      "/api/system": { latest: null },
      "/api/runtime": { codex: "disabled", claude: "disabled" },
      "/api/slack": { enabled: false },
      "/api/ntfy": { enabled: false },
      "/api/approvals": { approvals: [] },
      "/api/chats": { chats: [{ id: 1, project_id: 1, provider: "codex", status: "running", title: "파일 링크 확인" }] },
      "/api/projects/1/session-backups": { backups: [] },
      "/api/chats/1/messages": { messages: [{ id: "a1", role: "assistant", kind: "text", content: "현재 구현은 [README.md](/home/testuser/myagent/README.md:12)를 참고하세요." }], hasMore: false },
    };
    if (pathname in responses) {
      await route.fulfill({ json: responses[pathname] });
      return;
    }
    if (pathname === "/api/projects/1/files") {
      const directory = url.searchParams.get("path") || "";
      fileRequests.push(directory);
      await route.fulfill({ json: directory === "docs"
        ? { path: "docs", entries: [{ name: "guide.md", directory: false, size: 20, modifiedAt: "2026-07-31T00:00:00.000Z" }] }
        : { path: "", entries: rootEntries } });
      return;
    }
    if (pathname === "/api/projects/1/files/preview") {
      await route.fulfill({ json: url.searchParams.get("path") === "archive.zip"
        ? { previewable: true, kind: "archive", size: 1024 }
        : { previewable: true, kind: "markdown", content: "# 프로젝트 안내\n\n파일 링크로 연 미리보기입니다.", size: 30, truncated: false } });
      return;
    }
    await route.fulfill({ json: {} });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "채팅", exact: true }).click();
  await page.getByRole("link", { name: "README.md" }).click();
  await expect(page.getByRole("button", { name: "파일", exact: true }).first()).toHaveClass(/active/);
  await expect(page.locator(".file-list-head")).toBeVisible();
  await expect(page.locator(".file-row")).toHaveCount(rootEntries.length);
  await expect(page.locator(".file-preview strong")).toHaveText("README.md");
  await expect(page.locator(".file-preview-markdown h1")).toHaveText("프로젝트 안내");
  fs.mkdirSync("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/ui-file-markdown-preview.png", fullPage: true });
  await page.getByRole("button", { name: "파일 미리보기: archive.zip" }).click();
  await expect(page.locator(".file-preview")).toContainText("압축파일입니다.");
  await page.getByRole("button", { name: "폴더 열기: docs" }).click();
  await expect(page.getByRole("button", { name: "/ docs" })).toBeVisible();
  await expect(page.getByText("guide.md", { exact: true })).toBeVisible();
  expect(fileRequests).toContain("");
  expect(fileRequests).toContain("docs");
  await page.getByRole("button", { name: "root", exact: true }).click();
  await expect(page.locator(".file-preview")).toHaveCount(0);
  await expect(page.locator(".file-row")).toHaveCount(rootEntries.length);
  await page.goBack();
  await expect(page.getByRole("button", { name: "/ docs" })).toBeVisible();
  await expect(page.getByText("guide.md", { exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.locator(".file-preview")).toContainText("압축파일입니다.");
  await page.goForward();
  await expect(page.getByRole("button", { name: "/ docs" })).toBeVisible();
  await page.goForward();
  await expect(page.locator(".file-preview")).toHaveCount(0);
  await expect(page.locator(".file-row")).toHaveCount(rootEntries.length);
  await page.screenshot({ path: "artifacts/ui-file-preview.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "파일 미리보기: README.md" }).click();
  const mobilePreview = page.locator(".file-preview");
  await expect(mobilePreview).toBeVisible();
  const previewBox = await mobilePreview.boundingBox();
  expect(previewBox?.y).toBeLessThanOrEqual(1);
  expect(previewBox?.height).toBeGreaterThan(700);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/ui-file-preview-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "미리보기 닫기" }).click();
});

test("PR diff는 상세 진입 시 자동으로 불러오고 파일별로 나눠 보여준다", async ({ page }) => {
  const diffRequests: string[] = [];
  const prDiff = [
    "diff --git a/a.ts b/a.ts",
    "index 111..222 100644",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1 +1 @@",
    "-old a ".concat("very-long-content-".repeat(30)),
    "+new a ".concat("very-long-content-".repeat(30)),
    "diff --git a/b.ts b/b.ts",
    "index 333..444 100644",
    "--- a/b.ts",
    "+++ b/b.ts",
    "@@ -1 +1 @@",
    "-old b",
    "+new b",
  ].join("\n");
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "ui-test", role: "admin" }, csrfToken: "ui-test" },
      "/api/providers": { providers: [] },
      "/api/projects": { projects: [{ id: 1, name: "샘플 프로젝트", path: "/home/testuser/myagent" }] },
      "/api/usage": { usage: [] },
      "/api/system": { latest: null },
      "/api/runtime": { codex: "disabled", claude: "disabled" },
      "/api/slack": { enabled: false },
      "/api/approvals": { approvals: [] },
      "/api/chats": { chats: [] },
      "/api/projects/1/git": { status: "", log: "", commits: [], remotes: "" },
      "/api/projects/1/git/changes": { changes: [] },
      "/api/projects/1/github": { repository: { url: "https://github.com/x/y", nameWithOwner: "x/y" }, issues: [], pullRequests: [{ number: 1, title: "테스트 PR", state: "OPEN", headRefName: "feat", baseRefName: "main", updatedAt: "2026-07-11T00:00:00.000Z" }], runs: [] },
      "/api/projects/1/github/pr/1": { pullRequest: { number: 1, title: "테스트 PR", state: "OPEN", headRefName: "feat", baseRefName: "main", body: "설명" } },
    };
    if (pathname in responses) {
      await route.fulfill({ json: responses[pathname] });
      return;
    }
    if (pathname === "/api/projects/1/github/pr/1/diff") {
      diffRequests.push(pathname);
      await route.fulfill({ json: { diff: prDiff } });
      return;
    }
    await route.fulfill({ json: {} });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "운영 대시보드" })).toBeVisible();
  await page.getByRole("button", { name: "GitHub", exact: true }).click();
  await page.locator(".git-tabs").getByRole("button", { name: "현재 저장소", exact: true }).click();
  await expect(page.getByText("이슈 기록 없음", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "PR", exact: true }).click();
  await page.getByText("#1 테스트 PR").click();
  await expect(page.getByRole("heading", { name: "#1 테스트 PR" })).toBeVisible();
  // PR 상세를 열면 별도 버튼 없이 diff를 한 번 자동으로 읽는다.
  await expect(page.locator(".file-diff")).toHaveCount(2);
  expect(diffRequests).toHaveLength(1);
  // 두 파일이 섞인 diff가 로컬 Diff 탭·커밋 상세와 같은 방식으로 파일별 접이식 섹션으로 나뉘어야 한다.
  await expect(page.locator(".file-diff")).toHaveCount(2);
  await expect(page.locator(".file-diff summary").nth(0)).toHaveText("a.ts");
  await expect(page.locator(".file-diff summary").nth(1)).toHaveText("b.ts");
  await expect(page.getByText("2개 파일", { exact: true })).toBeVisible();
  // 대형 PR의 모든 줄을 동시에 만들지 않고, 펼친 파일의 diff만 지연 렌더링한다.
  await expect(page.locator(".github-pr-diff .diff-view")).toHaveCount(0);
  await page.locator(".file-diff summary").first().click();
  await expect(page.locator(".github-pr-diff .diff-view")).toHaveCount(1);
  await page.locator(".github-pr-diff").getByRole("button", { name: "분할", exact: true }).click();
  await expect(page.locator(".github-pr-diff .diff-split")).toHaveCount(1);
  await expect(page.locator(".github-pr-diff .diff-split-number.remove").first()).toHaveText("1");
  await expect(page.locator(".github-pr-diff .diff-split-number.add").first()).toHaveText("1");
  expect(await page.locator(".github-pr-diff .diff-split-code").evaluateAll((cells) => cells.every((cell) => cell.scrollWidth <= cell.clientWidth + 1))).toBe(true);
  expect(await page.locator(".github-pr-diff .diff-split-text").evaluateAll((texts) => texts.every((text) => {
    const cell = text.parentElement;
    if (!cell) return false;
    const boundary = cell.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(text);
    return [...range.getClientRects()].every((rect) => rect.left >= boundary.left - 1 && rect.right <= boundary.right + 1);
  }))).toBe(true);
  fs.mkdirSync("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/ui-pr-diff-split.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await page.locator(".github-pr-diff .diff-split").first().evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/ui-pr-diff-split-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator(".github-pr-diff").getByRole("button", { name: "통합", exact: true }).click();
  await expect(page.locator(".github-pr-diff .diff-view")).toHaveCount(1);
  await page.locator(".file-diff summary").first().click();
  await expect(page.locator(".github-pr-diff .diff-view")).toHaveCount(0);
  await page.screenshot({ path: "artifacts/ui-pr-diff.png", fullPage: true });
});

test("PR 병합 실패 시 버튼이 '처리 중…'을 거쳐 오류 메시지를 보여주고 다시 눌러진다", async ({ page }) => {
  // 실사용 재현: gh pr merge가 충돌로 실패해도 예전엔 콘솔에만 조용히 남고 화면엔 아무 표시가 없었다.
  const mergeErrorMessage = "Command failed: gh pr merge 1 --squash --delete-branch\nX Pull request #1 is not mergeable: the merge commit cannot be cleanly created.";
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "ui-test", role: "admin" }, csrfToken: "ui-test" },
      "/api/providers": { providers: [] },
      "/api/projects": { projects: [{ id: 1, name: "샘플 프로젝트", path: "/home/testuser/myagent" }] },
      "/api/usage": { usage: [] },
      "/api/system": { latest: null },
      "/api/runtime": { codex: "disabled", claude: "disabled" },
      "/api/slack": { enabled: false },
      "/api/approvals": { approvals: [] },
      "/api/chats": { chats: [] },
      "/api/projects/1/git": { status: "", log: "", commits: [], remotes: "" },
      "/api/projects/1/git/changes": { changes: [] },
      "/api/projects/1/github": { repository: { url: "https://github.com/x/y", nameWithOwner: "x/y" }, issues: [], pullRequests: [{ number: 1, title: "테스트 PR", state: "OPEN", headRefName: "feat", baseRefName: "main", updatedAt: "2026-07-11T00:00:00.000Z" }], runs: [] },
      "/api/projects/1/github/pr/1": { pullRequest: { number: 1, title: "테스트 PR", state: "OPEN", headRefName: "feat", baseRefName: "main", body: "설명" } },
    };
    if (pathname in responses) {
      await route.fulfill({ json: responses[pathname] });
      return;
    }
    if (pathname === "/api/projects/1/github/pr/1/merge" && route.request().method() === "POST") {
      // 실제 요청은 즉시 안 끝나므로, 그 사이 "처리 중…" 상태를 관찰할 수 있게 살짝 지연시킨다.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await route.fulfill({ status: 400, json: { error: mergeErrorMessage } });
      return;
    }
    await route.fulfill({ json: {} });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "운영 대시보드" })).toBeVisible();
  await page.getByRole("button", { name: "GitHub", exact: true }).click();
  await page.locator(".git-tabs").getByRole("button", { name: "현재 저장소", exact: true }).click();
  await page.getByRole("button", { name: "PR", exact: true }).click();
  await page.getByText("#1 테스트 PR").click();
  await expect(page.getByRole("heading", { name: "#1 테스트 PR" })).toBeVisible();

  page.once("dialog", (dialog) => void dialog.accept());
  const mergeButton = page.getByRole("button", { name: "PR 병합" });
  await mergeButton.click();
  await expect(page.getByRole("button", { name: "처리 중…" })).toBeVisible();
  await expect(page.getByRole("button", { name: "처리 중…" })).toBeDisabled();
  // 실패해도 화면에 원인이 그대로 보여야 하고(예전엔 콘솔에만 조용히 남았음), 버튼도 다시 눌러져야 한다.
  await expect(page.getByText(mergeErrorMessage, { exact: false })).toBeVisible();
  await expect(mergeButton).toBeVisible();
  await expect(mergeButton).toBeEnabled();
  fs.mkdirSync("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/ui-pr-merge-error.png" });
});

test("대시보드에서 사용량 카드마다 터미널 스냅샷을 볼 수 있다", async ({ page }) => {
  // 숫자만으로는 파싱이 왜 이상한지 알기 어려워, 파서에 실제로 넘어간 원본 화면 텍스트를 그대로
  // 볼 수 있어야 한다(실사용 요청으로 추가).
  const snapshotRequests: string[] = [];
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "ui-test", role: "admin" }, csrfToken: "ui-test" },
      "/api/providers": { providers: [{ id: "codex", label: "Codex", usageWindowId: "weekly", supportsPermissionMode: false }, { id: "claude", label: "Claude", usageWindowId: "session", supportsPermissionMode: true }] },
      "/api/projects": { projects: [{ id: 1, name: "샘플 프로젝트", path: "/home/testuser/myagent" }] },
      "/api/system": { latest: null },
      "/api/runtime": { codex: "disabled", claude: "disabled" },
      "/api/slack": { enabled: false },
      "/api/approvals": { approvals: [] },
      "/api/chats": { chats: [] },
      "/api/usage": { usage: [{ provider: "claude", monitor_status: "ready", data_status: "fresh", used_percent: 29, remaining_percent: 71, reset_at: "Jul 18", details_json: JSON.stringify({ windows: [{ id: "weekly_all", label: "Current week (all models)", usedPercent: 29, remainingPercent: 71, resetAt: "Jul 18" }] }) }] },
      "/api/usage/claude/snapshot": { snapshot: { text: "Current week (all models): 29% used\n(세션 창 없음 — 실제 CLI 화면)", capturedAt: "2026-07-12T03:00:29.697Z" } },
    };
    if (pathname in responses) {
      if (pathname === "/api/usage/claude/snapshot") snapshotRequests.push(pathname);
      await route.fulfill({ json: responses[pathname] });
      return;
    }
    await route.fulfill({ json: {} });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "운영 대시보드" })).toBeVisible();
  await expect(page.getByText("터미널 스냅샷")).toHaveCount(0);
  await page.getByRole("button", { name: "터미널 보기" }).click();
  expect(snapshotRequests).toHaveLength(1);
  await expect(page.getByText("터미널 스냅샷")).toBeVisible();
  await expect(page.getByText("세션 창 없음", { exact: false })).toBeVisible();
  fs.mkdirSync("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/ui-usage-snapshot.png" });
  await page.getByRole("button", { name: "닫기" }).click();
  await expect(page.getByText("터미널 스냅샷")).toHaveCount(0);
});
