import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { GitHunkReviewService } from "../src/server/services/git-hunk-review";

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

function repository(): { root: string; git: (args: string[]) => string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-hunk-review-")); roots.push(root);
  const git = (args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git(["init", "-q"]); git(["config", "user.email", "qa@example.com"]); git(["config", "user.name", "QA"]);
  fs.writeFileSync(path.join(root, "sample.txt"), Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n") + "\n");
  git(["add", "."]); git(["commit", "-q", "-m", "baseline"]);
  return { root, git };
}

describe("Git hunk 검토", () => {
  it("서로 떨어진 hunk 하나만 stage하고 나머지는 worktree에서 되돌린다", async () => {
    const { root, git } = repository();
    const file = path.join(root, "sample.txt");
    const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
    lines[0] = "accepted line"; lines[19] = "rejected line"; fs.writeFileSync(file, `${lines.join("\n")}\n`);
    const service = new GitHunkReviewService();
    const initial = await service.snapshot(root, ["sample.txt"]);
    expect(initial.files[0].hunks).toHaveLength(2);

    const accepted = await service.decide(root, { path: "sample.txt", fileHash: initial.files[0].fileHash, hunkId: initial.files[0].hunks[0].id, decision: "accept" });
    expect(git(["diff", "--cached", "--", "sample.txt"])).toContain("accepted line");
    expect(git(["diff", "--", "sample.txt"])).toContain("rejected line");
    expect(accepted.files[0].hunks).toHaveLength(1);

    await service.decide(root, { path: "sample.txt", fileHash: accepted.files[0].fileHash, hunkId: accepted.files[0].hunks[0].id, decision: "reject" });
    expect(git(["diff", "--", "sample.txt"])).toBe("");
    expect(fs.readFileSync(file, "utf8")).toContain("accepted line");
    expect(fs.readFileSync(file, "utf8")).toContain("line 20");
  });

  it("화면을 본 뒤 파일이 바뀌면 stale hash로 어떤 hunk도 적용하지 않는다", async () => {
    const { root, git } = repository();
    const file = path.join(root, "sample.txt");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("line 1", "first edit"));
    const service = new GitHunkReviewService();
    const snapshot = await service.snapshot(root, ["sample.txt"]);
    fs.appendFileSync(file, "late edit\n");
    await expect(service.decide(root, { path: "sample.txt", fileHash: snapshot.files[0].fileHash, hunkId: snapshot.files[0].hunks[0].id, decision: "accept" })).rejects.toMatchObject({ statusCode: 409 });
    expect(git(["diff", "--cached", "--", "sample.txt"])).toBe("");
    expect(fs.readFileSync(file, "utf8")).toContain("late edit");
  });

  it("untracked text hunk도 승인하면 index에만 추가하고 worktree 내용은 유지한다", async () => {
    const { root, git } = repository();
    fs.writeFileSync(path.join(root, "new file.txt"), "one\ntwo\n");
    const service = new GitHunkReviewService();
    const snapshot = await service.snapshot(root, ["new file.txt"]);
    expect(snapshot.files[0].decisionAllowed).toBe(true);
    await service.decide(root, { path: "new file.txt", fileHash: snapshot.files[0].fileHash, hunkId: snapshot.files[0].hunks[0].id, decision: "accept" });
    expect(git(["diff", "--cached", "--", "new file.txt"])).toContain("+two");
    expect(fs.readFileSync(path.join(root, "new file.txt"), "utf8")).toBe("one\ntwo\n");
  });
});
