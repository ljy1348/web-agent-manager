import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_PATCH_BYTES = 5 * 1024 * 1024;

export type HunkDecision = "accept" | "reject";

export interface ReviewHunk {
  id: string;
  oldStart: number;
  newStart: number;
  header: string;
}

export interface ReviewFile {
  path: string;
  fileHash: string;
  hunks: ReviewHunk[];
  decisionAllowed: boolean;
  reason: string | null;
}

export interface HunkReviewSnapshot {
  diff: string;
  files: ReviewFile[];
}

interface ParsedPatch {
  patch: string;
  header: string;
  fileHash: string;
  hunks: Array<ReviewHunk & { patch: string }>;
  decisionAllowed: boolean;
  reason: string | null;
}

function digest(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function parseRange(header: string): { oldStart: number; newStart: number } {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
  if (!match) throw new Error("Git hunk header를 해석할 수 없습니다.");
  return { oldStart: Number(match[1]), newStart: Number(match[2]) };
}

export function parseReviewPatch(path: string, raw: string): ParsedPatch {
  // trimEnd()는 마지막 변경 줄의 의도적인 공백까지 지워 실제로 본 patch와 적용 patch를 다르게 만든다.
  const patch = raw.replace(/\n+$/, "");
  if (!patch) return { patch: "", header: "", fileHash: digest(""), hunks: [], decisionAllowed: false, reason: "unstaged 변경 없음" };
  const lines = patch.split("\n");
  const firstHunk = lines.findIndex((line) => line.startsWith("@@ "));
  const header = firstHunk < 0 ? patch : lines.slice(0, firstHunk).join("\n");
  const unsupported = /^(?:Binary files |GIT binary patch|rename from |rename to |copy from |copy to )/m.test(header);
  const reason = unsupported ? "binary·rename/copy hunk는 부분 결정할 수 없습니다." : firstHunk < 0 ? "적용 가능한 text hunk가 없습니다." : null;
  const hunks: Array<ReviewHunk & { patch: string }> = [];
  if (firstHunk >= 0) {
    for (let start = firstHunk; start < lines.length;) {
      let end = start + 1;
      while (end < lines.length && !lines[end].startsWith("@@ ")) end += 1;
      const hunkPatch = lines.slice(start, end).join("\n");
      const range = parseRange(lines[start]);
      hunks.push({ id: digest(`${path}\0${hunkPatch}`), ...range, header: lines[start], patch: hunkPatch });
      start = end;
    }
  }
  return { patch, header, fileHash: digest(patch), hunks, decisionAllowed: !reason, reason };
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, timeout: 15_000, maxBuffer: MAX_PATCH_BYTES, env: process.env });
  return result.stdout.replace(/\n+$/, "");
}

async function noIndexDiff(cwd: string, path: string): Promise<string> {
  try {
    return await runGit(cwd, ["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-color", "--unified=3", "--no-index", "--", "/dev/null", path]);
  } catch (error) {
    const detail = error as { code?: number; stdout?: string };
    if (detail.code === 1 && typeof detail.stdout === "string") return detail.stdout.replace(/\n+$/, "");
    throw error;
  }
}

async function currentPatch(cwd: string, path: string): Promise<string> {
  const status = await runGit(cwd, ["status", "--porcelain=v1", "-z", "--", path]);
  if (status.startsWith("?? ")) return noIndexDiff(cwd, path);
  // index가 아니라 index→worktree만 비교해야 accept가 정확히 선택 hunk만 stage한다.
  return runGit(cwd, ["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-color", "--unified=3", "--", path]);
}

function applyPatch(cwd: string, patch: string, decision: HunkDecision): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = decision === "accept"
      ? ["apply", "--cached", "--recount", "--whitespace=nowarn", "-"]
      : ["apply", "--reverse", "--recount", "--whitespace=nowarn", "-"];
    const child = spawn("git", args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 8_000) stderr += chunk.toString("utf8"); });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(Object.assign(new Error((stderr || "Git hunk 적용에 실패했습니다.").trim()), { statusCode: 409 }));
    });
    child.stdin.end(`${patch.replace(/\n+$/, "")}\n`);
  });
}

export class GitHunkReviewService {
  async snapshot(cwd: string, paths: string[]): Promise<HunkReviewSnapshot> {
    const unique = [...new Set(paths)];
    if (!unique.length || unique.length > 50) throw new Error("검토할 파일은 1~50개를 선택해주세요.");
    // 수십 개 git 프로세스를 한꺼번에 띄우지 않고 직렬화하며 응답 전체도 기존 diff 상한 안에 둔다.
    const parsed: Array<{ path: string; parsed: ParsedPatch }> = [];
    let totalBytes = 0;
    for (const path of unique) {
      const item = parseReviewPatch(path, await currentPatch(cwd, path));
      totalBytes += Buffer.byteLength(item.patch);
      if (totalBytes > MAX_PATCH_BYTES) throw new Error("검토 diff가 5MiB를 초과합니다. 파일을 나눠 선택해주세요.");
      parsed.push({ path, parsed: item });
    }
    return {
      diff: parsed.map((item) => item.parsed.patch).filter(Boolean).join("\n"),
      files: parsed.map(({ path, parsed: item }) => ({ path, fileHash: item.fileHash,
        hunks: item.hunks.map(({ patch: _patch, ...hunk }) => hunk), decisionAllowed: item.decisionAllowed, reason: item.reason })),
    };
  }

  async decide(cwd: string, input: { path: string; fileHash: string; hunkId: string; decision: HunkDecision }): Promise<HunkReviewSnapshot> {
    if (!/^[a-f0-9]{64}$/.test(input.fileHash) || !/^[a-f0-9]{64}$/.test(input.hunkId)) throw new Error("hunk 식별자가 올바르지 않습니다.");
    const current = parseReviewPatch(input.path, await currentPatch(cwd, input.path));
    if (current.fileHash !== input.fileHash) throw Object.assign(new Error("diff가 바뀌었습니다. 새로고침 후 다시 결정해주세요."), { statusCode: 409 });
    if (!current.decisionAllowed) throw Object.assign(new Error(current.reason || "이 변경은 부분 결정할 수 없습니다."), { statusCode: 409 });
    const hunk = current.hunks.find((item) => item.id === input.hunkId);
    if (!hunk) throw Object.assign(new Error("hunk가 바뀌었습니다. 새로고침 후 다시 결정해주세요."), { statusCode: 409 });
    await applyPatch(cwd, `${current.header}\n${hunk.patch}`, input.decision);
    return this.snapshot(cwd, [input.path]);
  }
}
