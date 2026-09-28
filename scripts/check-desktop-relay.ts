// 데스크톱 앱 중계 모드(#139)를 실제 Electron으로 띄워 확인하는 수동 검증 스크립트.
// 사용: xvfb-run -a npx tsx scripts/check-desktop-relay.ts [확인할 실제 WAM 주소, 기본 http://127.0.0.1:14003]
// Electron 바이너리가 필요하다(node node_modules/electron/install.js). CI 화면 테스트에는 넣지 않는다.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

const realWam = process.argv[2] ?? "http://127.0.0.1:14003";
const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "wam-desktop-relay-"));
const shots = path.resolve("artifacts");

// 중계 모드로 앱을 띄운다. userData는 임시 XDG_CONFIG_HOME 아래에 둔다.
async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: ["--no-sandbox", "."],
    env: { ...process.env, XDG_CONFIG_HOME: configHome, WEB_AGENT_MANAGER_DESKTOP_MODE: "remote", WEB_AGENT_MANAGER_SERVER_URL: "", MYAGENT_SERVER_URL: "" },
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 860 }).catch(() => undefined);
  return { app, page };
}

async function connect(page: Page, url: string): Promise<void> {
  await page.fill("#server-url", url);
  await page.click("#submit");
}

// health·초기 설정 상태·첫 화면만 응답하는 가짜 WAM.
async function fakeWam(): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer((request, response) => {
    if (request.url === "/health") return void response.end("{\"ok\":true}");
    if (request.url === "/api/auth/setup-status") return void response.end("{\"setupRequired\":false}");
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end("<!doctype html><title>fake wam</title><h1>fake wam ui</h1>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

const results: string[] = [];
try {
  // 1) 처음 실행: 저장된 주소가 없으면 연결 화면
  let { app, page } = await launch();
  await page.waitForSelector("#connect-form");
  await page.screenshot({ path: path.join(shots, "ui-desktop-relay-connect.png") });
  results.push("첫 실행 연결 화면");

  // 2) 공개 HTTP 주소 경고, 연결 불가 주소 오류
  await page.fill("#server-url", "http://8.8.8.8:14003");
  await page.waitForFunction(() => document.getElementById("warning")?.textContent?.includes("암호화되지 않은"));
  await page.fill("#server-url", "https://wam.example.com/app");
  await page.click("#submit");
  await page.waitForFunction(() => document.getElementById("status")?.textContent?.includes("경로"));
  await connect(page, "http://127.0.0.1:1");
  await page.waitForFunction(() => document.getElementById("status")?.textContent?.includes("연결할 수 없습니다"), undefined, { timeout: 15_000 });
  await page.screenshot({ path: path.join(shots, "ui-desktop-relay-error.png") });
  results.push("HTTP 경고·경로 거부·연결 불가 오류");

  // 3) 실제 WAM 접속과 주소 저장
  await connect(page, realWam);
  await page.waitForURL((url) => url.origin === new URL(realWam).origin, { timeout: 15_000 });
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: path.join(shots, "ui-desktop-relay-wam.png") });
  const saved = JSON.parse(fs.readFileSync(path.join(configHome, "web-agent-manager", "connection.json"), "utf8"));
  assert.equal(saved.serverUrl, new URL(realWam).origin);
  results.push(`실제 WAM 접속(${realWam})·주소 저장`);
  await app.close();

  // 4) 재실행하면 저장한 주소로 바로 접속
  ({ app, page } = await launch());
  await page.waitForURL((url) => url.origin === new URL(realWam).origin, { timeout: 15_000 });
  results.push("재실행 자동 접속");

  // 5) 메뉴의 연결 서버 변경 → 현재 주소가 채워진 연결 화면, 가짜 WAM으로 변경
  const fake = await fakeWam();
  await app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.items.find((menu) => menu.label === "연결")?.submenu?.items.find((entry) => entry.label.startsWith("연결 서버 변경"));
    if (!item) throw new Error("연결 서버 변경 메뉴가 없습니다.");
    item.click();
  });
  await page.waitForSelector("#connect-form");
  assert.equal(await page.inputValue("#server-url"), new URL(realWam).origin);
  await connect(page, fake.url);
  await page.waitForSelector("text=fake wam ui");
  results.push("메뉴로 연결 서버 변경");
  await app.close();

  // 6) 저장된 서버가 꺼져 있으면 오류와 함께 연결 화면
  await fake.close();
  ({ app, page } = await launch());
  await page.waitForSelector("#connect-form");
  await page.waitForFunction(() => document.getElementById("status")?.textContent?.includes("연결할 수 없습니다"));
  assert.equal(await page.inputValue("#server-url"), fake.url);
  await page.screenshot({ path: path.join(shots, "ui-desktop-relay-offline.png") });
  results.push("저장 서버 꺼짐 → 연결 화면 복귀");
  await app.close();
  console.log(JSON.stringify({ passed: true, results }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ passed: false, results, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  fs.rmSync(configHome, { recursive: true, force: true });
}
