// Windows 데스크톱 앱의 "이 PC에서 WAM 실행" 흐름(#156)을 실제 Electron으로 확인하는 수동 검증 스크립트.
// Linux에서 WEB_AGENT_MANAGER_DESKTOP_MODE=choose로 Windows와 같은 선택형 흐름을 켜고, 서버는 시스템 Node 22로 띄운다.
// 운영 환경을 건드리지 않도록 가짜 HOME·userData, claude·codex가 없는 PATH, /home 밖 앱 복사본을 쓴다.
// 사용: xvfb-run -a npx tsx scripts/check-desktop-local.ts
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

const repo = path.resolve(".");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "wam-desktop-local-"));
const appDir = path.join(work, "app");
const home = path.join(work, "home");
const configHome = path.join(work, "config");
const shots = path.join(repo, "artifacts");
const port = 14571;
const conflictPort = 14572;
const nodeBin = process.execPath;
fs.mkdirSync(appDir); fs.mkdirSync(home); fs.mkdirSync(configHome);
// electron/은 복사해야 __dirname이 복사본을 가리킨다(심볼릭 링크면 실제 저장소 경로로 풀린다).
fs.cpSync(path.join(repo, "electron"), path.join(appDir, "electron"), { recursive: true });
fs.copyFileSync(path.join(repo, "package.json"), path.join(appDir, "package.json"));
for (const name of ["dist", "node_modules", "skills"]) fs.symlinkSync(path.join(repo, name), path.join(appDir, name));
const binDir = path.join(work, "bin");
fs.mkdirSync(binDir);
fs.symlinkSync(nodeBin, path.join(binDir, "node"));
for (const tool of ["git", "tmux", "bash", "sh"]) {
  const found = spawnSync("which", [tool], { encoding: "utf8" }).stdout.trim();
  if (found) fs.symlinkSync(found, path.join(binDir, tool));
}
const env = { PATH: binDir, HOME: home, XDG_CONFIG_HOME: configHome, DISPLAY: process.env.DISPLAY ?? "", XAUTHORITY: process.env.XAUTHORITY ?? "", WEB_AGENT_MANAGER_DESKTOP_MODE: "choose", WEB_AGENT_MANAGER_NODE: nodeBin };
const electronBin = path.join(repo, "node_modules", "electron", "dist", "electron");

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ executablePath: electronBin, args: ["--no-sandbox", appDir], env });
  const page = await app.firstWindow();
  return { app, page };
}

async function health(url: string): Promise<number> {
  try { return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) })).status; } catch { return 0; }
}

const results: string[] = [];
// 진행 상황을 파일에 바로 써서, 스크립트가 멈추거나 강제 종료돼도 어느 단계인지 남긴다.
const progressFile = process.env.WAM_DESKTOP_PROGRESS ?? path.join(os.tmpdir(), "wam-desktop-local-progress.log");
const progress = (text: string): void => fs.appendFileSync(progressFile, `${new Date().toISOString()} ${text}\n`);
progress("시작");
let conflict: http.Server | undefined;
try {
  // 1) 첫 실행: 시작 방식 선택 화면
  let { app, page } = await launch();
  await page.waitForSelector("#local-form");
  await page.screenshot({ path: path.join(shots, "ui-desktop-mode-choose.png") });
  progress(`단계 ${results.length + 1} 완료`); results.push("첫 실행 시작 방식 선택 화면");

  // 2) 이 PC에서 실행(외부 접속 허용, 이 PC에서 닿지 않는 공개 주소) → 관리자 생성 → WAM 로그인 화면
  // 공개 주소가 이 PC 안에서 안 닿아도 앱 창·상태 확인은 127.0.0.1로 열려야 한다(Windows 실사용에서 Tailscale 주소로 확인하다 실패).
  const unreachable = "10.255.255.1";
  await page.fill("#port", String(port));
  await page.check("#allow-network");
  await page.evaluate((value) => { const select = document.getElementById("address") as HTMLSelectElement; select.add(new Option(value, value)); select.value = value; }, unreachable);
  await page.click("#local-submit");
  progress("로컬 시작 클릭");
  await page.waitForSelector("#setup-form", { timeout: 30_000 });
  progress("관리자 화면");
  await page.fill("#username", "desktopadmin");
  const password = `pw-${Math.random().toString(36).slice(2)}-local`;
  await page.fill("#password", password);
  await page.fill("#confirm-password", password);
  await page.click("#submit");
  progress("관리자 생성 클릭");
  await page.waitForURL(`http://127.0.0.1:${port}/**`, { timeout: 20_000 });
  await page.getByLabel("아이디").waitFor({ timeout: 20_000 });
  await page.screenshot({ path: path.join(shots, "ui-desktop-local-wam.png") });
  assert.equal(await health(`http://127.0.0.1:${port}`), 200);
  const saved = JSON.parse(fs.readFileSync(path.join(configHome, "web-agent-manager", "local-node.json"), "utf8"));
  assert.deepEqual(saved, { host: "0.0.0.0", port, publicUrl: `http://${unreachable}:${port}` });
  progress(`단계 ${results.length + 1} 완료`); results.push("로컬 서버 시작(공개 주소가 안 닿아도 127.0.0.1로 확인)·관리자 생성·설정 저장(데이터 경로 미저장)");

  // 3) 창을 닫으면 트레이로 숨고 서버는 계속 돈다
  // 사용자가 X 버튼을 누른 것처럼 메인 프로세스에서 창을 닫는다(페이지 안 window.close()는 닫기가 막히면 응답을 기다리며 멈춘다).
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close(); });
  await new Promise((resolve) => setTimeout(resolve, 800));
  const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((win) => win.isVisible()));
  assert.deepEqual(visible, [false]);
  assert.equal(await health(`http://127.0.0.1:${port}`), 200);
  progress(`단계 ${results.length + 1} 완료`); results.push("창 닫기 → 숨김(트레이 상주), 서버 유지");

  // 4) 두 번째 실행은 바로 끝나고 기존 창이 다시 보인다
  const second = spawnSync(electronBin, ["--no-sandbox", appDir], { env, timeout: 20_000 });
  assert.equal(second.status, 0);
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.deepEqual(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((win) => win.isVisible())), [true]);
  progress(`단계 ${results.length + 1} 완료`); results.push("중복 실행 방지·기존 창 표시");

  // 5) 종료하면 서버도 멈춘다
  await app.close();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(await health(`http://127.0.0.1:${port}`), 0);
  progress(`단계 ${results.length + 1} 완료`); results.push("앱 종료 → 서버도 종료");

  // 6) 다시 실행하면 저장된 설정으로 바로 서버를 띄운다
  ({ app, page } = await launch());
  await page.waitForURL(`http://127.0.0.1:${port}/**`, { timeout: 30_000 });
  progress(`단계 ${results.length + 1} 완료`); results.push("재실행 시 저장된 설정으로 자동 시작");

  // 7) 시작 방식 변경에서 다른 프로그램이 쓰는 포트를 고르면 저장하지 않고 안내한다
  conflict = http.createServer((_req, res) => { res.end("{\"ok\":true}"); });
  await new Promise<void>((resolve) => conflict!.listen(conflictPort, "127.0.0.1", resolve));
  await app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.items.find((menu) => menu.label === "WAM")?.submenu?.items.find((entry) => entry.label.startsWith("시작 방식 변경"));
    if (!item) throw new Error("시작 방식 변경 메뉴가 없습니다.");
    item.click();
  });
  await page.waitForSelector("#local-form");
  await page.fill("#port", String(conflictPort));
  await page.uncheck("#allow-network");
  await page.click("#local-submit");
  await page.waitForFunction(() => document.getElementById("status")?.textContent?.includes("이미 다른 프로그램"), undefined, { timeout: 15_000 });
  await page.screenshot({ path: path.join(shots, "ui-desktop-mode-port-conflict.png") });
  assert.equal(JSON.parse(fs.readFileSync(path.join(configHome, "web-agent-manager", "local-node.json"), "utf8")).port, port);
  progress(`단계 ${results.length + 1} 완료`); results.push("포트 충돌 안내·설정 유지");

  // 8) 다른 WAM에 접속으로 바꾸면 로컬 서버를 멈추고 연결 화면을 연다
  await page.click("#remote");
  await page.waitForSelector("#connect-form");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(await health(`http://127.0.0.1:${port}`), 0);
  progress(`단계 ${results.length + 1} 완료`); results.push("다른 WAM 접속으로 전환 → 로컬 서버 중지·연결 화면");
  await app.close();
  console.log(JSON.stringify({ passed: true, results }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ passed: false, results, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  conflict?.close();
  fs.rmSync(work, { recursive: true, force: true });
}
