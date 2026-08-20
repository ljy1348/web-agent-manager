import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createBuiltinExperimentHookBus } from "../src/server/experiments/builtin-hooks";
import { HookValidationError } from "../src/server/experiments/hook-bus";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

// 한 파일을 커밋한 임시 Git 저장소를 만든다.
function createRepository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-builtin-hooks-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "sample.txt"), "base\n");
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", "sample.txt"], { cwd: root });
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base", "--quiet"], { cwd: root });
  return root;
}

describe("실험 내장 훅", () => {
  it("diff_stats가 tracked·untracked 변경 줄 수를 hook payload에 추가한다", async () => {
    const root = createRepository();
    fs.writeFileSync(path.join(root, "sample.txt"), "base\nadded\n");
    fs.writeFileSync(path.join(root, "new.txt"), "one\ntwo\n");
    const bus = createBuiltinExperimentHookBus(["diff_stats"], root);

    const result = await bus.emit({ event: "after_node", runId: "run-1", payload: { role: "worker" } });

    expect(result.payload).toEqual({ role: "worker", diffStats: { files: 2, additions: 3, deletions: 0, untrackedFiles: 1 } });
  });

  it("git_diff_check가 trailing whitespace를 validate 오류로 차단한다", async () => {
    const root = createRepository();
    fs.writeFileSync(path.join(root, "sample.txt"), "base  \n");
    const bus = createBuiltinExperimentHookBus(["git_diff_check"], root);

    await expect(bus.emit({ event: "after_node", runId: "run-1" })).rejects.toBeInstanceOf(HookValidationError);
    expect(() => createBuiltinExperimentHookBus(["shell:anything"], root)).toThrow("등록되지 않은");
  });
});
