import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import axeCore from "axe-core";
import pixelmatch from "pixelmatch";
import { chromium, type Browser, type Request } from "playwright-core";
import { PNG } from "pngjs";
import type { AppConfig } from "../core/config";
import type { AppDatabase } from "../core/database";
import { redactVerificationOutput } from "./verification-service";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_CONSOLE_EVENTS = 100;
const MAX_NETWORK_EVENTS = 300;
const MAX_ACTIVE_CAPTURES = 2;
const BROWSER_LAUNCH_TIMEOUT_MS = 30_000;

export interface PreviewTarget { projectId: number; url: string; viewportWidth: number; viewportHeight: number; updatedAt: string }
export interface PreviewCandidate { url: string; label: string; port: number }

function secureDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("preview artifact 경로가 안전한 일반 디렉터리가 아닙니다.");
  if ((stat.mode & 0o077) !== 0) fs.chmodSync(directory, 0o700);
}

function checkedUrl(value: unknown, protocols = ["http:", "https:"]): URL {
  if (typeof value !== "string" || value.length > 2_000) throw new Error("preview URL이 올바르지 않습니다.");
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("preview URL이 올바르지 않습니다."); }
  if (!protocols.includes(parsed.protocol) || !LOOPBACK_HOSTS.has(parsed.hostname) || parsed.username || parsed.password) {
    throw new Error("preview는 credential 없는 loopback HTTP(S) URL만 허용합니다.");
  }
  return parsed;
}

function safeNetworkUrl(value: string): string {
  try { const parsed = new URL(value); return `${parsed.origin}${parsed.pathname}`.slice(0, 1_000); }
  catch { return "invalid-url"; }
}

function safeConsoleText(value: string, homeDir: string): string {
  const withoutQueries = value.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => safeNetworkUrl(url));
  return redactVerificationOutput(withoutQueries, homeDir).text.slice(0, 500);
}

function sha256(value: Buffer): string { return crypto.createHash("sha256").update(value).digest("hex"); }

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function listeningSocketPorts(procRoot: string): Map<string, number> {
  const sockets = new Map<string, number>();
  for (const table of ["net/tcp", "net/tcp6"]) {
    let content = "";
    try { content = fs.readFileSync(path.join(procRoot, table), "utf8"); } catch { continue; }
    for (const line of content.split("\n").slice(1)) {
      const columns = line.trim().split(/\s+/);
      if (columns.length < 10 || columns[3] !== "0A") continue;
      const portHex = columns[1]?.split(":").at(-1) ?? "";
      const port = Number.parseInt(portHex, 16);
      if (Number.isInteger(port) && port > 0 && port <= 65_535) sockets.set(columns[9], port);
    }
  }
  return sockets;
}

interface ArtifactRow { id: string; task_id: string; kind: string; path: string; sha256: string; size_bytes: number; metadata_json: string; created_at: string }

export class LivePreviewService {
  private readonly artifactRoot: string;
  private readonly capturingTasks = new Set<string>();
  private activeCaptures = 0;

  constructor(private readonly database: AppDatabase, private readonly config: AppConfig) {
    this.artifactRoot = path.join(config.dataDir, "workbench-artifacts");
    secureDirectory(this.artifactRoot);
  }

  target(projectId: number): PreviewTarget | null {
    const row = this.database.prepare("SELECT project_id, url, viewport_width, viewport_height, updated_at FROM project_preview_targets WHERE project_id = ?").get(projectId) as {
      project_id: number; url: string; viewport_width: number; viewport_height: number; updated_at: string;
    } | undefined;
    return row ? { projectId: row.project_id, url: row.url, viewportWidth: row.viewport_width, viewportHeight: row.viewport_height, updatedAt: row.updated_at } : null;
  }

  // 프로젝트 또는 연결된 worktree 아래에서 실행 중인 프로세스가 실제로 열고 있는 HTTP port만
  // 후보로 돌려준다. 전체 host port를 무차별 노출하거나 임의 주소를 probe하지 않는다.
  async discoverTargets(projectId: number, procRoot = "/proc"): Promise<PreviewCandidate[]> {
    const project = this.database.prepare("SELECT path FROM projects WHERE id = ?").get(projectId) as { path: string } | undefined;
    if (!project) throw new Error("프로젝트를 찾을 수 없습니다.");
    const roots = [project.path, ...(this.database.prepare("SELECT worktree_path FROM chats WHERE project_id=? AND worktree_path IS NOT NULL")
      .all(projectId) as Array<{ worktree_path: string }>).map((row) => row.worktree_path)].map((root) => path.resolve(root));
    const socketPorts = listeningSocketPorts(procRoot);
    const found = new Map<number, string>();
    let processEntries: string[] = [];
    try { processEntries = fs.readdirSync(procRoot).filter((entry) => /^\d+$/.test(entry)).slice(0, 20_000); } catch { return []; }
    for (const pid of processEntries) {
      let cwd = "";
      try { cwd = fs.readlinkSync(path.join(procRoot, pid, "cwd")); } catch { continue; }
      if (!roots.some((root) => isInside(root, cwd))) continue;
      let label = "개발 서버";
      try { label = fs.readFileSync(path.join(procRoot, pid, "comm"), "utf8").trim().slice(0, 40) || label; } catch { /* 기본 표시 사용 */ }
      let descriptors: string[] = [];
      try { descriptors = fs.readdirSync(path.join(procRoot, pid, "fd")).slice(0, 4_096); } catch { continue; }
      for (const descriptor of descriptors) {
        let link = "";
        try { link = fs.readlinkSync(path.join(procRoot, pid, "fd", descriptor)); } catch { continue; }
        const inode = link.match(/^socket:\[(\d+)]$/)?.[1];
        const port = inode ? socketPorts.get(inode) : undefined;
        if (port && port !== this.config.port && !found.has(port)) found.set(port, label);
      }
    }
    const ports = [...found].sort(([left], [right]) => left - right).slice(0, 32);
    const reachable = await Promise.all(ports.map(async ([port, label]) => await this.probeHttp(port)
      ? { url: `http://127.0.0.1:${port}/`, label: `${label} · ${port}`, port } : null));
    return reachable.filter((candidate): candidate is PreviewCandidate => candidate !== null);
  }

  private probeHttp(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const request = http.request({ hostname: "127.0.0.1", port, path: "/", method: "HEAD", timeout: 750 }, (response) => {
        response.resume(); resolve(true);
      });
      request.once("timeout", () => { request.destroy(); resolve(false); });
      request.once("error", () => resolve(false));
      request.end();
    });
  }

  setTarget(projectId: number, input: { url?: unknown; viewportWidth?: unknown; viewportHeight?: unknown }, userId: number): PreviewTarget {
    if (!this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) throw new Error("프로젝트를 찾을 수 없습니다.");
    const parsedUrl = checkedUrl(input.url);
    // target 설정·task board·감사 로그에 query/fragment의 임시 token이 남지 않게 origin+path만 보존한다.
    parsedUrl.search = "";
    parsedUrl.hash = "";
    const url = parsedUrl.toString();
    const width = Number(input.viewportWidth);
    const height = Number(input.viewportHeight);
    if (!Number.isInteger(width) || width < 320 || width > 1920 || !Number.isInteger(height) || height < 240 || height > 1080) {
      throw new Error("viewport는 320~1920 × 240~1080 범위여야 합니다.");
    }
    this.database.prepare(`INSERT INTO project_preview_targets(project_id, url, viewport_width, viewport_height, updated_by)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET url = excluded.url, viewport_width = excluded.viewport_width,
      viewport_height = excluded.viewport_height, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`)
      .run(projectId, url, width, height, userId);
    return this.target(projectId)!;
  }

  private appendTaskEvent(taskId: string, idempotencyKey: string, type: string, payload: Record<string, unknown>): void {
    const sequence = (this.database.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM agent_task_events WHERE task_id = ?").get(taskId) as { value: number }).value;
    this.database.prepare("INSERT INTO agent_task_events(id, task_id, sequence, idempotency_key, type, payload_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), taskId, sequence, idempotencyKey, type, JSON.stringify(payload));
  }

  private async launchBrowser(): Promise<Browser> {
    let executablePath = this.config.previewBrowserExecutable;
    if (executablePath) {
      executablePath = fs.realpathSync(executablePath);
      const stat = fs.statSync(executablePath);
      if (!stat.isFile() || (stat.mode & 0o022) !== 0) throw new Error("preview browser 최종 실행 파일은 다른 사용자가 쓸 수 없는 일반 파일이어야 합니다.");
    }
    try {
      return await chromium.launch({ executablePath, channel: executablePath ? undefined : "chrome", headless: true, timeout: BROWSER_LAUNCH_TIMEOUT_MS,
        args: typeof process.getuid === "function" && process.getuid() === 0 ? ["--no-sandbox"] : [] });
    } catch (error) {
      throw Object.assign(new Error(`preview browser를 시작할 수 없습니다: ${error instanceof Error ? error.message : String(error)}`), { statusCode: 409 });
    }
  }

  async capture(taskId: string, userId: number): Promise<Record<string, unknown>> {
    const task = this.database.prepare("SELECT id, project_id FROM agent_tasks WHERE id = ?").get(taskId) as { id: string; project_id: number } | undefined;
    if (!task) throw new Error("작업을 찾을 수 없습니다.");
    const target = this.target(task.project_id);
    if (!target) throw Object.assign(new Error("프로젝트 preview target이 설정되지 않았습니다."), { statusCode: 409 });
    checkedUrl(target.url);
    if (this.capturingTasks.has(taskId)) throw Object.assign(new Error("이 작업의 preview capture가 이미 진행 중입니다."), { statusCode: 409 });
    if (this.activeCaptures >= MAX_ACTIVE_CAPTURES) throw Object.assign(new Error("preview capture 동시 실행 상한에 도달했습니다."), { statusCode: 429 });
    this.capturingTasks.add(taskId);
    this.activeCaptures += 1;
    try { return await this.captureWithBrowser(taskId, userId, task, target); }
    finally { this.capturingTasks.delete(taskId); this.activeCaptures -= 1; }
  }

  private async captureWithBrowser(taskId: string, userId: number, task: { id: string; project_id: number }, target: PreviewTarget): Promise<Record<string, unknown>> {
    const browser = await this.launchBrowser();
    const startedAt = performance.now();
    const consoleEvents: Array<{ level: string; text: string }> = [];
    const networkEvents: Array<Record<string, unknown>> = [];
    const blockedOrigins = new Set<string>();
    const requestStarted = new Map<Request, number>();
    let screenshot: Buffer;
    let accessibility: Record<string, unknown> = { violations: [], violationCount: 0, ruleCount: 0, passes: 0, incomplete: 0 };
    try {
      const context = await browser.newContext({ viewport: { width: target.viewportWidth, height: target.viewportHeight }, serviceWorkers: "block", ignoreHTTPSErrors: true });
      await context.addInitScript({ content: axeCore.source });
      const page = await context.newPage();
      await page.route("**/*", async (route) => {
        const requestUrl = route.request().url();
        if (requestUrl.startsWith("data:") || requestUrl.startsWith("blob:")) return route.continue();
        try { checkedUrl(requestUrl); return route.continue(); }
        catch { try { blockedOrigins.add(new URL(requestUrl).origin); } catch { blockedOrigins.add("invalid-url"); } return route.abort("blockedbyclient"); }
      });
      await page.routeWebSocket("**/*", (route) => {
        try { checkedUrl(route.url(), ["ws:", "wss:"]); route.connectToServer(); }
        catch { try { blockedOrigins.add(new URL(route.url()).origin); } catch { blockedOrigins.add("invalid-url"); } route.close(); }
      });
      page.on("console", (message) => {
        if (consoleEvents.length >= MAX_CONSOLE_EVENTS) return;
        consoleEvents.push({ level: message.type(), text: safeConsoleText(message.text().slice(0, 2_000), this.config.homeDir) });
      });
      page.on("request", (request) => requestStarted.set(request, performance.now()));
      page.on("response", (response) => {
        if (networkEvents.length >= MAX_NETWORK_EVENTS) return;
        const request = response.request();
        networkEvents.push({ url: safeNetworkUrl(request.url()), method: request.method(), resourceType: request.resourceType(), status: response.status(), durationMs: Math.round(performance.now() - (requestStarted.get(request) ?? performance.now())) });
        requestStarted.delete(request);
      });
      page.on("requestfailed", (request) => {
        if (networkEvents.length >= MAX_NETWORK_EVENTS) return;
        networkEvents.push({ url: safeNetworkUrl(request.url()), method: request.method(), resourceType: request.resourceType(), status: null, failure: request.failure()?.errorText?.slice(0, 100) ?? "failed" });
        requestStarted.delete(request);
      });
      await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 15_000 });
      await page.waitForTimeout(300);
      screenshot = await page.screenshot({ type: "png", fullPage: false });
      const axeResult = await page.evaluate(async () => {
        const runner = (globalThis as unknown as { axe: { run: (document: Document) => Promise<any> } }).axe;
        return runner.run(document);
      });
      const violations = (axeResult.violations as any[]).slice(0, 100).map((violation) => ({
        id: String(violation.id).slice(0, 100), impact: violation.impact ? String(violation.impact).slice(0, 20) : null,
        help: safeConsoleText(String(violation.help ?? ""), this.config.homeDir),
        targets: (violation.nodes as any[]).slice(0, 5).flatMap((node) => (node.target as unknown[]).slice(0, 3).map((selector) => safeConsoleText(String(selector), this.config.homeDir))).slice(0, 15),
        nodeCount: Array.isArray(violation.nodes) ? violation.nodes.length : 0,
      }));
      accessibility = { violations, violationCount: violations.reduce((sum, item) => sum + item.nodeCount, 0),
        ruleCount: violations.length, passes: axeResult.passes?.length ?? 0, incomplete: axeResult.incomplete?.length ?? 0 };
      await context.close();
    } finally { await browser.close(); }
    const metadata = { targetUrl: safeNetworkUrl(target.url), viewport: { width: target.viewportWidth, height: target.viewportHeight }, console: consoleEvents,
      network: networkEvents, blockedOrigins: [...blockedOrigins].sort(), accessibility, elapsedMs: Math.round(performance.now() - startedAt) };
    return this.storeArtifact(taskId, "preview_screenshot", screenshot, metadata, userId, "workbench.preview_captured");
  }

  private storeArtifact(taskId: string, kind: "preview_screenshot" | "visual_diff", content: Buffer, metadata: Record<string, unknown>, userId: number, eventType: string): Record<string, unknown> {
    const artifactId = crypto.randomUUID();
    const taskRoot = path.join(this.artifactRoot, sha256(Buffer.from(taskId)));
    secureDirectory(taskRoot);
    const file = path.join(taskRoot, `${artifactId}.png`);
    fs.writeFileSync(file, content, { flag: "wx", mode: 0o600 });
    const digest = sha256(content);
    try {
      this.database.transaction(() => {
        this.database.prepare(`INSERT INTO task_workbench_artifacts(id, task_id, kind, path, sha256, size_bytes, metadata_json, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(artifactId, taskId, kind, file, digest, content.length, JSON.stringify(metadata), userId);
        this.appendTaskEvent(taskId, `${eventType}:${artifactId}`, eventType, { artifactId, kind, sha256: digest, sizeBytes: content.length, ...metadata });
      })();
    } catch (error) {
      try { fs.unlinkSync(file); } catch { /* 정확한 새 artifact만 best-effort 정리한다. */ }
      throw error;
    }
    return { id: artifactId, taskId, kind, sha256: digest, sizeBytes: content.length, metadata, createdAt: new Date().toISOString() };
  }

  setVisualBaseline(taskId: string, artifactId: string, userId: number): Record<string, unknown> {
    const row = this.artifactRow(artifactId);
    if (row.task_id !== taskId || row.kind !== "preview_screenshot") throw new Error("같은 task의 preview screenshot만 기준선으로 지정할 수 있습니다.");
    this.checkedArtifactBuffer(row);
    this.database.transaction(() => {
      this.database.prepare(`INSERT INTO task_visual_baselines(task_id, artifact_id, set_by) VALUES (?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET artifact_id = excluded.artifact_id, set_by = excluded.set_by, updated_at = CURRENT_TIMESTAMP`).run(taskId, artifactId, userId);
      const key = crypto.randomUUID();
      this.appendTaskEvent(taskId, `visual-baseline:${key}`, "workbench.visual_baseline_set", { artifactId, sha256: row.sha256 });
    })();
    return { taskId, artifactId, sha256: row.sha256, metadata: JSON.parse(row.metadata_json) };
  }

  visualBaseline(taskId: string): Record<string, unknown> | null {
    const row = this.database.prepare(`SELECT a.* FROM task_visual_baselines b JOIN task_workbench_artifacts a ON a.id = b.artifact_id WHERE b.task_id = ?`).get(taskId) as ArtifactRow | undefined;
    return row ? { taskId, artifactId: row.id, sha256: row.sha256, metadata: JSON.parse(row.metadata_json) } : null;
  }

  async visualCheck(taskId: string, userId: number): Promise<Record<string, unknown>> {
    const baseline = this.database.prepare(`SELECT a.* FROM task_visual_baselines b JOIN task_workbench_artifacts a ON a.id = b.artifact_id WHERE b.task_id = ?`).get(taskId) as ArtifactRow | undefined;
    if (!baseline) throw Object.assign(new Error("먼저 preview screenshot 기준선을 지정해주세요."), { statusCode: 409 });
    const current = await this.capture(taskId, userId) as any;
    const currentRow = this.artifactRow(String(current.id));
    const before = PNG.sync.read(this.checkedArtifactBuffer(baseline));
    const after = PNG.sync.read(this.checkedArtifactBuffer(currentRow));
    if (before.width !== after.width || before.height !== after.height) {
      const key = crypto.randomUUID();
      const result = { comparable: false, reason: "viewport_size_mismatch", baselineArtifactId: baseline.id, currentArtifactId: current.id,
        baselineSize: { width: before.width, height: before.height }, currentSize: { width: after.width, height: after.height }, accessibility: current.metadata.accessibility };
      this.appendTaskEvent(taskId, `visual-check:${key}`, "workbench.visual_regression_checked", result);
      return result;
    }
    const output = new PNG({ width: before.width, height: before.height });
    const changedPixels = pixelmatch(before.data, after.data, output.data, before.width, before.height, { threshold: 0.1, includeAA: false, alpha: 0.5 });
    const totalPixels = before.width * before.height;
    const metadata = { comparable: true, baselineArtifactId: baseline.id, currentArtifactId: current.id, viewport: { width: before.width, height: before.height },
      changedPixels, totalPixels, changedRatio: totalPixels ? changedPixels / totalPixels : 0, accessibility: current.metadata.accessibility };
    const artifact = this.storeArtifact(taskId, "visual_diff", PNG.sync.write(output), metadata, userId, "workbench.visual_regression_checked");
    return { ...metadata, current, diffArtifact: artifact };
  }

  list(taskId: string): Array<Record<string, unknown>> {
    return (this.database.prepare(`SELECT id, task_id, kind, sha256, size_bytes, metadata_json, created_at FROM task_workbench_artifacts
      WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50`).all(taskId) as Array<Record<string, unknown>>)
      .map((row) => ({ id: row.id, taskId: row.task_id, kind: row.kind, sha256: row.sha256, sizeBytes: row.size_bytes, metadata: JSON.parse(String(row.metadata_json)), createdAt: row.created_at }));
  }

  file(artifactId: string): { path: string; filename: string } {
    const row = this.artifactRow(artifactId);
    this.checkedArtifactBuffer(row);
    return { path: path.resolve(row.path), filename: row.kind === "visual_diff" ? `visual-diff-${artifactId}.png` : `preview-${artifactId}.png` };
  }

  private artifactRow(artifactId: string): ArtifactRow {
    const row = this.database.prepare("SELECT * FROM task_workbench_artifacts WHERE id = ?").get(artifactId) as ArtifactRow | undefined;
    if (!row) throw new Error("workbench artifact를 찾을 수 없습니다.");
    return row;
  }

  private checkedArtifactBuffer(row: ArtifactRow): Buffer {
    const resolved = path.resolve(row.path);
    if (!resolved.startsWith(`${path.resolve(this.artifactRoot)}${path.sep}`)) throw Object.assign(new Error("preview artifact 경로가 안전하지 않습니다."), { statusCode: 409 });
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Object.assign(new Error("preview artifact 무결성이 일치하지 않습니다."), { statusCode: 409 });
    const content = fs.readFileSync(resolved);
    if (sha256(content) !== row.sha256) throw Object.assign(new Error("preview artifact 무결성이 일치하지 않습니다."), { statusCode: 409 });
    return content;
  }
}
