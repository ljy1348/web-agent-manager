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

test("채팅·터미널 모드 전환과 모바일 채팅 메뉴를 렌더링한다", async ({ page }) => {
  const terminalInputs: string[] = [];
  const terminalScrolls: number[] = [];
  const terminalRowRequests: number[] = [];
  const projectImageRequests: string[] = [];
  const pastedTextUploadBodies: string[] = [];
  let pushTerminalOutput: (data: string) => void = () => undefined;
  await page.routeWebSocket("**/ws", (webSocket) => {
    pushTerminalOutput = (data) => webSocket.send(JSON.stringify({ type: "terminal_output", payload: { chatId: 1, data } }));
    // 실제 서버처럼 구독·리사이즈 뒤 현재 tmux 화면을 다시 보내는 목 스냅샷이다.
    const sendTerminalSnapshot = (chatId: number): void => {
      const scrollback = Array.from({ length: 72 }, (_item, index) => `터미널 기록 ${String(index + 1).padStart(2, "0")}\r\n`).join("");
      webSocket.send(JSON.stringify({ type: "terminal_output", payload: { chatId, data: `\u001b[2J\u001b[H${scrollback}원본 터미널 출력` } }));
    };
    webSocket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "terminal_scroll") terminalScrolls.push(message.lines);
      if ((message.type === "terminal_resize" || message.type === "subscribe_terminal") && Number.isInteger(message.rows)) terminalRowRequests.push(message.rows);
      if (message.type === "subscribe_terminal" || message.type === "terminal_resize") sendTerminalSnapshot(message.chatId);
      if (message.type === "terminal_input") terminalInputs.push(message.data);
    });
  });
  const renameRequests: Record<string, unknown>[] = [];
  const deleteBackupRequests: string[] = [];
  const chatViewModeRequests: string[] = [];
  let backupDeleted = false;
  let chatViewMode = "chat";
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/auth/chat-view-mode" && route.request().method() === "PUT") {
      chatViewMode = JSON.parse(route.request().postData() || "{}").chatViewMode;
      chatViewModeRequests.push(chatViewMode);
      await route.fulfill({ json: { chatViewMode } });
      return;
    }
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "ui-test", role: "admin", chat_view_mode: chatViewMode }, csrfToken: "ui-test" },
      "/api/providers": { providers: [{ id: "codex", label: "Codex", usageWindowId: "weekly", supportsPermissionMode: false }, { id: "claude", label: "Claude", usageWindowId: "session", supportsPermissionMode: true }] },
      "/api/projects": { projects: [{ id: 1, name: "샘플 프로젝트", path: "/home/testuser/myagent" }] },
      // 접힌 상태에서도 사용량·초기화 시각이 남는지 보려면 실제 사용량 구간이 있어야 한다.
      "/api/usage": { usage: [{ provider: "codex", monitor_status: "ready", data_status: "fresh", used_percent: 12, remaining_percent: 88, reset_at: "1:40pm (Asia/Seoul)", details_json: JSON.stringify({ windows: [{ id: "weekly", label: "Current week", usedPercent: 12, remainingPercent: 88, resetAt: "1:40pm (Asia/Seoul)" }] }) }] },
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
      await route.fulfill({ json: { messages: [{ id: "u1", role: "user", kind: "text", content: "모바일에서도 채팅에 집중하고 싶어." }, { id: "a1", role: "assistant", kind: "text", content: "프로젝트와 새 채팅은 햄버거 메뉴에서 관리할 수 있습니다. very_long_unbroken_response_text_that_must_wrap_without_horizontal_scrolling\n```diff\n-old line\n+new line\n```" }, { id: "t1", role: "tool", kind: "function_call_output", content: "diff --git a/file b/file\n도구 실행 결과" }, { id: "a2", role: "assistant", kind: "text", content: "화면 확인: [첨부: artifacts/missing.png]" }, { id: "a3", role: "assistant", kind: "text", content: "상대 경로: [첨부: artifacts/relative.png]\n절대 경로: [첨부: /home/testuser/myagent/artifacts/absolute.png]" }] } });
      return;
    }
    if (pathname === "/api/chats/1/attachments" && route.request().method() === "POST") {
      pastedTextUploadBodies.push(route.request().postDataBuffer()?.toString("utf8") ?? "");
      await route.fulfill({ status: 201, json: { uploads: [{ name: "pasted-text.txt", path: ".web-agent-manager-uploads/1/pasted-text.txt", size: 5000 }] } });
      return;
    }
    if (pathname.startsWith("/api/projects/1/files/content/artifacts/")) {
      projectImageRequests.push(route.request().url());
      if (pathname.endsWith("/missing.png")) {
        await route.fulfill({ status: 404, json: { error: "ENOENT: no such file or directory" } });
        return;
      }
      await route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64") });
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
  await expect(page.getByRole("button", { name: "채팅 모드" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".terminal-panel-full")).toHaveCount(0);
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
  await expect(page.locator(".attachment-thumb-link img")).toHaveCount(2);
  await expect.poll(() => page.locator(".attachment-thumb-link img").evaluateAll((images) => images.every((image) => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  expect(projectImageRequests.some((url) => url.includes("/files/content/artifacts/relative.png?chatId=1"))).toBe(true);
  expect(projectImageRequests.some((url) => url.includes("/files/content/artifacts/absolute.png?chatId=1"))).toBe(true);
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
  // 1,000자를 넘는 텍스트 붙여넣기는 textarea에 직접 넣지 않고 기존 채팅 첨부 API로 파일화한다.
  const longPaste = "긴붙여넣기".repeat(201);
  await page.getByPlaceholder("질문을 입력하세요").evaluate((element, pastedText) => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", pastedText);
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, longPaste);
  await expect.poll(() => pastedTextUploadBodies.length).toBe(1);
  expect(pastedTextUploadBodies[0]).toContain(longPaste.slice(0, 30));
  expect(pastedTextUploadBodies[0]).toContain("pasted-text-");
  await expect(page.getByPlaceholder("질문을 입력하세요")).toHaveValue("[첨부: .web-agent-manager-uploads/1/pasted-text.txt]");
  await page.getByRole("button", { name: "터미널 모드" }).click();
  await expect(page.getByLabel("채팅 터미널")).toBeVisible();
  await expect(page.locator(".terminal-host .xterm-rows")).toContainText("원본 터미널 출력");
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await page.keyboard.type("pwd");
  await expect.poll(() => terminalInputs.join("")).toContain("pwd");
  await expect(page.locator(".conversation")).toHaveCount(0);
  await expect(page.locator(".terminal-panel-full")).toHaveCSS("flex-grow", "1");
  expect(chatViewModeRequests).toEqual(["terminal"]);
  // 글자 크기와 줄 간격은 유지하고, 실제 논리 행 수를 tmux와 함께 늘려 패널 세로 공간을 채운다.
  await expect.poll(() => terminalRowRequests.at(-1) ?? 0).toBeGreaterThan(36);
  const rowFit = await page.locator(".terminal-host").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      available: element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
      rendered: element.querySelector(".xterm-rows")!.getBoundingClientRect().height,
      visible: element.querySelectorAll(".xterm-rows > div").length,
      overflow: element.scrollHeight - element.clientHeight,
      lineHeight: element.querySelector(".xterm-rows")!.getBoundingClientRect().height / element.querySelectorAll(".xterm-rows > div").length,
    };
  });
  expect(rowFit.visible).toBe(terminalRowRequests.at(-1));
  expect(rowFit.rendered).toBeLessThanOrEqual(rowFit.available + 2);
  expect(rowFit.available - rowFit.rendered).toBeLessThan(20);
  expect(rowFit.lineHeight).toBeLessThan(20);
  expect(rowFit.overflow).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight)).toBe(0);
  // 실제 사용자 첨부 화면과 같은 큰 뷰포트에서는 행 수가 더 늘고 같은 정상 줄 간격으로 하단까지 찬다.
  const rowsBeforeLargeViewport = terminalRowRequests.at(-1)!;
  await page.setViewportSize({ width: 2048, height: 1114 });
  await expect.poll(() => terminalRowRequests.at(-1) ?? 0).toBeGreaterThan(rowsBeforeLargeViewport);
  await expect.poll(() => page.locator(".terminal-host").evaluate((element) => {
    const style = getComputedStyle(element);
    const available = element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    const rendered = element.querySelector(".xterm-rows")!.getBoundingClientRect().height;
    return available - rendered;
  })).toBeLessThan(40);
  fs.mkdirSync("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/ui-chat-terminal.png", fullPage: true });
  // 실제 tmux attach 화면은 대체 버퍼라 xterm 자체 스크롤백이 없다. 이때 휠은 페이지나 상자를
  // 움직이는 대신 tmux 기록(copy-mode) 이동 요청이 되어야 한다 — 실제 CLI에서 위로 스크롤한 것과 같다.
  pushTerminalOutput("\u001b[?1049h\u001b[2J\u001b[H대체 화면 출력");
  await page.waitForTimeout(50);
  terminalScrolls.length = 0;
  await page.locator(".terminal-host").hover();
  await page.mouse.wheel(0, -300);
  await expect.poll(() => terminalScrolls.reduce((sum, lines) => sum + lines, 0)).toBeGreaterThan(0);
  await page.mouse.wheel(0, 300);
  await expect.poll(() => terminalScrolls.some((lines) => lines < 0)).toBe(true);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(await page.locator(".terminal-host").evaluate((element) => element.scrollTop)).toBe(0);
  pushTerminalOutput("\u001b[?1049l");
  await page.reload();
  await expect(page.getByLabel("채팅 터미널")).toBeVisible();
  await page.getByRole("button", { name: "채팅 모드" }).click();
  await expect(page.locator(".conversation")).toBeVisible();
  expect(chatViewModeRequests).toEqual(["terminal", "chat"]);

  // 노트북(세로 ≤900px)에서는 뷰포트가 100px 더 짧아지는데도 헤더·여백·model-bar를 압축하므로
  // 대화 영역은 오히려 넓어져야 한다. 문서 스크롤이 생기지 않는 것도 함께 본다.
  const messagesHeight = async (): Promise<number> => page.locator(".conversation .messages").evaluate((element) => element.clientHeight);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const desktopMessages = await messagesHeight();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator(".model-bar-summary")).toBeVisible();
  await expect(page.locator(".model-bar")).toBeHidden();
  // 접어도 사용량과 초기화 시각은 남아야 한다(펼쳐야만 보이면 평소 확인하던 값이 사라진다).
  await expect(page.locator(".model-bar-summary")).toContainText("사용량 12% · 초기화 1:40pm (Asia/Seoul)");
  expect(await messagesHeight()).toBeGreaterThan(desktopMessages);
  expect(await page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight)).toBe(0);
  await page.screenshot({ path: "artifacts/ui-chat-laptop.png", fullPage: true });
  // 접어둔 model-bar는 요약 줄의 '자세히'로 그대로 펼쳐 모델·권한 설정을 쓸 수 있어야 한다.
  await page.getByRole("button", { name: "자세히 ▾" }).click();
  await expect(page.locator(".model-bar")).toBeVisible();
  await expect(page.getByLabel("도구·diff 상세 보기")).toBeVisible();
  await page.getByRole("button", { name: "접기 ▴" }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });

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
  // 390px에서는 초기화 시각까지 넣으면 한 줄을 넘겨 모델명이 과하게 잘리므로 퍼센트만 남긴다.
  await expect(page.locator(".model-bar-summary")).toContainText("사용량 12%");
  await expect(page.locator(".model-bar-summary .summary-reset")).toBeHidden();
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
  await page.locator(".mobile-menu-head").getByRole("button", { name: "메뉴 닫기" }).click();
  await page.getByRole("button", { name: "터미널 모드" }).click();
  await expect(page.locator(".mobile-chat-menu")).toHaveCount(0);
  await expect(page.getByLabel("채팅 터미널")).toBeVisible();
  await expect(page.locator(".conversation")).toHaveCount(0);
  const terminalStage = page.locator(".terminal-stage");
  const terminalHost = page.locator(".terminal-host");
  const visibleTerminalRows = page.locator(".terminal-host .xterm-rows");
  await expect(page.getByRole("toolbar", { name: "모바일 터미널 키" })).toBeVisible();
  expect((await terminalStage.boundingBox())!.height).toBeGreaterThan(300);
  // 세로 터치 제스처는 바깥 문서를 절대 움직이지 않는다. 클라이언트는 스크롤백을 쌓지 않으므로
  // (기록의 정본은 tmux copy-mode다) 잘린 행이 남아 있으면 상자를 옮기고, 없으면 tmux 기록을 요청한다.
  await expect(visibleTerminalRows).toContainText("터미널 기록");
  const documentScrollBefore = await page.evaluate(() => window.scrollY);
  const hostScrollBefore = await terminalHost.evaluate((element) => element.scrollTop);
  terminalScrolls.length = 0;
  await terminalHost.dispatchEvent("pointerdown", { pointerType: "touch", pointerId: 7, clientX: 180, clientY: 280, bubbles: true });
  await terminalHost.dispatchEvent("pointermove", { pointerType: "touch", pointerId: 7, clientX: 180, clientY: 390, bubbles: true });
  await terminalHost.dispatchEvent("pointerup", { pointerType: "touch", pointerId: 7, clientX: 180, clientY: 390, bubbles: true });
  await expect.poll(async () => terminalScrolls.some((lines) => lines > 0) || await terminalHost.evaluate((element) => element.scrollTop) !== hostScrollBefore).toBe(true);
  expect(await page.evaluate(() => window.scrollY)).toBe(documentScrollBefore);
  // Codex·Claude TUI가 mouse mode를 켠 상태에서는 같은 스와이프가 xterm 스크롤백이 아니라
  // 실제 PTY mouse-wheel 시퀀스로 전달되어 TUI 자체 기록을 움직여야 한다.
  pushTerminalOutput("\u001b[?1000h\u001b[?1006h");
  await page.waitForTimeout(50);
  terminalInputs.length = 0;
  await terminalHost.dispatchEvent("pointerdown", { pointerType: "touch", pointerId: 9, clientX: 180, clientY: 390, bubbles: true });
  await terminalHost.dispatchEvent("pointermove", { pointerType: "touch", pointerId: 9, clientX: 180, clientY: 280, bubbles: true });
  await terminalHost.dispatchEvent("pointerup", { pointerType: "touch", pointerId: 9, clientX: 180, clientY: 280, bubbles: true });
  await expect.poll(() => terminalInputs.join("")).toMatch(/\u001b\[<6[45];/);
  pushTerminalOutput("\u001b[?1000l\u001b[?1006l");
  // 256열 화면은 좌우 제스처로 터미널 안에서만 이동하고 페이지 폭은 늘리지 않는다.
  expect(await terminalHost.evaluate((element) => element.scrollWidth)).toBeGreaterThan(await terminalHost.evaluate((element) => element.clientWidth));
  await terminalHost.dispatchEvent("pointerdown", { pointerType: "touch", pointerId: 8, clientX: 310, clientY: 280, bubbles: true });
  await terminalHost.dispatchEvent("pointermove", { pointerType: "touch", pointerId: 8, clientX: 100, clientY: 280, bubbles: true });
  await terminalHost.dispatchEvent("pointerup", { pointerType: "touch", pointerId: 8, clientX: 100, clientY: 280, bubbles: true });
  expect(await terminalHost.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  // 모바일 키보드에서 만들기 어려운 조합은 Ctrl/Alt 잠금과 전용 키 버튼으로 원시 PTY 바이트를 보낸다.
  terminalInputs.length = 0;
  await page.getByRole("button", { name: "⌨ 키보드", exact: true }).click();
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await page.getByRole("button", { name: "Ctrl", exact: true }).click();
  await expect(page.getByRole("button", { name: "Ctrl", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.type("c");
  await expect.poll(() => terminalInputs.join("")).toBe("\u0003");
  terminalInputs.length = 0;
  await page.getByRole("button", { name: "Alt", exact: true }).click();
  await page.keyboard.type("x");
  await expect.poll(() => terminalInputs.join("")).toBe("\u001bx");
  terminalInputs.length = 0;
  await page.getByRole("button", { name: "PgUp", exact: true }).click();
  await page.getByRole("button", { name: "⇧Tab", exact: true }).click();
  await page.getByRole("button", { name: "Enter", exact: true }).click();
  expect(terminalInputs.join("")).toBe("\u001b[5~\u001b[Z\r");
  await page.getByRole("toolbar", { name: "모바일 터미널 키" }).evaluate((element) => { element.scrollLeft = 0; });
  await terminalHost.evaluate((element) => { element.scrollLeft = 0; });
  expect(await page.locator(".terminal-panel-full").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/ui-mobile-chat.png", fullPage: true });
  // 소프트 키보드가 열린 것처럼 visual viewport 높이가 줄어도 터미널과 키 바가 사라지지 않아야 한다.
  await page.setViewportSize({ width: 390, height: 390 });
  await expect(page.getByRole("toolbar", { name: "모바일 터미널 키" })).toBeVisible();
  expect((await terminalStage.boundingBox())!.height).toBeGreaterThan(130);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= document.documentElement.clientHeight)).toBe(true);
  await page.screenshot({ path: "artifacts/ui-mobile-terminal-compact.png" });
  await page.setViewportSize({ width: 390, height: 844 });

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

  await messageList.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
    element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2);
    element.dispatchEvent(new Event("scroll"));
  });
  // 가상 목록이 현재 보이는 행의 새 높이를 반영한 뒤 안정된 읽기 위치를 기준으로 비교한다.
  await page.waitForTimeout(120);
  const readingPosition = await messageList.evaluate((element) => element.scrollTop);
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
  await page.locator(".git-tabs").getByRole("button", { name: "깃허브", exact: true }).click();
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
  await page.locator(".git-tabs").getByRole("button", { name: "저장소", exact: true }).click();
  const connected = page.locator(".repository-row").filter({ hasText: "owner/connected" });
  await expect(connected).toContainText("연결됨");
  await connected.getByRole("button", { name: "채팅 열기" }).click();
  await expect(page).toHaveURL(/tab=chat/);
  await expect(page).toHaveURL(/project=1/);
  await expect(page.getByRole("heading", { name: "채팅", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "GitHub", exact: true }).click();
  await page.locator(".git-tabs").getByRole("button", { name: "저장소", exact: true }).click();
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
  let allAuthenticated = false;
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
        { key: "codex", provider: "codex", installed: true, authenticated: allAuthenticated, running: false, exitCode: allAuthenticated ? 0 : null },
        { key: "claude", provider: "claude", installed: true, authenticated: true, running: false, exitCode: 0 },
        { key: "github", provider: "github", installed: true, authenticated: true, running: false, exitCode: 0 },
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

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "닫기" })).toBeVisible();
  await page.screenshot({ path: "artifacts/ui-cli-auth-popup-mobile.png", fullPage: true });
  await page.evaluate(() => window.history.back());
  await expect(dialog).toHaveCount(0);
  const mobileAuth = page.getByRole("button", { name: "CLI 인증 관리" });
  await expect(mobileAuth).toBeVisible();
  await expect(mobileAuth.locator("xpath=..")).toHaveClass(/mobile-tabbar/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  allAuthenticated = true;
  await page.reload();
  await expect(dialog).toHaveCount(0);
  await expect(mobileAuth).toHaveCount(0);
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
  await page.evaluate(() => window.history.back());
  await expect(dialog).toHaveCount(0);
  await page.locator(".project-bar").getByRole("button", { name: "프로젝트", exact: true }).click();
  await expect(dialog).toBeVisible();
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
  await expect(page.locator(".file-preview").getByRole("link", { name: "README.md 다운로드" })).toHaveAttribute("href", "/api/projects/1/files/download?path=README.md&chatId=1");
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
    "-const oldValue: string = \"".concat("very-long-content-".repeat(30), "\";"),
    "+const newValue: string = \"".concat("very-long-content-".repeat(30), "\";"),
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
  await page.locator(".git-tabs").getByRole("button", { name: "깃허브", exact: true }).click();
  await expect(page.getByText("이슈 기록 없음", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "PR", exact: true }).click();
  await page.getByText("#1 테스트 PR").click();
  await expect(page.getByRole("heading", { name: "#1 테스트 PR" })).toBeVisible();
  // PR 상세를 열면 별도 버튼 없이 diff를 한 번 자동으로 읽는다.
  await expect(page.locator(".github-pr-diff .diff-file")).toHaveCount(2);
  expect(diffRequests).toHaveLength(1);
  // 두 파일이 섞인 diff가 로컬 Diff 탭·커밋 상세와 같은 방식으로 파일별 접이식 섹션으로 나뉘어야 한다.
  await expect(page.locator(".github-pr-diff .diff-file")).toHaveCount(2);
  await expect(page.locator(".github-pr-diff .diff-file-path").nth(0)).toHaveText("a.ts");
  await expect(page.locator(".github-pr-diff .diff-file-path").nth(1)).toHaveText("b.ts");
  await expect(page.getByText("2개 파일", { exact: true })).toBeVisible();
  // 대형 PR의 모든 줄을 동시에 만들지 않고, 펼친 파일의 diff만 지연 렌더링한다.
  await expect(page.locator(".github-pr-diff .diff-body")).toHaveCount(0);
  await page.locator(".github-pr-diff .diff-file-toggle").first().click();
  await expect(page.locator(".github-pr-diff .diff-body")).toHaveCount(1);
  await expect(page.locator(".github-pr-diff .diff-token").first()).toBeVisible();
  expect(await page.locator(".github-pr-diff .diff-row-add .diff-token").evaluateAll((tokens) => new Set(tokens.map((token) => getComputedStyle(token).color)).size)).toBeGreaterThan(1);
  await page.locator(".github-pr-diff").getByRole("button", { name: "분할", exact: true }).click();
  await expect(page.locator(".github-pr-diff .diff-body-split")).toHaveCount(1);
  await expect(page.locator(".github-pr-diff .diff-body-split .diff-token").first()).toBeVisible();
  await expect(page.locator(".github-pr-diff .diff-num.remove").first()).toHaveText("1");
  await expect(page.locator(".github-pr-diff .diff-num.add").first()).toHaveText("1");
  expect(await page.locator(".github-pr-diff .diff-body-split .diff-code").evaluateAll((cells) => cells.every((cell) => cell.scrollWidth <= cell.clientWidth + 1))).toBe(true);
  expect(await page.locator(".github-pr-diff .diff-body-split .diff-text").evaluateAll((texts) => texts.every((text) => {
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
  expect(await page.locator(".github-pr-diff .diff-body-split").first().evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/ui-pr-diff-split-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator(".github-pr-diff").getByRole("button", { name: "통합", exact: true }).click();
  await expect(page.locator(".github-pr-diff .diff-body-unified")).toHaveCount(1);
  await page.locator(".github-pr-diff .diff-file-toggle").first().click();
  await expect(page.locator(".github-pr-diff .diff-body")).toHaveCount(0);
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
  await page.locator(".git-tabs").getByRole("button", { name: "깃허브", exact: true }).click();
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
      "/api/usage": { usage: [{ provider: "claude", monitor_status: "ready", data_status: "fresh", used_percent: 29, remaining_percent: 71, reset_at: "Jul 18", keepalive_sent_at: "2026-08-11T03:40:00.000Z", keepalive_reason: "claude_session_missing", details_json: JSON.stringify({ windows: [{ id: "weekly_all", label: "Current week (all models)", usedPercent: 29, remainingPercent: 71, resetAt: "Jul 18" }] }) }] },
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
  await expect(page.getByText("세션 유지 단답", { exact: false })).toContainText("Claude 세션 창 없음");
  await expect(page.getByText("세션 유지 단답", { exact: false })).toContainText("마지막 전송");
  await expect(page.getByText("터미널 스냅샷")).toHaveCount(0);
  await page.getByRole("button", { name: "터미널 보기" }).click();
  expect(snapshotRequests).toHaveLength(1);
  await expect(page.getByText("터미널 스냅샷")).toBeVisible();
  await expect(page.locator(".usage-snapshot-text")).toContainText("세션 창 없음");
  fs.mkdirSync("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/ui-usage-snapshot.png" });
  await page.getByRole("button", { name: "닫기" }).click();
  await expect(page.getByText("터미널 스냅샷")).toHaveCount(0);
});

test("대시보드에서 Codex 초기화권을 확인 후 사용하고 채팅은 터미널 종료 경로를 사용한다", async ({ page }) => {
  const terminalStops: string[] = [];
  const processKills: string[] = [];
  const resetCreditRedemptions: Array<{ path: string; accountId: number }> = [];
  const dialogs: string[] = [];
  page.on("dialog", async (dialog) => { dialogs.push(dialog.message()); await dialog.accept(); });
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "ui-test", role: "admin" }, csrfToken: "ui-test" },
      "/api/providers": { providers: [{ id: "codex", label: "Codex", usageWindowId: "weekly", supportsPermissionMode: false }] },
      "/api/projects": { projects: [{ id: 1, name: "샘플 프로젝트", path: "/home/testuser/myagent" }] },
      "/api/chats": { chats: [] },
      "/api/usage": { usage: [{ provider: "codex", account_id: 1, monitor_status: "ready", data_status: "fresh", last_checked_at: "2026-08-11T01:30:00.000Z", details_json: JSON.stringify({ windows: [{ id: "weekly", label: "Weekly limit", usedPercent: 1, remainingPercent: 99, resetAt: "17:37 on 18 Aug" }], rateLimitResetCredits: { availableCount: 1, expiresAt: "2026-08-12T17:28:18.000Z" } }) }] },
      "/api/system": { latest: { cpuPercent: 1, memory: { total: 100, available: 50 }, disks: [], processes: [{ pid: 1234, name: "codex", cpu: 2, memory: 1024, chat: { chatId: 9, provider: "codex", title: "초기화권 표시", projectId: 1, projectName: "샘플 프로젝트" }, group: { kind: "chat", key: "chat:9", label: "샘플 프로젝트 · 초기화권 표시" } }] } },
      "/api/runtime": { codex: "0.146.0", claude: "disabled" },
      "/api/slack": { enabled: false },
      "/api/ntfy": { enabled: false },
      "/api/approvals": { approvals: [] },
    };
    if (pathname in responses) {
      await route.fulfill({ json: responses[pathname] });
      return;
    }
    if (pathname === "/api/chats/9/stop" && route.request().method() === "POST") {
      terminalStops.push(pathname);
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    if (pathname === "/api/usage/codex/reset-credit/redeem" && route.request().method() === "POST") {
      resetCreditRedemptions.push({ path: pathname, accountId: route.request().postDataJSON().accountId });
      await route.fulfill({ json: { outcome: "reset", credits: { availableCount: 0, expiresAt: null } } });
      return;
    }
    if (pathname.includes("/system/processes/") && route.request().method() === "POST") {
      processKills.push(pathname);
      await route.fulfill({ json: { accepted: true } });
      return;
    }
    await route.fulfill({ json: {} });
  });

  await page.goto("/");
  await expect(page.getByText("초기화권", { exact: true })).toBeVisible();
  await expect(page.locator(".usage-reset-credits")).toContainText("1개");
  await expect(page.locator(".usage-reset-credits span")).toHaveText(/기한 .*\d/);
  await page.getByRole("button", { name: "사용하기" }).click();
  await expect.poll(() => resetCreditRedemptions).toEqual([{ path: "/api/usage/codex/reset-credit/redeem", accountId: 1 }]);
  expect(dialogs.some((message) => message.includes("맨 위 Full reset") && message.includes("되돌릴 수 없습니다"))).toBe(true);
  await expect(page.getByRole("button", { name: "묶음 종료" })).toHaveCount(0);
  await page.getByRole("button", { name: "터미널 종료" }).click();
  await expect.poll(() => terminalStops).toEqual(["/api/chats/9/stop"]);
  expect(processKills).toHaveLength(0);
});

test("채팅과 GitHub 탭에서 채팅별 브랜치와 worktree를 전환한다", async ({ page }) => {
  const branchRequests: Record<string, unknown>[] = [];
  const worktreeChatRequests: Record<string, unknown>[] = [];
  const diffRequests: string[] = [];
  let workspace = {
    chatId: 11,
    branch: "main",
    path: "/workspace/sample",
    mode: "shared",
    dirty: false,
    canSwitch: true,
    branches: [
      { name: "main", remote: false, checkedOutPath: "/workspace/sample" },
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
      "/api/chats": { chats: [{ id: 11, project_id: 1, provider: "codex", status: "stopped", title: "브랜치 작업", git_branch: workspace.branch, worktree_path: workspace.mode === "worktree" ? workspace.path : null }] },
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
      await route.fulfill({ status: 201, json: { chat: { id: 12, project_id: 1, provider: "codex", status: "stopped", title: "feature/agent 작업", git_branch: "feature/agent", worktree_path: "/workspace/agent-worktree" } } });
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
  await page.locator(".chat-list .chat-item").filter({ hasText: "브랜치 작업" }).click();
  const chatControl = page.locator(".workspace .git-branch-control");
  await expect(page.locator(".workspace > .git-branch-control")).toHaveCount(0);
  await expect(chatControl.locator(".git-branch-trigger code")).toHaveText("main");
  expect(await chatControl.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThan(45);
  await chatControl.getByRole("button", { name: "Git 작업공간 변경" }).click();
  const desktopEditor = chatControl.locator(".git-branch-editor");
  await expect(desktopEditor).toBeVisible();
  const desktopEditorBox = await desktopEditor.boundingBox();
  expect(desktopEditorBox).not.toBeNull();
  expect(desktopEditorBox!.x).toBeGreaterThanOrEqual(0);
  expect(desktopEditorBox!.x + desktopEditorBox!.width).toBeLessThanOrEqual(1440);
  await chatControl.getByLabel("Git 브랜치 선택").selectOption("feature/existing");
  await chatControl.getByRole("button", { name: "전용", exact: true }).click();
  await chatControl.getByRole("button", { name: "전환", exact: true }).click();
  expect(branchRequests).toEqual([{ chatId: 11, branch: "feature/existing", create: false, mode: "worktree" }]);
  await expect(chatControl.getByText("전용", { exact: true })).toBeVisible();
  expect(await chatControl.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThan(45);
  fs.mkdirSync("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/ui-chat-branch-compact.png", fullPage: true });

  await page.getByRole("button", { name: "GitHub", exact: true }).click();
  await page.locator(".git-tabs").getByRole("button", { name: "로컬", exact: true }).click();
  const gitControl = page.locator(".git-page > .git-branch-control");
  await expect(gitControl.locator(".git-branch-trigger code")).toHaveText("feature/existing");
  await expect(page.getByRole("heading", { name: "최근 커밋" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "파일 diff" })).toBeVisible();
  await expect(page.getByText("변경 파일을 선택하면", { exact: false })).toBeVisible();
  expect(diffRequests).toHaveLength(0);
  await page.getByRole("checkbox", { name: /src\/selected\.ts/ }).check();
  await expect(page.getByRole("heading", { name: "선택 파일 diff (1)" })).toBeVisible();
  await expect(page.getByText("selected change", { exact: false })).toBeVisible();
  expect(diffRequests).toHaveLength(1);
  expect(new URLSearchParams(diffRequests[0]).getAll("file")).toEqual(["src/selected.ts"]);
  await page.getByRole("checkbox", { name: /src\/deleted\.ts/ }).check();
  await expect(page.getByRole("heading", { name: "선택 파일 diff (2)" })).toBeVisible();
  await expect(page.getByText("deleted change", { exact: false })).toBeVisible();
  expect(diffRequests).toHaveLength(2);
  expect(new URLSearchParams(diffRequests[1]).getAll("file")).toEqual(["src/selected.ts", "src/deleted.ts"]);
  await expect(page.getByRole("button", { name: "브랜치 변경" })).toHaveCount(0);
  expect(await gitControl.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await gitControl.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await page.locator(".git-main").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  // GitHub 화면은 확인 전용이라 실제 브랜치 변경 메뉴를 열지 않고 현재 작업공간만 표시한다.
  await expect(gitControl.getByRole("button", { name: "Git 작업공간 변경" })).toHaveCount(0);
  await page.screenshot({ path: "artifacts/ui-chat-git-worktree.png", fullPage: true });
});

test("지침 편집기와 도구 상세를 데스크톱·모바일에서 렌더링한다", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "ui-test", role: "admin" }, csrfToken: "ui-test" },
      "/api/providers": { providers: [{ id: "codex", label: "Codex" }, { id: "claude", label: "Claude" }] },
      "/api/projects": { projects: [{ id: 1, name: "샘플 프로젝트", path: "/workspace/sample" }], defaultPath: "/workspace" },
      "/api/chats": { chats: [] },
      "/api/projects/1/session-backups": { backups: [] },
      "/api/usage": { usage: [] },
      "/api/system": { latest: null },
      "/api/runtime": { codex: "0.2.0", claude: "1.0.0" },
      "/api/slack": { enabled: false },
      "/api/ntfy": { enabled: false },
      "/api/approvals": { approvals: [] },
      "/api/agent-accounts": { accounts: [], usageScope: "default" },
      "/api/instructions/catalog": { project: ["AGENTS.md", "CLAUDE.md"], global: ["codex/AGENTS.md"] },
      "/api/instructions": { content: "# 프로젝트 지침\n\n- 변경 전 화면을 직접 확인합니다.\n- 검증 후 작업 기록을 남깁니다.\n" },
      "/api/tools/catalog": { items: [
        { id: "claude:skills:ui-review", provider: "claude", kind: "skills", label: "UI Review", name: "ui-review", description: "화면의 정보 위계와 반응형 동작을 검토합니다.", source: "project", scope: "project", status: "active", details: { path: "skills/ui-review/SKILL.md" } },
      ] },
    };
    if (pathname in responses) {
      await route.fulfill({ json: responses[pathname] });
      return;
    }
    await route.fulfill({ json: {} });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "지침", exact: true }).click();
  await expect(page.getByRole("heading", { name: "AGENTS.md · CLAUDE.md" })).toBeVisible();
  await expect(page.locator(".code-editor")).toContainText("변경 전 화면을 직접 확인합니다.");
  await page.screenshot({ path: "artifacts/ui-instructions.png", fullPage: true });

  await page.getByRole("button", { name: "도구", exact: true }).click();
  await page.locator(".segmented").getByRole("button", { name: "Skills", exact: true }).click();
  await expect(page.getByRole("heading", { name: "UI Review" })).toBeVisible();
  await page.screenshot({ path: "artifacts/ui-tools-detail.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "UI Review" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/ui-tools-detail-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "지침", exact: true }).click();
  await expect(page.locator(".code-editor")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/ui-instructions-mobile.png", fullPage: true });
});

test("Agent Lab에서 Variant 비교와 evaluator provenance를 표시한다", async ({ page }) => {
  const experiment = {
    id: "experiment-1", projectId: 1, name: "스킬 유무 비교", command: "기능을 구현해",
    taskKind: "maintenance", fixtureId: "fixture-1",
    design: {
      schemaVersion: 1, hypothesis: "review 스킬이 성공률을 높인다",
      controlledVariables: ["runtime.model", "budget"], treatmentVariables: ["skills.mode"],
      repetitions: 5, randomizeOrder: true,
    },
    variants: [
      {
        id: "variant-1", name: "Codex High + Skills",
        config: { runtime: { provider: "codex", model: "gpt-test", reasoningEffort: "high" }, skills: { mode: "all", profile: "isolated_overlay", baseline: "installed", additions: ["lab:review-plus"] } },
        runs: [{
          id: "run-1", attempt: 3, status: "completed", totalTokens: 12400, totalTokensSource: "reported", costUsd: 0.43,
          startedAt: "2026-08-13 09:00:00", finishedAt: "2026-08-13 09:01:00", judgmentSummary: { count: 1, meanScore: 0.91 },
          waitedSeconds: 20, waitCount: 1,
          checkStatus: "passed", checkExitCode: 0, checkDurationMs: 12_000,
        }],
      },
      {
        id: "variant-2", name: "Codex High · Skills off",
        config: { runtime: { provider: "codex", model: "gpt-test", reasoningEffort: "high" }, skills: { mode: "none", profile: "isolated_overlay", baseline: "clean", additions: [] } },
        runs: [{ id: "run-2", attempt: 2, status: "failed", totalTokens: 9800, costUsd: 0.31 }],
      },
    ],
  };
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user: { id: 1, username: "ui-test", role: "admin" }, csrfToken: "ui-test" },
      "/api/providers": { providers: [{ id: "codex", label: "Codex" }, { id: "claude", label: "Claude" }] },
      "/api/projects": { projects: [{ id: 1, name: "샘플 프로젝트", path: "/home/testuser/myagent" }] },
      "/api/chats": { chats: [] },
      "/api/usage": { usage: [] },
      "/api/system": { latest: null },
      "/api/runtime": { codex: "test", claude: "test" },
      "/api/slack": { enabled: false },
      "/api/ntfy": { enabled: false },
      "/api/approvals": { approvals: [] },
      "/api/projects/1/experiments": { experiments: [experiment] },
      "/api/projects/1/experiment-fixtures": { fixtures: [
        { id: "fixture-1", name: "django", sizeClass: "large", status: "ready", pinnedCommit: "a".repeat(40) },
      ] },
      "/api/experiments/experiment-1/summary": {
        variants: [
          { variantId: "variant-1", name: "Codex High + Skills", completedRuns: 3, checkPassRate: 1, totalTokenMedian: 12400 },
          { variantId: "variant-2", name: "Codex High · Skills off", completedRuns: 3, checkPassRate: 0.33, totalTokenMedian: 9800 },
        ],
        recommendation: {
          grade: "confirmed", winnerVariantId: "variant-1", runnerUpVariantId: "variant-2",
          criterion: "deterministic_check", costMultiple: 1.2653,
          reason: "결정적 검사 통과율에서 Codex High + Skills이 우세합니다(표본 3회).",
        },
      },
      "/api/projects/1/experiment-skills": { candidates: [
        { id: "installed:project:wam", name: "wam", source: "installed", scope: "project", includedByDefault: true },
        { id: "lab:review-plus", name: "review-plus", source: "project_lab", scope: "lab", includedByDefault: false },
      ] },
      "/api/experiment-runs/run-1": {
        run: {
          ...experiment.variants[0].runs[0],
          configSnapshot: { runtime: { provider: "codex", model: "gpt-test" } },
          terminationReason: "success", error: null,
          environmentSnapshot: { skillIsolation: {
            profile: "isolated_overlay", baseline: "installed", additions: [{ id: "lab:review-plus" }],
            controlFingerprint: "a".repeat(64), digest: "b".repeat(64),
          } },
        },
        nodes: [{ id: "node-1", role: "worker", status: "completed" }],
        events: [{ id: "event-1", sequence: 1, type: "run.preparing", createdAt: "2026-08-13 09:00:00" }, { id: "event-2", sequence: 2, type: "runtime.completed", createdAt: "2026-08-13 09:01:00" }],
        checkpoint: null,
        evaluations: [{
          id: "evaluation-1", method: "rubric", status: "partial", error: "Codex judge: JSON 형식 오류",
          calls: [
            { id: "call-1", evaluatorLabel: "Claude judge", status: "completed", totalTokens: 880, costUsd: 0.018 },
            { id: "call-2", evaluatorLabel: "Codex judge", status: "failed", totalTokens: 420, costUsd: null },
          ],
        }],
        judgments: [{
          id: "judgment-1", evaluatorLabel: "Claude judge", evaluatorKind: "agent",
          evaluatorProvider: "claude", evaluatorModel: "sonnet-test", evaluatorFamily: "claude",
          subjectProvider: "claude", subjectModel: "sonnet-subject", subjectFamily: "claude", sameFamily: true,
          blindLabel: "result-b", presentationOrder: 2, score: 0.91, confidence: 0.8,
          result: { reason: "요건과 테스트를 모두 충족했습니다." },
        }],
      },
      "/api/experiment-runs/run-1/promote": {
        preset: {
          id: "preset-1", name: "스킬 유무 비교 우승", status: "active", activeVersion: 1,
          versions: [{ version: 1, promotionMetrics: { successRate: 1, sampleSize: 1 }, compatibility: { status: "warning", warnings: ["표본이 2회 미만입니다."] } }],
        },
      },
    };
    if (pathname in responses) {
      await route.fulfill({ json: responses[pathname] });
      return;
    }
    await route.fulfill({ json: {} });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "실험실", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "조건을 바꿔 실행하고, 측정하고, 판단합니다" })).toBeVisible();
  await expect(page.getByRole("table").getByText("Codex High + Skills", { exact: true })).toBeVisible();
  await expect(page.getByText("1.2만")).toBeVisible();
  await expect(page.getByRole("cell", { name: /91점 1 judgments/ })).toBeVisible();
  // 벽시계 1분 중 한도 대기 20초를 빼 실작업 40초로 보여야 한다.
  await expect(page.getByRole("cell", { name: /40초 실작업 · 한도 대기 1회 20초 제외/ })).toBeVisible();
  // 완성도의 1차 지표인 fixture 검증 명령 결과가 rubric 점수보다 앞에 보여야 한다.
  await expect(page.getByRole("cell", { name: /통과 12초/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: /- 검증 없음/ })).toBeVisible();
  // 표와 점수는 재료일 뿐이라 어떤 기준으로 갈렸는지와 표본 충분 여부를 함께 보여야 한다.
  await expect(page.getByText("확증", { exact: true })).toBeVisible();
  await expect(page.getByText(/기준 결정적 검사 · 기준선 대비 토큰 1.27배/)).toBeVisible();
  await expect(page.getByText(/통과율에서 Codex High \+ Skills이 우세/)).toBeVisible();
  // 과제 유형과 대상 저장소가 실험 목록에 드러나야 어떤 상황의 결과인지 알 수 있다.
  await expect(page.getByText("유지보수", { exact: true })).toBeVisible();
  await expect(page.getByText("대형 · django", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /계획 실행 · 5회 교차/ })).toBeVisible();
  await expect(page.getByText(/대기 후 재개한 run은 캐시·턴 구조가 달라져 토큰 지표가 오염될 수 있습니다/)).toBeVisible();
  await page.getByRole("button", { name: "Variant 추가" }).click();
  await expect(page.getByRole("checkbox", { name: /review-plus/ })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /wam/ })).toBeDisabled();
  await page.getByRole("checkbox", { name: /review-plus/ }).check();
  await page.locator(".lab-form label").filter({ hasText: /^Provider/ }).locator("select").selectOption("claude");
  await expect(page.getByLabel("추가 스킬 활성화")).toBeVisible();
  await page.getByLabel("추가 스킬 활성화").selectOption("session_start");
  await expect(page.getByLabel("추가 스킬 활성화")).toHaveValue("session_start");
  fs.mkdirSync("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/ui-agent-lab-skill-form.png", fullPage: true });
  await page.getByLabel("Harness").selectOption("orchestrator_worker");
  await expect(page.getByText(/선택 추가 overlay는 Single/)).toBeVisible();
  await expect(page.getByLabel("Secondary provider")).toBeVisible();
  await expect(page.getByLabel("Worker 수")).toHaveValue("2");
  fs.mkdirSync("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/ui-agent-lab-harness-form.png", fullPage: true });
  await page.getByRole("button", { name: "Variant 추가" }).click();
  await page.locator(".lab-run-link").first().click();
  await expect(page.getByText("Claude judge", { exact: true })).toBeVisible();
  await expect(page.getByText("피험 모델과 동일 계열", { exact: true })).toBeVisible();
  await expect(page.getByText("result-b / 2", { exact: true })).toBeVisible();
  await expect(page.getByText("요건과 테스트를 모두 충족했습니다.", { exact: true })).toBeVisible();
  await expect(page.getByText("부분 성공", { exact: true })).toBeVisible();
  await expect(page.getByText(/Claude judge: completed/)).toBeVisible();
  await page.getByRole("button", { name: "복수 평가" }).click();
  await expect(page.getByText("블라인드 rubric 평가", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Codex evaluator model")).toBeVisible();
  await expect(page.getByLabel("Claude evaluator model")).toBeVisible();
  await page.getByRole("button", { name: "프리셋 승격" }).click();
  await expect(page.getByText("Winner promotion", { exact: true })).toBeVisible();
  await page.getByLabel("선택 근거").fill("품질 우선");
  await page.getByRole("button", { name: "활성 프리셋으로 승격" }).click();
  await expect(page.getByText("스킬 유무 비교 우승 · v1", { exact: true })).toBeVisible();
  await expect(page.getByText("⚠ 표본이 2회 미만입니다.", { exact: true })).toBeVisible();
  expect(await page.locator(".agent-lab").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  fs.mkdirSync("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/ui-agent-lab.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".mobile-tabbar").getByRole("button", { name: "실험실", exact: true })).toBeVisible();
  expect(await page.locator("body").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/ui-agent-lab-mobile.png", fullPage: true });
});

test("로그인 화면을 데스크톱·모바일에서 렌더링한다", async ({ page }) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({ status: 401, json: { error: "로그인이 필요합니다." } }));
  await page.route("**/api/auth/setup-status", (route) => route.fulfill({ json: { setupRequired: false } }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "web-agent-manager" })).toBeVisible();
  await expect(page.getByLabel("아이디")).toBeVisible();
  await page.screenshot({ path: "artifacts/ui-login.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/ui-login-mobile.png", fullPage: true });
});
