import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { chromium } from "playwright-core";
import { loadConfig } from "../src/server/core/config";
import { openDatabase } from "../src/server/core/database";
import { LivePreviewService } from "../src/server/services/live-preview";

const roots: string[] = [];
const servers: http.Server[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  while (servers.length) await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
  while (children.length) {
    const child = children.pop()!;
    if (child.exitCode === null) { child.kill(); await once(child, "exit").catch(() => undefined); }
  }
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function browserExecutable(): string | undefined {
  const candidates = [process.env.WEB_AGENT_MANAGER_PREVIEW_BROWSER_EXECUTABLE, "/usr/bin/google-chrome", chromium.executablePath()];
  return candidates.find((candidate): candidate is string => !!candidate && fs.existsSync(candidate));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function ownerOnlyBrowserLauncher(root: string, executable: string | undefined): string | undefined {
  if (!executable) return undefined;
  // hosted runner의 공유 Chrome 권한과 무관하게, 서비스에는 이 테스트가 소유한 고정 launcher를 준다.
  const launcher = path.join(root, "preview-browser");
  fs.writeFileSync(launcher, `#!/bin/sh\nexec ${shellQuote(fs.realpathSync(executable))} "$@"\n`, { mode: 0o700 });
  return launcher;
}

function fixture(executable = browserExecutable()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-live-preview-")); roots.push(root);
  const config = loadConfig(); config.dataDir = root; config.previewBrowserExecutable = ownerOnlyBrowserLauncher(root, executable);
  const database = openDatabase(config);
  database.prepare("INSERT INTO users(id, username, password_hash, role) VALUES (1, 'admin', 'hash', 'admin')").run();
  const projectId = Number(database.prepare("INSERT INTO projects(name, path) VALUES ('preview', '/workspace/preview')").run().lastInsertRowid);
  const accountId = Number((database.prepare("SELECT id FROM agent_accounts WHERE provider = 'codex'").get() as { id: number }).id);
  const chatId = Number(database.prepare("INSERT INTO chats(project_id, provider, account_id, tmux_name, status, title) VALUES (?, 'codex', ?, 'preview_chat', 'stopped', 'preview')").run(projectId, accountId).lastInsertRowid);
  database.prepare("INSERT INTO agent_tasks(id, chat_id, project_id, state) VALUES ('preview-task', ?, ?, 'running')").run(chatId, projectId);
  return { root, config, database, projectId, service: new LivePreviewService(database, config) };
}

function addTask(database: ReturnType<typeof openDatabase>, projectId: number, id: string, index: number): void {
  const accountId = Number((database.prepare("SELECT id FROM agent_accounts WHERE provider = 'codex'").get() as { id: number }).id);
  const chatId = Number(database.prepare("INSERT INTO chats(project_id, provider, account_id, tmux_name, status, title) VALUES (?, 'codex', ?, ?, 'stopped', ?)")
    .run(projectId, accountId, `preview_chat_${index}`, `preview ${index}`).lastInsertRowid);
  database.prepare("INSERT INTO agent_tasks(id, chat_id, project_id, state) VALUES (?, ?, ?, 'running')").run(id, chatId, projectId);
}

describe("loopback live preview 증거 수집", () => {
  it("프로젝트 경로에서 실행 중인 HTTP listener만 preview 후보로 찾는다", async () => {
    const fixtureValue = fixture();
    fixtureValue.database.prepare("UPDATE projects SET path=? WHERE id=?").run(fixtureValue.root, fixtureValue.projectId);
    const child = spawn(process.execPath, ["-e", `const http=require('node:http');const server=http.createServer((_q,r)=>{r.writeHead(200);r.end('ok')});server.listen(0,'127.0.0.1',()=>console.log(server.address().port));`], {
      cwd: fixtureValue.root, stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    const port = await new Promise<number>((resolve, reject) => {
      let output = "";
      child.stdout!.on("data", (chunk) => { output += String(chunk); const value = Number(output.trim()); if (Number.isInteger(value)) resolve(value); });
      child.once("error", reject); child.once("exit", (code) => { if (code && !output.trim()) reject(new Error(`fixture server exit ${code}`)); });
    });

    await expect(fixtureValue.service.discoverTargets(fixtureValue.projectId)).resolves.toEqual([
      { url: `http://127.0.0.1:${port}/`, label: `node · ${port}`, port },
    ]);
    fixtureValue.database.close();
  });

  it("공인·사설·credential URL과 범위 밖 viewport를 저장 전에 거부한다", () => {
    const fixtureValue = fixture();
    for (const url of ["https://example.com", "http://192.168.0.2:3000", "file:///etc/passwd", "http://user:pass@localhost:3000"]) {
      expect(() => fixtureValue.service.setTarget(fixtureValue.projectId, { url, viewportWidth: 390, viewportHeight: 844 }, 1)).toThrow(/loopback/);
    }
    expect(() => fixtureValue.service.setTarget(fixtureValue.projectId, { url: "http://127.0.0.1:3000", viewportWidth: 200, viewportHeight: 844 }, 1)).toThrow(/viewport/);
    fixtureValue.database.close();
  });

  it.skipIf(!browserExecutable())("실제 Chrome으로 console/network/viewport/screenshot을 수집하고 외부 요청·민감 query를 남기지 않는다", async () => {
    const app = http.createServer((request, response) => {
      if (request.url?.startsWith("/data")) { response.writeHead(200, { "content-type": "application/json" }); response.end('{"ok":true}'); return; }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><meta charset="utf-8"><title>Preview fixture</title><style>body{background:#123;color:white}</style>
        <h1 id="size"></h1><script>
        document.querySelector('#size').textContent = innerWidth + 'x' + innerHeight;
        console.log('api_key=super-secret-value https://example.com/path?token=do-not-store');
        fetch('/data?access_token=local-secret'); fetch('https://example.com/private?token=external-secret').catch(()=>{});
        </script>`);
    });
    app.listen(0, "127.0.0.1"); await once(app, "listening"); servers.push(app);
    const port = (app.address() as AddressInfo).port;
    const fixtureValue = fixture(browserExecutable());
    fixtureValue.service.setTarget(fixtureValue.projectId, { url: `http://127.0.0.1:${port}/?password=url-secret`, viewportWidth: 390, viewportHeight: 844 }, 1);
    const startedAt = performance.now();
    const artifact = await fixtureValue.service.capture("preview-task", 1) as any;
    const elapsed = performance.now() - startedAt;
    expect(artifact.metadata.viewport).toEqual({ width: 390, height: 844 });
    expect(artifact.metadata.console.some((entry: any) => entry.text.includes("api_key=[REDACTED]"))).toBe(true);
    expect(artifact.metadata.network.some((entry: any) => entry.url === `http://127.0.0.1:${port}/data` && entry.status === 200)).toBe(true);
    expect(artifact.metadata.blockedOrigins).toContain("https://example.com");
    expect(artifact.metadata.accessibility.violations.some((entry: any) => entry.id === "html-has-lang")).toBe(true);
    const serialized = JSON.stringify(artifact);
    for (const secret of ["super-secret-value", "do-not-store", "local-secret", "external-secret", "url-secret"]) expect(serialized).not.toContain(secret);
    const file = fixtureValue.service.file(artifact.id);
    const png = fs.readFileSync(file.path);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(fs.statSync(file.path).mode & 0o777).toBe(0o600);
    expect(fixtureValue.service.list("preview-task")[0]).toMatchObject({ id: artifact.id, sha256: artifact.sha256, sizeBytes: png.length });
    const event = databaseEvent(fixtureValue.database, "preview-task");
    expect(event.type).toBe("workbench.preview_captured");
    expect(event.payload_json).toContain(artifact.sha256);
    expect(elapsed).toBeLessThan(10_000);
    fs.appendFileSync(file.path, "tamper");
    expect(() => fixtureValue.service.file(artifact.id)).toThrow(/무결성/);
    fixtureValue.database.close();
  }, 45_000);

  it("task ID를 경로로 쓰지 않고 task 중복·전체 동시 capture를 제한한 뒤 슬롯을 반환한다", async () => {
    let release: () => void = () => undefined;
    let entered = 0;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const app = http.createServer(async (_request, response) => {
      entered += 1;
      if (entered <= 2) await gate;
      response.writeHead(200, { "content-type": "text/html" }); response.end("<!doctype html><title>bounded</title>");
    });
    app.listen(0, "127.0.0.1"); await once(app, "listening"); servers.push(app);
    const port = (app.address() as AddressInfo).port;
    const fixtureValue = fixture(undefined);
    addTask(fixtureValue.database, fixtureValue.projectId, "../outside-task", 2);
    addTask(fixtureValue.database, fixtureValue.projectId, "third-task", 3);
    fixtureValue.service.setTarget(fixtureValue.projectId, { url: `http://127.0.0.1:${port}/`, viewportWidth: 320, viewportHeight: 240 }, 1);
    // 동시 실행 계약은 Chrome 시작 속도와 무관하다. capture 본체만 고정 PNG 저장으로 대체해
    // 슬롯 제한과 task ID 기반 경로 탈출 방지를 deterministic하게 검증한다.
    const serviceInternals = fixtureValue.service as any;
    serviceInternals.captureWithBrowser = async (taskId: string, userId: number) => {
      entered += 1;
      if (entered <= 2) await gate;
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      return serviceInternals.storeArtifact(taskId, "preview_screenshot", png, { test: true }, userId, "workbench.preview_captured");
    };

    const first = fixtureValue.service.capture("preview-task", 1);
    while (entered < 1) await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(fixtureValue.service.capture("preview-task", 1)).rejects.toMatchObject({ statusCode: 409 });
    const second = fixtureValue.service.capture("../outside-task", 1);
    while (entered < 2) await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(fixtureValue.service.capture("third-task", 1)).rejects.toMatchObject({ statusCode: 429 });
    release();
    const [, traversalArtifact] = await Promise.all([first, second]) as any[];
    const traversalFile = fixtureValue.service.file(traversalArtifact.id);
    expect(path.relative(path.join(fixtureValue.root, "workbench-artifacts"), traversalFile.path)).not.toContain("..");
    expect(traversalFile.filename).toBe(`preview-${traversalArtifact.id}.png`);

    const afterRelease = await fixtureValue.service.capture("third-task", 1);
    expect(afterRelease).toMatchObject({ taskId: "third-task" });
    fixtureValue.database.close();
  }, 10_000);

  it.skipIf(!browserExecutable())("동일 화면은 0 pixel diff이고 변경 화면·접근성 위반은 hash artifact로 남긴다", async () => {
    let changed = false;
    const app = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><html><head><title>Visual QA</title><style>body{margin:0;background:${changed ? "#ff0055" : "#0055ff"};color:white}main{height:240px}</style></head><body><main><button></button><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="><input value="secret-dom-value"></main></body></html>`);
    });
    app.listen(0, "127.0.0.1"); await once(app, "listening"); servers.push(app);
    const port = (app.address() as AddressInfo).port;
    const fixtureValue = fixture(browserExecutable());
    fixtureValue.service.setTarget(fixtureValue.projectId, { url: `http://127.0.0.1:${port}/`, viewportWidth: 320, viewportHeight: 240 }, 1);
    const baselineCapture = await fixtureValue.service.capture("preview-task", 1) as any;
    const baseline = fixtureValue.service.setVisualBaseline("preview-task", baselineCapture.id, 1) as any;
    expect(baseline.artifactId).toBe(baselineCapture.id);

    const identical = await fixtureValue.service.visualCheck("preview-task", 1) as any;
    expect(identical).toMatchObject({ comparable: true, changedPixels: 0, changedRatio: 0 });
    expect(identical.accessibility.violations.map((item: any) => item.id)).toEqual(expect.arrayContaining(["button-name", "html-has-lang", "image-alt"]));
    changed = true;
    const startedAt = performance.now();
    const regression = await fixtureValue.service.visualCheck("preview-task", 1) as any;
    expect(regression.comparable).toBe(true);
    expect(regression.changedPixels).toBeGreaterThan(50_000);
    expect(regression.changedRatio).toBeGreaterThan(0.5);
    expect(performance.now() - startedAt).toBeLessThan(10_000);
    const diffFile = fixtureValue.service.file(regression.diffArtifact.id);
    expect(fs.statSync(diffFile.path).mode & 0o777).toBe(0o600);
    expect(diffFile.filename).toBe(`visual-diff-${regression.diffArtifact.id}.png`);
    expect(PNG_SIGNATURE(fs.readFileSync(diffFile.path))).toBe(true);
    const serialized = JSON.stringify({ regression, events: fixtureValue.database.prepare("SELECT type, payload_json FROM agent_task_events WHERE task_id = ?").all("preview-task") });
    expect(serialized).not.toContain("secret-dom-value");
    expect(serialized).not.toContain("<button");
    expect(serialized).not.toContain("<img");
    fixtureValue.database.close();
  }, 60_000);
});

function PNG_SIGNATURE(buffer: Buffer): boolean {
  return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

function databaseEvent(database: ReturnType<typeof openDatabase>, taskId: string): { type: string; payload_json: string } {
  return database.prepare("SELECT type, payload_json FROM agent_task_events WHERE task_id = ? ORDER BY sequence DESC LIMIT 1").get(taskId) as { type: string; payload_json: string };
}
