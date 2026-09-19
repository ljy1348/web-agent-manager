import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GithubAutoMergeService } from "../src/server/services/github-auto-merge";

const runFile = promisify(execFile);
const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

function harness(overrides: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-pr-auto-merge-")); roots.push(root);
  const statePath = path.join(root, "state.json");
  const callsPath = path.join(root, "calls.jsonl");
  const executable = path.join(root, "fake-gh.mjs");
  const head = "a".repeat(40);
  fs.writeFileSync(statePath, JSON.stringify({
    number: 7, title: "QA", state: "OPEN", headRefOid: head, isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED",
    reviewDecision: "REVIEW_REQUIRED", autoMergeRequest: null, statusCheckRollup: [{ status: "IN_PROGRESS" }, { status: "COMPLETED", conclusion: "SUCCESS" }],
    ...overrides,
  }));
  fs.writeFileSync(executable, `#!/usr/bin/env node
    import fs from 'node:fs';
    const args = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n');
    const statePath = ${JSON.stringify(statePath)}; const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (args[0] !== 'pr') process.exit(20);
    if (args[1] === 'view') { process.stdout.write(JSON.stringify(state)); process.exit(0); }
    if (args[1] !== 'merge' || args[2] !== '7') process.exit(21);
    if (args.includes('--auto')) state.autoMergeRequest = { mergeMethod: 'SQUASH' };
    else if (args.includes('--disable-auto')) state.autoMergeRequest = null;
    else process.exit(22);
    fs.writeFileSync(statePath, JSON.stringify(state));
  `, { mode: 0o700 });
  const runner = async (_command: string, args: string[], cwd: string): Promise<string> => (await runFile(executable, args, { cwd, timeout: 2_000, maxBuffer: 1024 * 1024 })).stdout.trim();
  return { root, head, callsPath, service: new GithubAutoMergeService(runner), calls: () => fs.readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]) };
}

describe("GitHub 조건부 자동 merge", () => {
  it("pending check를 표시하고 head pin·native --auto 고정 argv로 예약·취소한다", async () => {
    const value = harness();
    const started = performance.now();
    const initial = await value.service.read(value.root, 7);
    expect(initial.checkSummary).toMatchObject({ state: "pending", totalCount: 2, passedCount: 1, pendingCount: 1 });
    const armed = await value.service.set(value.root, 7, { enabled: true, expectedHeadSha: value.head, method: "squash", deleteBranch: true });
    expect(armed.autoMergeEnabled).toBe(true);
    expect(value.calls()).toContainEqual(["pr", "merge", "7", "--squash", "--auto", "--match-head-commit", value.head, "--delete-branch"]);
    const cancelled = await value.service.set(value.root, 7, { enabled: false, expectedHeadSha: value.head });
    expect(cancelled.autoMergeEnabled).toBe(false);
    expect(value.calls()).toContainEqual(["pr", "merge", "7", "--disable-auto", "--match-head-commit", value.head]);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it.each([
    [{ isDraft: true }, /draft/],
    [{ mergeable: "CONFLICTING" }, /충돌/],
    [{ mergeable: "UNKNOWN" }, /확인할 수 없습니다/],
    [{ reviewDecision: "CHANGES_REQUESTED" }, /변경 요청/],
    [{ statusCheckRollup: [] }, /check가 없어/],
    [{ statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }] }, /실패하거나/],
    [{ statusCheckRollup: [{ unexpected: true }] }, /판정 불가/],
    [{ state: "CLOSED" }, /열린 PR/],
  ])("안전 조건을 만족하지 않는 PR %j을 mutation 전에 거부한다", async (overrides, message) => {
    const value = harness(overrides);
    await expect(value.service.set(value.root, 7, { enabled: true, expectedHeadSha: value.head, method: "squash" })).rejects.toThrow(message);
    expect(value.calls().filter((args) => args[1] === "merge")).toEqual([]);
  });

  it("stale head와 임의 method·boolean을 거부한다", async () => {
    const stale = harness();
    await expect(stale.service.set(stale.root, 7, { enabled: true, expectedHeadSha: "b".repeat(40) })).rejects.toThrow(/head가 바뀌/);
    expect(stale.calls().filter((args) => args[1] === "merge")).toEqual([]);
    const method = harness();
    await expect(method.service.set(method.root, 7, { enabled: true, expectedHeadSha: method.head, method: "--admin" })).rejects.toThrow(/병합 방식/);
    const bool = harness();
    await expect(bool.service.set(bool.root, 7, { enabled: true, expectedHeadSha: bool.head, deleteBranch: "yes" })).rejects.toThrow(/boolean/);
  });
});
