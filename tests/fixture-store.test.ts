import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { ExperimentFixtureStore } from "../src/server/experiments/fixture-store";
import type { ExperimentFixtureRecord } from "../src/server/services/experiment-repository";

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

// 네트워크 없이 file:// 원본으로 쓸 실제 Git 저장소를 만든다.
function createUpstream(): { url: string; head: string; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-fixture-upstream-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString().trim();
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.email", "fixture@example.com");
  git("config", "user.name", "fixture");
  fs.writeFileSync(path.join(root, "app.py"), "def add(a, b):\n    return a + b\n");
  git("add", "app.py");
  git("commit", "--quiet", "-m", "base");
  const head = git("rev-parse", "HEAD");
  return { url: `file://${root}`, head, root };
}

// 저장소 없이 fixture 레코드 모양만 만든다.
function fixture(overrides: Partial<ExperimentFixtureRecord>): ExperimentFixtureRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111", name: "sample",
    url: "file:///missing", pinnedCommit: "0".repeat(40), sizeClass: "small",
    language: null, license: null, linesOfCode: null, setupCommand: [], testCommand: [],
    status: "ready", gate: {}, mirrorPath: null,
    createdAt: "2026-08-15T00:00:00.000Z", updatedAt: "2026-08-15T00:00:00.000Z",
    ...overrides,
  };
}

// 앱 관리 데이터 경로를 임시로 만든다.
function createStore(): { store: ExperimentFixtureStore; dataDir: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wam-fixture-store-"));
  cleanup.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { store: new ExperimentFixtureStore({ dataDir } as AppConfig), dataDir };
}

describe("실험 fixture 저장소", () => {
  it("실제 저장소를 bare mirror로 캐시하고 고정 commit의 worktree를 만든다", async () => {
    const upstream = createUpstream();
    const { store, dataDir } = createStore();
    const record = fixture({ url: upstream.url, pinnedCommit: upstream.head });

    const mirror = await store.ensureMirror(record);
    expect(fs.existsSync(path.join(mirror, "HEAD"))).toBe(true);
    expect(mirror.startsWith(path.join(dataDir, "experiment-fixtures"))).toBe(true);

    // 두 번째 호출은 이미 받은 mirror를 그대로 쓴다.
    expect(await store.ensureMirror(record)).toBe(mirror);

    const workspace = await store.createWorktree(record, "22222222-2222-4222-8222-222222222222");
    expect(workspace).toMatchObject({ baselineCommit: upstream.head, source: "fixture" });
    expect(fs.readFileSync(path.join(workspace.workingDirectory, "app.py"), "utf8")).toContain("def add");
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace.workingDirectory }).toString().trim())
      .toBe(upstream.head);

    // 같은 키로 두 번 만들지 않는다.
    await expect(store.createWorktree(record, "22222222-2222-4222-8222-222222222222")).rejects.toThrow("이미 있습니다");

    expect(await store.remove(workspace.root, mirror)).toBe(true);
    expect(fs.existsSync(workspace.root)).toBe(false);
  });

  it("저장소에 없는 commit은 fetch 후에도 거부한다", async () => {
    const upstream = createUpstream();
    const { store } = createStore();
    const record = fixture({ url: upstream.url, pinnedCommit: "a".repeat(40) });
    await expect(store.ensureMirror(record)).rejects.toThrow("기준 commit이 저장소에 없습니다");
  });

  it("greenfield용 빈 Git 작업공간을 만들고 관리 경로 밖 제거를 막는다", async () => {
    const { store } = createStore();
    const workspace = await store.createEmptyWorkspace("33333333-3333-4333-8333-333333333333");
    expect(workspace).toMatchObject({ baselineCommit: "", source: "empty" });
    expect(fs.existsSync(path.join(workspace.workingDirectory, ".git"))).toBe(true);

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "wam-outside-"));
    cleanup.push(() => fs.rmSync(outside, { recursive: true, force: true }));
    await expect(store.remove(outside, null)).rejects.toThrow("앱 관리 경로 밖");

    expect(await store.remove(workspace.root, null)).toBe(true);
    expect(fs.existsSync(workspace.root)).toBe(false);
  });
});
