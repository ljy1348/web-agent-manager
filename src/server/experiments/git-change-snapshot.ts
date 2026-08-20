import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_UNTRACKED_FILES = 200;
const MAX_UNTRACKED_BYTES = 4 * 1024 * 1024;

export interface GitChangeStats {
  files: number;
  additions: number;
  deletions: number;
  untrackedFiles: number;
}

export interface GitChangeSnapshot {
  diff: string;
  stats: GitChangeStats;
  untrackedPaths: string[];
}

// git numstat 출력에서 binary 표식을 제외한 파일·추가·삭제 줄 수를 합산한다.
function parseNumstat(output: string): Omit<GitChangeStats, "untrackedFiles"> {
  let files = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [added, removed] = line.split("\t");
    files += 1;
    if (/^\d+$/.test(added || "")) additions += Number(added);
    if (/^\d+$/.test(removed || "")) deletions += Number(removed);
  }
  return { files, additions, deletions };
}

// git diff --no-index의 차이 있음 exit 1은 정상 결과로 바꾼다.
async function noIndexDiff(workingDirectory: string, relativePath: string): Promise<string> {
  try {
    const result = await execFileAsync("git", ["diff", "--no-ext-diff", "--no-color", "--no-index", "--", "/dev/null", relativePath], {
      cwd: workingDirectory, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    const detail = error as { code?: number | string; stdout?: string };
    if (detail.code === 1 && typeof detail.stdout === "string") return detail.stdout;
    throw new Error(`untracked 산출물 diff를 읽지 못했습니다: ${relativePath}`, { cause: error });
  }
}

// 텍스트 새 파일이 diff에 기여하는 추가 줄 수를 계산하고 binary는 0으로 둔다.
function addedLines(content: Buffer): number {
  if (!content.length || content.includes(0)) return 0;
  const text = content.toString("utf8");
  const lines = text.split(/\r\n|\n|\r/).length;
  return /(?:\r\n|\n|\r)$/.test(text) ? lines - 1 : lines;
}

// index를 변경하지 않고 tracked와 untracked 일반 파일을 하나의 산출물 스냅샷으로 만든다.
export async function collectGitChangeSnapshot(workingDirectory: string, includeDiff = true): Promise<GitChangeSnapshot> {
  const [trackedDiff, trackedNumstat, untrackedOutput] = await Promise.all([
    includeDiff
      ? execFileAsync("git", ["diff", "--no-ext-diff", "--no-color", "--", "."], { cwd: workingDirectory, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }).then((result) => result.stdout)
      : Promise.resolve(""),
    execFileAsync("git", ["diff", "--numstat", "--", "."], { cwd: workingDirectory, timeout: 30_000, maxBuffer: 1024 * 1024 }).then((result) => result.stdout),
    execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z", "--", "."], { cwd: workingDirectory, timeout: 30_000, maxBuffer: 1024 * 1024 }).then((result) => result.stdout),
  ]);
  const untrackedPaths = untrackedOutput.split("\0").filter(Boolean).sort((left, right) => left.localeCompare(right));
  if (untrackedPaths.length > MAX_UNTRACKED_FILES) throw new Error(`untracked 산출물이 ${MAX_UNTRACKED_FILES}개를 초과합니다.`);
  const tracked = parseNumstat(trackedNumstat);
  let untrackedBytes = 0;
  let untrackedAdditions = 0;
  const patches: string[] = [];
  for (const relativePath of untrackedPaths) {
    const stat = await fs.lstat(`${workingDirectory}/${relativePath}`);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`untracked 산출물은 일반 파일이어야 합니다: ${relativePath}`);
    untrackedBytes += stat.size;
    if (untrackedBytes > MAX_UNTRACKED_BYTES) throw new Error("untracked 산출물 총량이 4MiB를 초과합니다.");
    const content = await fs.readFile(`${workingDirectory}/${relativePath}`);
    untrackedAdditions += addedLines(content);
    if (includeDiff) patches.push(await noIndexDiff(workingDirectory, relativePath));
  }
  return {
    diff: [trackedDiff.trimEnd(), ...patches.map((patch) => patch.trimEnd())].filter(Boolean).join("\n\n"),
    stats: {
      files: tracked.files + untrackedPaths.length,
      additions: tracked.additions + untrackedAdditions,
      deletions: tracked.deletions,
      untrackedFiles: untrackedPaths.length,
    },
    untrackedPaths,
  };
}
