import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import type { FederationService } from "./federation";
import { TarArchive } from "archiver";
import type { AppConfig } from "../core/config";
import { assertAllowedPath } from "../core/security";
import { findExecutable } from "./agent-integration";

// 복사하지 않고 대상 컴퓨터에서 다시 만드는 실행 환경. 복사한 node_modules의 네이티브 모듈·venv의 절대경로
// 인터프리터는 다른 컴퓨터에서 깨지므로 lockfile 기준으로 새로 설치한다.
export interface EnvironmentStep {
  kind: "node" | "python";
  // 프로젝트 기준 POSIX 상대 경로. ""는 프로젝트 루트.
  dir: string;
  venvName?: string;
  pythonVersion?: string;
}

export interface TransferPlan {
  name: string;
  destinationPath?: string;
  sourcePath: string;
  steps: EnvironmentStep[];
}

export interface ProjectScan {
  entries: string[];
  steps: EnvironmentStep[];
  fileCount: number;
  bytes: number;
  warnings: string[];
}

type StepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";
export interface TransferJobStep { label: string; command: string; status: StepStatus; output: string }
export interface TransferJob {
  id: string;
  projectId: number;
  projectPath: string;
  status: "running" | "succeeded" | "failed";
  createdAt: string;
  finishedAt?: string;
  steps: TransferJobStep[];
}

const SKIPPED_DIRS = new Set(["node_modules", "__pycache__"]);
const OUTPUT_TAIL = 6000;
const STEP_TIMEOUT_MS = 30 * 60_000;
export const CHUNK_BYTES = 16 * 1024 * 1024;
const MAX_CHUNK_BYTES = 32 * 1024 * 1024;

interface UploadState { plan: TransferPlan; destination: string; file: string; nextIndex: number; bytes: number; createdAt: number; busy: boolean }

function toPosix(relative: string): string {
  return relative.split(path.sep).join("/");
}

// 폴더를 걸어가며 복사할 항목과 대상에서 다시 만들 환경 목록을 만든다. symlink는 따라가지 않고 그대로 옮긴다.
export function scanProject(root: string): ProjectScan {
  const entries: string[] = [];
  const nodeDirs: string[] = [];
  const steps: EnvironmentStep[] = [];
  const warnings: string[] = [];
  let bytes = 0;
  let fileCount = 0;
  const walk = (relative: string): void => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(root, child);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") {
          if (fs.existsSync(path.join(root, relative, "package.json"))) nodeDirs.push(relative);
          continue;
        }
        if (SKIPPED_DIRS.has(entry.name)) continue;
        const venvConfig = path.join(absolute, "pyvenv.cfg");
        if (fs.existsSync(venvConfig)) {
          const version = fs.readFileSync(venvConfig, "utf8").match(/^\s*version(?:_info)?\s*=\s*(\d+\.\d+)/m)?.[1];
          steps.push({ kind: "python", dir: relative, venvName: entry.name, ...(version ? { pythonVersion: version } : {}) });
          continue;
        }
        entries.push(child);
        walk(child);
      } else if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(absolute);
        const resolved = path.resolve(path.dirname(absolute), target);
        if (path.isAbsolute(target) || path.relative(root, resolved).startsWith("..")) warnings.push(`${child} → ${target} (프로젝트 밖을 가리키는 링크라 대상에서 깨질 수 있음)`);
        entries.push(child);
      } else if (entry.isFile()) {
        bytes += fs.statSync(absolute).size;
        fileCount += 1;
        entries.push(child);
      }
    }
  };
  walk("");
  // 워크스페이스 하위 패키지는 루트 설치가 채우므로, 자체 lockfile이 없는 하위 node_modules는 따로 설치하지 않는다.
  for (const dir of nodeDirs.sort((a, b) => a.length - b.length)) {
    const nested = nodeDirs.some((other) => other !== dir && (other === "" || dir.startsWith(`${other}/`)));
    if (nested && !nodeInstallCommand(path.join(root, dir)).lockfile) continue;
    steps.push({ kind: "node", dir });
  }
  return { entries, steps: steps.sort((a, b) => a.dir.localeCompare(b.dir)), fileCount, bytes, warnings };
}

// 스캔 결과대로 tar.gz 스트림을 만든다. 권한·symlink는 archiver가 lstat 기준으로 담는다.
export function createProjectArchive(root: string, entries: string[]): Readable {
  const archive = new TarArchive({ gzip: true, gzipOptions: { level: 6 } });
  for (const entry of entries) archive.file(path.join(root, entry), { name: entry });
  void archive.finalize();
  return archive;
}

// lockfile을 우선해 설치 명령을 고른다. lockfile을 무시하는 옵션은 쓰지 않는다.
function nodeInstallCommand(dir: string): { command: string; args: string[]; lockfile: boolean } {
  const has = (file: string) => fs.existsSync(path.join(dir, file));
  if (has("pnpm-lock.yaml")) return { command: "pnpm", args: ["install", "--frozen-lockfile"], lockfile: true };
  if (has("yarn.lock")) return { command: "yarn", args: has(".yarnrc.yml") ? ["install", "--immutable"] : ["install", "--frozen-lockfile"], lockfile: true };
  if (has("bun.lock") || has("bun.lockb")) return { command: "bun", args: ["install", "--frozen-lockfile"], lockfile: true };
  if (has("package-lock.json") || has("npm-shrinkwrap.json")) return { command: "npm", args: ["ci"], lockfile: true };
  return { command: "npm", args: ["install"], lockfile: false };
}


function assertPlan(value: unknown): TransferPlan {
  const plan = value as TransferPlan;
  const bad = (message: string) => Object.assign(new Error(message), { statusCode: 400 });
  if (!plan || typeof plan.name !== "string" || !plan.name.trim() || plan.name.length > 120 || typeof plan.sourcePath !== "string" || !Array.isArray(plan.steps) || plan.steps.length > 200) throw bad("이전 계획 형식이 올바르지 않습니다.");
  if (plan.destinationPath !== undefined && (typeof plan.destinationPath !== "string" || !path.isAbsolute(plan.destinationPath))) throw bad("대상 경로는 절대 경로여야 합니다.");
  for (const step of plan.steps) {
    const dirOk = typeof step?.dir === "string" && (step.dir === "" || (path.posix.normalize(step.dir) === step.dir && !step.dir.startsWith("/") && !step.dir.split("/").includes("..")));
    if (!dirOk || !["node", "python"].includes(step.kind)) throw bad("환경 재구성 단계 형식이 올바르지 않습니다.");
    if (step.kind === "python" && (typeof step.venvName !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(step.venvName) || step.venvName.startsWith(".."))) throw bad("가상환경 이름이 올바르지 않습니다.");
    if (step.pythonVersion !== undefined && !/^\d+\.\d+$/.test(step.pythonVersion)) throw bad("Python 버전 형식이 올바르지 않습니다.");
  }
  return plan;
}

// 서브 쪽: 받은 압축을 풀어 프로젝트로 등록하고, 빠진 실행 환경을 백그라운드로 다시 만든다.
export class ProjectTransferReceiver {
  private readonly jobs = new Map<string, TransferJob>();
  private readonly uploads = new Map<string, UploadState>();
  private readonly jobDir: string;
  private readonly uploadDir: string;

  constructor(private readonly config: AppConfig, private readonly register: (projectPath: string, name: string) => Promise<{ id: number; path: string }>) {
    this.jobDir = path.join(config.dataDir, "project-transfers");
    this.uploadDir = path.join(this.jobDir, "uploads");
  }

  // 대상 경로를 정한다. 지정하지 않으면 프로젝트 폴더/이름이며, 이미 있으면 덮어쓰지 않는다.
  resolveDestination(plan: TransferPlan): string {
    if (plan.destinationPath !== undefined && !path.isAbsolute(plan.destinationPath)) throw Object.assign(new Error("대상 경로는 절대 경로여야 합니다."), { statusCode: 400 });
    const root = this.config.projectsDir ?? path.join(this.config.homeDir, "Projects");
    const safeName = plan.name.trim().replace(/[^A-Za-z0-9가-힣._-]+/g, "-").replace(/^[.-]+/, "") || "project";
    const destination = path.resolve(plan.destinationPath ?? path.join(root, safeName));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    assertAllowedPath(path.dirname(destination), this.config.allowedRoots);
    if (fs.existsSync(destination)) throw Object.assign(new Error(`대상 경로가 이미 있습니다: ${destination}`), { statusCode: 409 });
    return destination;
  }

  // 분할 업로드를 시작한다. 계획과 대상 경로를 먼저 검증해, 큰 본문을 받은 뒤에야 거부하는 일이 없게 한다.
  startUpload(input: unknown): { uploadId: string; destination: string } {
    this.cleanupStaleUploads();
    const plan = assertPlan(input);
    const destination = this.resolveDestination(plan);
    const id = crypto.randomUUID();
    fs.mkdirSync(this.uploadDir, { recursive: true, mode: 0o700 });
    const file = path.join(this.uploadDir, `${id}.tar.gz`);
    fs.writeFileSync(file, "", { mode: 0o600 });
    this.uploads.set(id, { plan, destination, file, nextIndex: 0, bytes: 0, createdAt: Date.now(), busy: false });
    return { uploadId: id, destination };
  }

  private upload(id: string): UploadState {
    const upload = /^[0-9a-f-]{36}$/.test(id) ? this.uploads.get(id) : undefined;
    if (!upload) throw Object.assign(new Error("업로드를 찾을 수 없습니다. 처음부터 다시 보내세요."), { statusCode: 404 });
    return upload;
  }

  // 조각을 순서대로 이어 붙인다. 조각 하나가 서버의 요청 수신 제한(기본 5분) 안에 끝나도록 크기를 제한한다.
  async appendChunk(id: string, index: number, body: Readable): Promise<{ bytes: number }> {
    const upload = this.upload(id);
    if (upload.busy) throw Object.assign(new Error("다른 조각을 받는 중입니다."), { statusCode: 409 });
    if (index !== upload.nextIndex) {
      // 순서가 어긋나면 이어 붙인 압축이 깨지므로 업로드를 버리고 처음부터 다시 보내게 한다.
      this.abortUpload(id);
      throw Object.assign(new Error(`조각 순서가 맞지 않습니다(기대 ${upload.nextIndex}, 받음 ${index}). 처음부터 다시 보내세요.`), { statusCode: 409 });
    }
    upload.busy = true;
    try {
      let size = 0;
      await new Promise<void>((resolve, reject) => {
        const out = fs.createWriteStream(upload.file, { flags: "a" });
        body.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_CHUNK_BYTES) body.destroy(Object.assign(new Error("조각이 너무 큽니다."), { statusCode: 413 }));
        });
        body.on("error", (error) => { out.destroy(); reject(error); });
        out.on("error", reject);
        out.on("finish", resolve);
        body.pipe(out);
      });
      upload.nextIndex += 1;
      upload.bytes += size;
      return { bytes: upload.bytes };
    } catch (error) {
      // 반쯤 쓴 조각이 남으면 이어 붙일 수 없으므로 업로드 전체를 버린다.
      this.abortUpload(id);
      throw error;
    } finally { upload.busy = false; }
  }

  abortUpload(id: string): void {
    const upload = this.uploads.get(id);
    if (!upload) return;
    this.uploads.delete(id);
    fs.rmSync(upload.file, { force: true });
  }

  // 하루 넘게 끝나지 않은 업로드 파일을 정리한다.
  private cleanupStaleUploads(): void {
    for (const [id, upload] of this.uploads) if (Date.now() - upload.createdAt > 24 * 60 * 60_000) this.abortUpload(id);
  }

  // 받은 압축을 풀어 프로젝트로 등록하고, 빠진 실행 환경을 백그라운드로 다시 만든다.
  async completeUpload(id: string): Promise<TransferJob> {
    const upload = this.upload(id);
    if (upload.busy) throw Object.assign(new Error("조각을 받는 중입니다."), { statusCode: 409 });
    upload.busy = true;
    const { plan, destination } = upload;
    // 같은 부모 폴더의 임시 폴더에 풀고 rename해, 도중 실패로 반쯤 풀린 프로젝트가 등록되지 않게 한다.
    const staging = `${destination}.wam-transfer-${crypto.randomUUID().slice(0, 8)}`;
    try {
      if (fs.existsSync(destination)) throw Object.assign(new Error(`대상 경로가 이미 있습니다: ${destination}`), { statusCode: 409 });
      fs.mkdirSync(staging, { mode: 0o755 });
      await new Promise<void>((resolve, reject) => {
        const tar = spawn("tar", ["-xzf", upload.file, "-C", staging, "--no-same-owner"], { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        tar.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
        tar.on("error", reject);
        tar.on("close", (code) => code === 0 ? resolve() : reject(new Error(`압축 해제에 실패했습니다: ${stderr.trim() || code}`)));
      });
      fs.renameSync(staging, destination);
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      this.abortUpload(id);
      throw error;
    }
    this.abortUpload(id);
    const project = await this.register(destination, plan.name.trim());
    const job: TransferJob = { id: crypto.randomUUID(), projectId: project.id, projectPath: project.path, status: "running", createdAt: new Date().toISOString(), steps: [] };
    const tasks = this.buildTasks(project.path, plan.steps);
    job.steps = tasks.map((task) => ({ label: task.label, command: task.display, status: "pending", output: "" }));
    this.save(job);
    void this.run(job, tasks);
    return job;
  }

  private buildTasks(root: string, steps: EnvironmentStep[]): Array<{ label: string; display: string; cwd: string; commands: Array<{ command: string; args: string[]; env?: Record<string, string> }>; note?: string }> {
    const tasks: ReturnType<ProjectTransferReceiver["buildTasks"]> = [];
    // 채팅 전용 worktree는 원래 컴퓨터의 WAM 데이터 폴더에 있어 복사된 .git에는 없는 경로 기록만 남는다.
    if (fs.existsSync(path.join(root, ".git"))) tasks.push({ label: "Git worktree 기록 정리", display: "git worktree prune", cwd: root, commands: [{ command: "git", args: ["worktree", "prune"] }] });
    const hasUv = Boolean(findExecutable("uv") ?? undefined);
    for (const step of steps) {
      const cwd = path.join(root, ...step.dir.split("/").filter(Boolean));
      const where = step.dir || "루트";
      if (step.kind === "node") {
        const install = nodeInstallCommand(cwd);
        tasks.push({ label: `Node 의존성 설치 (${where})`, display: `${install.command} ${install.args.join(" ")}`, cwd, commands: [install], ...(install.lockfile ? {} : { note: "lockfile이 없어 npm install로 설치했습니다. 원래 컴퓨터와 버전이 다를 수 있습니다." }) });
        continue;
      }
      const venv = step.venvName!;
      const versionArgs = step.pythonVersion ? ["--python", step.pythonVersion] : [];
      if (fs.existsSync(path.join(cwd, "uv.lock"))) {
        tasks.push({ label: `Python 환경 재구성 (${where}/${venv})`, display: "uv sync --locked", cwd, commands: [{ command: "uv", args: ["sync", "--locked", ...versionArgs], env: venv === ".venv" ? {} : { UV_PROJECT_ENVIRONMENT: venv } }] });
      } else {
        const requirements = fs.existsSync(path.join(cwd, "requirements.txt"));
        const python = path.join(venv, "bin", "python");
        const commands = hasUv
          ? [{ command: "uv", args: ["venv", venv, ...versionArgs] }, ...(requirements ? [{ command: "uv", args: ["pip", "install", "-r", "requirements.txt", "--python", python] }] : [])]
          : [{ command: "python3", args: ["-m", "venv", venv] }, ...(requirements ? [{ command: python, args: ["-m", "pip", "install", "-r", "requirements.txt"] }] : [])];
        tasks.push({
          label: `Python 가상환경 재구성 (${where}/${venv})`, display: commands.map((item) => `${item.command} ${item.args.join(" ")}`).join(" && "), cwd, commands,
          ...(requirements ? {} : { note: "requirements.txt·uv.lock이 없어 빈 가상환경만 만들었습니다. 패키지는 직접 설치하세요." }),
        });
      }
    }
    return tasks;
  }

  private async run(job: TransferJob, tasks: ReturnType<ProjectTransferReceiver["buildTasks"]>): Promise<void> {
    // WAM 자체 비밀 환경변수는 프로젝트 설치 스크립트에 넘기지 않는다. CI=1은 pnpm 등의 대화형 확인을 막는다.
    const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("WEB_AGENT_MANAGER_"))) as Record<string, string>;
    for (const [index, task] of tasks.entries()) {
      const step = job.steps[index];
      step.status = "running";
      this.save(job);
      try {
        for (const item of task.commands) {
          const executable = path.isAbsolute(item.command) || item.command.includes("/") ? path.resolve(task.cwd, item.command) : findExecutable(item.command) ?? undefined;
          if (!executable) throw new Error(`대상 컴퓨터에 ${item.command}이(가) 설치되어 있지 않습니다. 설치 후 프로젝트 폴더에서 '${task.display}'를 실행하세요.`);
          step.output = (step.output + `$ ${item.command} ${item.args.join(" ")}\n`).slice(-OUTPUT_TAIL);
          await new Promise<void>((resolve, reject) => {
            const child = spawn(executable, item.args, { cwd: task.cwd, env: { ...baseEnv, CI: "1", ...item.env }, stdio: ["ignore", "pipe", "pipe"] });
            const timer = setTimeout(() => child.kill("SIGTERM"), STEP_TIMEOUT_MS);
            const append = (chunk: Buffer) => { step.output = (step.output + chunk.toString()).slice(-OUTPUT_TAIL); };
            child.stdout.on("data", append);
            child.stderr.on("data", append);
            child.on("error", (error) => { clearTimeout(timer); reject(error); });
            child.on("close", (code, signal) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(signal ? `시간 초과 또는 중단(${signal})` : `종료 코드 ${code}`)); });
          });
        }
        step.status = "succeeded";
        if (task.note) step.output = (step.output + `\n※ ${task.note}\n`).slice(-OUTPUT_TAIL);
      } catch (error) {
        step.status = "failed";
        step.output = (step.output + `\n✗ ${error instanceof Error ? error.message : String(error)}\n`).slice(-OUTPUT_TAIL);
      }
      this.save(job);
    }
    job.status = job.steps.some((step) => step.status === "failed") ? "failed" : "succeeded";
    job.finishedAt = new Date().toISOString();
    this.save(job);
  }

  private save(job: TransferJob): void {
    this.jobs.set(job.id, job);
    fs.mkdirSync(this.jobDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(this.jobDir, `${job.id}.json`), JSON.stringify(job), { mode: 0o600 });
  }

  // 작업 상태. 서버가 재시작되면 파일의 마지막 상태를 돌려주며, 끝나지 않은 단계는 중단으로 본다.
  getJob(id: string): TransferJob | undefined {
    if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
    const live = this.jobs.get(id);
    if (live) return live;
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(this.jobDir, `${id}.json`), "utf8")) as TransferJob;
      if (saved.status === "running") {
        saved.status = "failed";
        for (const step of saved.steps) if (step.status === "running" || step.status === "pending") { step.status = "failed"; step.output += "\n✗ 서버 재시작으로 중단되었습니다.\n"; }
      }
      return saved;
    } catch { return undefined; }
  }
}

export interface OutgoingTransfer {
  id: string;
  nodeId: string;
  projectId: number;
  state: "uploading" | "extracting" | "done" | "failed";
  destination: string;
  // 압축 후 보낸 바이트. 원본 크기(sourceBytes)와 단위가 달라 진행률(%)로 쓰지 않는다.
  sentBytes: number;
  sourceBytes: number;
  error?: string;
  remoteJob?: TransferJob;
}

type FederationTransport = Pick<FederationService, "request" | "upload">;

function parseReply(result: { status: number; body: Uint8Array }): any {
  try { return JSON.parse(Buffer.from(result.body).toString("utf8")); } catch { return {}; }
}

// 메인 쪽: 대상 WAM에 업로드를 열고, 압축 스트림을 조각으로 나눠 보낸 뒤 완료를 요청한다.
export class ProjectTransferSender {
  private readonly transfers = new Map<string, OutgoingTransfer>();

  constructor(private readonly federation: FederationTransport) {}

  // 업로드 시작(계획·대상 경로 검증)까지 기다려 충돌 같은 오류는 바로 돌려주고, 전송은 백그라운드로 진행한다.
  async start(nodeId: string, projectId: number, root: string, scan: ProjectScan, plan: TransferPlan): Promise<OutgoingTransfer> {
    const opened = await this.federation.request(nodeId, "/project-transfer/uploads", "POST", { plan });
    const body = parseReply(opened);
    if (opened.status === 404 && !body?.error) throw Object.assign(new Error("대상 WAM이 프로젝트 이동을 지원하지 않는 버전입니다. 대상도 최신 버전으로 업데이트하세요."), { statusCode: 502 });
    if (opened.status >= 400) throw Object.assign(new Error(`대상 WAM이 받을 수 없습니다: ${body?.error ?? opened.status}`), { statusCode: opened.status === 409 || opened.status === 400 ? opened.status : 502 });
    const transfer: OutgoingTransfer = { id: crypto.randomUUID(), nodeId, projectId, state: "uploading", destination: body.destination, sentBytes: 0, sourceBytes: scan.bytes };
    this.transfers.set(transfer.id, transfer);
    void this.send(transfer, body.uploadId, root, scan.entries);
    return transfer;
  }

  private async send(transfer: OutgoingTransfer, uploadId: string, root: string, entries: string[]): Promise<void> {
    const base = `/project-transfer/uploads/${uploadId}`;
    const archive = createProjectArchive(root, entries);
    try {
      let pending: Buffer[] = [];
      let pendingBytes = 0;
      let index = 0;
      const flush = async (): Promise<void> => {
        const chunk = Buffer.concat(pending);
        pending = []; pendingBytes = 0;
        const reply = await this.federation.upload(transfer.nodeId, `${base}/chunks/${index}`, Readable.from([chunk]), { "Content-Type": "application/octet-stream" }, 10 * 60_000);
        if (reply.status >= 400) throw new Error(`조각 ${index} 전송 실패: ${parseReply(reply)?.error ?? reply.status}`);
        index += 1;
        transfer.sentBytes += chunk.length;
      };
      for await (const data of archive) {
        pending.push(data as Buffer);
        pendingBytes += (data as Buffer).length;
        if (pendingBytes >= CHUNK_BYTES) await flush();
      }
      if (pendingBytes > 0 || index === 0) await flush();
      transfer.state = "extracting";
      const done = await this.federation.request(transfer.nodeId, `${base}/complete`, "POST", {}, 60 * 60_000);
      const body = parseReply(done);
      if (done.status >= 400) throw new Error(`대상 WAM이 압축을 풀지 못했습니다: ${body?.error ?? done.status}`);
      transfer.remoteJob = body.job;
      transfer.state = "done";
    } catch (error) {
      archive.destroy();
      transfer.state = "failed";
      transfer.error = error instanceof Error ? error.message : String(error);
      await this.federation.request(transfer.nodeId, base, "DELETE").catch(() => undefined);
    }
  }

  get(id: string): OutgoingTransfer | undefined {
    return this.transfers.get(id);
  }
}
