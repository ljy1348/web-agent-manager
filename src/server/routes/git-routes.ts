import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Router } from "express";
import type { AppDatabase } from "../core/database";
import { requireAdmin, type AuthenticatedRequest } from "../core/auth";
import { writeAudit } from "../core/audit";
import { getProjectPath, resolveProjectPath } from "./helpers";

const runFile = promisify(execFile);

interface GitChange {
  path: string;
  oldPath?: string;
  indexStatus: string;
  worktreeStatus: string;
}

interface GitCommit {
  hash: string;
  author: string;
  date: string;
  subject: string;
}

type GhObject = Record<string, unknown>;

// 지정 작업 디렉터리에서 인자 배열 기반 명령을 실행한다.
async function run(command: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await runFile(command, args, { cwd, timeout: 30_000, maxBuffer: 5 * 1024 * 1024, env: process.env });
  return stdout.trim();
}

// `git diff --no-index`는 일반 git diff와 달리 unix diff처럼 차이가 있으면 종료 코드 1을 반환해
// execFile이 예외로 던진다 — 1은 "차이가 있다"는 정상 결과이므로 stdout을 그대로 쓰고, 그 외 코드만
// 진짜 실패로 취급한다.
async function runNoIndexDiff(args: string[], cwd: string): Promise<string> {
  try {
    return (await runFile("git", args, { cwd, timeout: 30_000, maxBuffer: 5 * 1024 * 1024, env: process.env })).stdout.trim();
  } catch (error) {
    const withStdout = error as { code?: number; stdout?: string };
    if (withStdout.code === 1 && typeof withStdout.stdout === "string") return withStdout.stdout.trim();
    throw error;
  }
}

// Git 브랜치 이름이 안전한 일반 참조 형식인지 확인한다.
function assertBranch(branch: string): void {
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(branch) || branch.includes("..") || branch.startsWith("-") || branch.endsWith("/")) {
    throw new Error("유효하지 않은 브랜치 이름입니다.");
  }
}

// 클라이언트에서 전달한 파일 필터를 프로젝트 경계 안의 Git 경로 목록으로 정리한다.
function queryFiles(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return values.map((item) => String(item).trim()).filter(Boolean);
}

// porcelain status -z 출력을 변경 파일 카드에 필요한 구조로 변환한다.
function parseStatus(output: string): GitChange[] {
  const tokens = output.split("\0").filter(Boolean);
  const changes: GitChange[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const code = token.slice(0, 2);
    const path = token.slice(2).trimStart();
    if (code.startsWith("R") || code.startsWith("C")) {
      const oldPath = tokens[index + 1];
      index += 1;
      changes.push({ path, oldPath, indexStatus: code[0], worktreeStatus: code[1] });
    } else {
      changes.push({ path, indexStatus: code[0], worktreeStatus: code[1] });
    }
  }
  return changes;
}

// git log TSV 출력을 최근 커밋 목록 UI가 바로 쓸 수 있는 구조로 변환한다.
function parseLog(output: string): GitCommit[] {
  return output.split("\n").filter(Boolean).map((line) => {
    const [hash = "", author = "", date = "", ...subjectParts] = line.split("\t");
    return { hash, author, date, subject: subjectParts.join("\t") };
  });
}

// 커밋 해시·짧은 해시·참조명처럼 git show에 넘길 수 있는 안전한 rev 문자열인지 확인한다.
function assertRevision(revision: string): void {
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(revision) || revision.startsWith("-") || revision.includes("..")) {
    throw new Error("유효하지 않은 커밋 식별자입니다.");
  }
}

// GitHub 이슈·PR 번호가 양의 정수인지 확인한다.
function issueNumber(value: unknown): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error("유효하지 않은 번호입니다.");
  return number;
}

// gh JSON 출력을 객체로 변환한다.
function parseGhJson<T>(output: string): T {
  return JSON.parse(output || "null") as T;
}

// gh 조회 하나가 실패해도 GitHub 탭 전체가 비지 않도록 결과와 오류를 분리한다.
async function ghJson<T>(cwd: string, args: string[], fallback: T): Promise<{ value: T; error?: string }> {
  try {
    return { value: parseGhJson<T>(await run("gh", args, cwd)) };
  } catch (error) {
    return { value: fallback, error: error instanceof Error ? error.message : "GitHub 조회 실패" };
  }
}

// 로컬 Git과 gh CLI 기반 GitHub 관리 API를 구성한다.
export function createGitRouter(database: AppDatabase): Router {
  const router = Router();
  // 권한 정책: Git/GitHub 조회는 로그인 사용자에게 허용하고, 저장소 상태를 바꾸는 POST 작업은 관리자만 허용한다.
  router.get("/projects/:id/git", async (request, response, next) => {
    try {
      const cwd = getProjectPath(database, Number(request.params.id));
      const [status, log, remotes] = await Promise.all([
        run("git", ["status", "--short", "--branch"], cwd),
        run("git", ["log", "-10", "--pretty=format:%h%x09%an%x09%ad%x09%s", "--date=iso-strict"], cwd).catch(() => ""),
        run("git", ["remote", "-v"], cwd).catch(() => ""),
      ]);
      response.json({ status, log, commits: parseLog(log), remotes });
    } catch (error) {
      next(error);
    }
  });
  router.get("/projects/:id/git/changes", async (request, response, next) => {
    try {
      const cwd = getProjectPath(database, Number(request.params.id));
      const output = await run("git", ["status", "--porcelain=v1", "-z"], cwd);
      response.json({ changes: parseStatus(output) });
    } catch (error) {
      next(error);
    }
  });
  router.get("/projects/:id/git/diff", async (request, response, next) => {
    try {
      const cwd = getProjectPath(database, Number(request.params.id));
      const files = queryFiles(request.query.file);
      for (const file of files) resolveProjectPath(cwd, file);
      // untracked(??) 파일은 HEAD와 비교할 대상 자체가 없어 `git diff HEAD`로는 절대 안 잡힌다 — 파일
      // 목록(상태 조회)에는 뜨는데 diff만 항상 비어 보이는 원인이었다. 상태를 다시 조회해 untracked만
      // 골라 파일별로 --no-index(전부 추가된 것으로) diff를 만들어 tracked 변경분 뒤에 이어 붙인다.
      const statusOutput = await run("git", ["status", "--porcelain=v1", "-z", "--", ...files], cwd);
      const untrackedFiles = parseStatus(statusOutput)
        .filter((change) => change.indexStatus === "?" && change.worktreeStatus === "?")
        .map((change) => change.path);
      const trackedFiles = files.length ? files.filter((file) => !untrackedFiles.includes(file)) : [];
      // "--"만 있고 그 뒤에 경로가 하나도 없으면 git은 "아무 경로도 없음"이 아니라 "제한 없음(전체)"으로
      // 해석한다 — 선택한 파일이 전부 untracked라 trackedFiles가 우연히 비어도, 원래 files가 비어있던
      // 게(=전체 diff 의도) 아니라면 관련 없는 다른 tracked 변경사항까지 섞여 나오면 안 된다.
      // core.quotePath 기본값(true)은 파일명에 한글 등 비ASCII 문자가 있으면 8진 이스케이프한 뒤
      // 큰따옴표로 감싸(예: "새파일.md" → "\354\203\210...") 클라이언트의 diff 헤더 경로 파싱(splitDiffSections)이
      // 깨진다 — 꺼서 경로를 원문 그대로 받는다.
      const trackedDiff = files.length && !trackedFiles.length ? "" : await run("git", ["-c", "core.quotePath=false", "diff", "--no-ext-diff", "HEAD", "--", ...trackedFiles], cwd);
      const untrackedDiffs = await Promise.all(
        untrackedFiles.map((file) => runNoIndexDiff(["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-index", "--", "/dev/null", file], cwd)),
      );
      response.json({ diff: [trackedDiff, ...untrackedDiffs].filter(Boolean).join("\n") });
    } catch (error) {
      next(error);
    }
  });
  router.get("/projects/:id/git/commit/:revision", async (request, response, next) => {
    try {
      const cwd = getProjectPath(database, Number(request.params.id));
      const revision = String(request.params.revision ?? "");
      assertRevision(revision);
      const output = await run("git", ["show", "--no-ext-diff", "--stat", "--patch", "--format=fuller", revision], cwd);
      response.json({ revision, diff: output });
    } catch (error) {
      next(error);
    }
  });
  router.post("/projects/:id/git/branch", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    try {
      const projectId = Number(request.params.id);
      const cwd = getProjectPath(database, projectId);
      const branch = String(request.body?.branch ?? "");
      assertBranch(branch);
      await run("git", request.body?.create ? ["switch", "-c", branch] : ["switch", branch], cwd);
      writeAudit(database, request.authUser!.id, "git.branch", "project", projectId, { branch, create: Boolean(request.body?.create) });
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });
  router.post("/projects/:id/git/commit", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    try {
      const projectId = Number(request.params.id);
      const cwd = getProjectPath(database, projectId);
      const files = Array.isArray(request.body?.files) ? request.body.files.filter((item: unknown) => typeof item === "string") as string[] : [];
      const message = String(request.body?.message ?? "").trim();
      if (!files.length || !message || message.length > 500) throw new Error("커밋 파일과 메시지가 필요합니다.");
      for (const file of files) resolveProjectPath(cwd, file, false);
      await run("git", ["add", "--", ...files], cwd);
      const output = await run("git", ["commit", "-m", message], cwd);
      writeAudit(database, request.authUser!.id, "git.commit", "project", projectId, { files, message });
      response.json({ output });
    } catch (error) {
      next(error);
    }
  });
  router.post("/projects/:id/git/push", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    try {
      if (request.body?.confirm !== true) throw new Error("push 확인이 필요합니다.");
      const projectId = Number(request.params.id);
      const cwd = getProjectPath(database, projectId);
      const branch = await run("git", ["branch", "--show-current"], cwd);
      assertBranch(branch);
      if (["main", "master", "dev", "develop"].includes(branch)) throw new Error("보호 브랜치에는 직접 push할 수 없습니다.");
      const output = await run("git", ["push", "-u", "origin", branch], cwd);
      writeAudit(database, request.authUser!.id, "git.push", "project", projectId, { branch });
      response.json({ output });
    } catch (error) {
      next(error);
    }
  });
  router.get("/projects/:id/github", async (request, response, next) => {
    try {
      const cwd = getProjectPath(database, Number(request.params.id));
      const [repository, issues, pullRequests, runs] = await Promise.all([
        ghJson<GhObject | null>(cwd, ["repo", "view", "--json", "nameWithOwner,url,defaultBranchRef"], null),
        ghJson<GhObject[]>(cwd, ["issue", "list", "--state", "all", "--limit", "50", "--json", "number,title,state,url,updatedAt,author,labels,assignees"], []),
        // statusCheckRollup은 PR마다 별도 체크 상태 API 호출이 더 필요해 gh pr list 응답이 크게
        // 느려지는데(체감상 원인이었던 조회 지연, 2026-07-23 확인), 화면 어디에도 쓰지 않으므로 뺀다.
        ghJson<GhObject[]>(cwd, ["pr", "list", "--state", "all", "--limit", "50", "--json", "number,title,state,url,headRefName,baseRefName,updatedAt,author,isDraft"], []),
        ghJson<GhObject[]>(cwd, ["run", "list", "--limit", "20", "--json", "databaseId,name,status,conclusion,url,updatedAt"], []),
      ]);
      if (!repository.value) throw new Error(repository.error || "GitHub 저장소 정보를 조회할 수 없습니다.");
      response.json({
        repository: repository.value,
        issues: issues.value,
        pullRequests: pullRequests.value,
        runs: runs.value,
        errors: { issues: issues.error, pullRequests: pullRequests.error, runs: runs.error },
      });
    } catch (error) {
      next(error);
    }
  });
  router.get("/projects/:id/github/issue/:number", async (request, response, next) => {
    try {
      const cwd = getProjectPath(database, Number(request.params.id));
      const number = issueNumber(request.params.number);
      const output = await run("gh", ["issue", "view", String(number), "--comments", "--json", "number,title,state,url,body,author,labels,assignees,comments,createdAt,updatedAt,closedAt"], cwd);
      response.json({ issue: parseGhJson(output) });
    } catch (error) {
      next(error);
    }
  });
  router.post("/projects/:id/github/issue", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    try {
      const projectId = Number(request.params.id);
      const cwd = getProjectPath(database, projectId);
      const title = String(request.body?.title ?? "").trim();
      const body = String(request.body?.body ?? "");
      if (!title) throw new Error("이슈 제목이 필요합니다.");
      const url = await run("gh", ["issue", "create", "--title", title, "--body", body], cwd);
      writeAudit(database, request.authUser!.id, "github.issue.create", "project", projectId, { title });
      response.status(201).json({ url });
    } catch (error) {
      next(error);
    }
  });
  router.post("/projects/:id/github/issue/:number/comment", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    try {
      const projectId = Number(request.params.id);
      const number = issueNumber(request.params.number);
      const body = String(request.body?.body ?? "").trim();
      if (!body) throw new Error("댓글 본문이 필요합니다.");
      const output = await run("gh", ["issue", "comment", String(number), "--body", body], getProjectPath(database, projectId));
      writeAudit(database, request.authUser!.id, "github.issue.comment", "project", projectId, { number });
      response.json({ output });
    } catch (error) {
      next(error);
    }
  });
  router.post("/projects/:id/github/issue/:number/close", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    try {
      const projectId = Number(request.params.id);
      const number = issueNumber(request.params.number);
      const comment = String(request.body?.comment ?? "").trim();
      const reason = String(request.body?.reason ?? "completed");
      if (!["completed", "not planned"].includes(reason)) throw new Error("유효하지 않은 닫기 사유입니다.");
      const args = ["issue", "close", String(number), "--reason", reason, ...(comment ? ["--comment", comment] : [])];
      const output = await run("gh", args, getProjectPath(database, projectId));
      writeAudit(database, request.authUser!.id, "github.issue.close", "project", projectId, { number, reason });
      response.json({ output });
    } catch (error) {
      next(error);
    }
  });
  router.post("/projects/:id/github/issue/:number/reopen", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    try {
      const projectId = Number(request.params.id);
      const number = issueNumber(request.params.number);
      const comment = String(request.body?.comment ?? "").trim();
      const output = await run("gh", ["issue", "reopen", String(number), ...(comment ? ["--comment", comment] : [])], getProjectPath(database, projectId));
      writeAudit(database, request.authUser!.id, "github.issue.reopen", "project", projectId, { number });
      response.json({ output });
    } catch (error) {
      next(error);
    }
  });
  router.post("/projects/:id/github/pr", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    try {
      const projectId = Number(request.params.id);
      const cwd = getProjectPath(database, projectId);
      const title = String(request.body?.title ?? "").trim();
      const body = String(request.body?.body ?? "");
      const base = String(request.body?.base ?? "main");
      assertBranch(base);
      if (!title) throw new Error("Pull Request 제목이 필요합니다.");
      const url = await run("gh", ["pr", "create", "--title", title, "--body", body, "--base", base], cwd);
      writeAudit(database, request.authUser!.id, "github.pr.create", "project", projectId, { title, base });
      response.status(201).json({ url });
    } catch (error) {
      next(error);
    }
  });
  router.get("/projects/:id/github/pr/:number", async (request, response, next) => {
    try {
      const cwd = getProjectPath(database, Number(request.params.id));
      const number = issueNumber(request.params.number);
      // 목록과 같은 이유로 statusCheckRollup은 빼 조회 속도를 개선한다(화면에서 안 씀).
      const output = await run("gh", ["pr", "view", String(number), "--comments", "--json", "number,title,state,url,body,author,comments,reviews,headRefName,baseRefName,isDraft,mergeable,mergedAt,createdAt,updatedAt,closedAt"], cwd);
      response.json({ pullRequest: parseGhJson(output) });
    } catch (error) {
      next(error);
    }
  });
  router.get("/projects/:id/github/pr/:number/diff", async (request, response, next) => {
    try {
      const cwd = getProjectPath(database, Number(request.params.id));
      const number = issueNumber(request.params.number);
      const diff = await run("gh", ["pr", "diff", String(number), "--patch", "--color", "never"], cwd);
      response.json({ diff });
    } catch (error) {
      next(error);
    }
  });
  router.post("/projects/:id/github/pr/:number/comment", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    try {
      const projectId = Number(request.params.id);
      const number = issueNumber(request.params.number);
      const body = String(request.body?.body ?? "").trim();
      if (!body) throw new Error("댓글 본문이 필요합니다.");
      const output = await run("gh", ["pr", "comment", String(number), "--body", body], getProjectPath(database, projectId));
      writeAudit(database, request.authUser!.id, "github.pr.comment", "project", projectId, { number });
      response.json({ output });
    } catch (error) {
      next(error);
    }
  });
  router.post("/projects/:id/github/pr/:number/review", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    try {
      const projectId = Number(request.params.id);
      const number = issueNumber(request.params.number);
      const action = String(request.body?.action ?? "comment");
      const body = String(request.body?.body ?? "");
      const flags: Record<string, string> = { approve: "--approve", comment: "--comment", requestChanges: "--request-changes" };
      const flag = flags[action];
      if (!flag) throw new Error("유효하지 않은 리뷰 동작입니다.");
      if (action !== "approve" && !body.trim()) throw new Error("리뷰 본문이 필요합니다.");
      const args = ["pr", "review", String(number), flag, ...(body ? ["--body", body] : [])];
      const output = await run("gh", args, getProjectPath(database, projectId));
      writeAudit(database, request.authUser!.id, "github.pr.review", "project", projectId, { number, action });
      response.json({ output });
    } catch (error) {
      next(error);
    }
  });
  router.post("/projects/:id/github/pr/:number/close", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    try {
      const projectId = Number(request.params.id);
      const number = issueNumber(request.params.number);
      const comment = String(request.body?.comment ?? "").trim();
      const output = await run("gh", ["pr", "close", String(number), ...(comment ? ["--comment", comment] : [])], getProjectPath(database, projectId));
      writeAudit(database, request.authUser!.id, "github.pr.close", "project", projectId, { number });
      response.json({ output });
    } catch (error) {
      next(error);
    }
  });
  router.post("/projects/:id/github/pr/:number/reopen", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    try {
      const projectId = Number(request.params.id);
      const number = issueNumber(request.params.number);
      const comment = String(request.body?.comment ?? "").trim();
      const output = await run("gh", ["pr", "reopen", String(number), ...(comment ? ["--comment", comment] : [])], getProjectPath(database, projectId));
      writeAudit(database, request.authUser!.id, "github.pr.reopen", "project", projectId, { number });
      response.json({ output });
    } catch (error) {
      next(error);
    }
  });
  router.post("/projects/:id/github/pr/:number/merge", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    try {
      if (request.body?.confirm !== true) throw new Error("PR 병합 확인이 필요합니다.");
      const projectId = Number(request.params.id);
      const number = issueNumber(request.params.number);
      const method = String(request.body?.method ?? "squash");
      const flags: Record<string, string> = { merge: "--merge", squash: "--squash", rebase: "--rebase" };
      const flag = flags[method];
      if (!flag) throw new Error("유효하지 않은 병합 방식입니다.");
      const output = await run("gh", ["pr", "merge", String(number), flag, ...(request.body?.deleteBranch ? ["--delete-branch"] : [])], getProjectPath(database, projectId));
      writeAudit(database, request.authUser!.id, "github.pr.merge", "project", projectId, { number, method, deleteBranch: Boolean(request.body?.deleteBranch) });
      response.json({ output });
    } catch (error) {
      next(error);
    }
  });
  router.post("/projects/:id/github/run/:runId/rerun", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    try {
      if (request.body?.confirm !== true) throw new Error("CI 재실행 확인이 필요합니다.");
      const projectId = Number(request.params.id);
      const runId = Number(request.params.runId);
      if (!Number.isInteger(runId) || runId < 1) throw new Error("유효하지 않은 workflow run ID입니다.");
      const output = await run("gh", ["run", "rerun", String(runId)], getProjectPath(database, projectId));
      writeAudit(database, request.authUser!.id, "github.run.rerun", "project", projectId, { runId });
      response.json({ output });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
