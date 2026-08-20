import { describe, expect, it } from "vitest";
import { GitDataCache } from "../src/server/services/git-cache";

// 지정한 시간이 지난 뒤 값을 주는 loader를 만든다. 호출 횟수도 함께 센다.
function slowLoader<T>(value: T, delayMs: number): { load: () => Promise<T>; calls: () => number } {
  let calls = 0;
  return {
    load: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return value;
    },
    calls: () => calls,
  };
}

describe("GitDataCache: 첫 조회가 끝나기 전에 들어온 요청", () => {
  it("빈 값 대신 진행 중인 조회 결과를 기다려 돌려준다", async () => {
    const cache = new GitDataCache();
    const payload = { repository: { url: "https://example.com" }, issues: [1, 2] };
    const loader = slowLoader(payload, 120);

    const first = cache.read("github", 1, "/repo", loader.load);
    // 첫 조회가 끝나기 전에 같은 키로 두 번째 요청이 도착한다.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await cache.read("github", 1, "/repo", loader.load);

    // 예전에는 자리표시 엔트리의 undefined가 그대로 나가 응답이 `{cachedAt}`만 남았고,
    // 그 응답을 받은 화면이 저장소 정보를 읽지 못해 통째로 깨졌다.
    expect(second.value).toEqual(payload);
    expect((await first).value).toEqual(payload);
    // 두 요청이 같은 조회를 공유하므로 CLI는 한 번만 실행된다.
    expect(loader.calls()).toBe(1);
  });

  it("기다려서 받은 결과에도 실제 저장 시각이 붙는다", async () => {
    const cache = new GitDataCache();
    const loader = slowLoader({ ok: true }, 80);

    const started = Date.now();
    void cache.read("git", 1, "/repo", loader.load);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await cache.read("git", 1, "/repo", loader.load);

    // 자리표시 엔트리의 updatedAt(0)이 그대로 나가면 1970년으로 표시된다.
    expect(second.cachedAt).toBeGreaterThanOrEqual(started);
    expect(second.stale).toBe(false);
  });

  it("첫 조회가 실패하면 뒤이은 요청도 같은 오류를 받는다", async () => {
    const cache = new GitDataCache();
    let calls = 0;
    const failing = async (): Promise<unknown> => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 60));
      throw new Error("gh 조회 실패");
    };

    const first = cache.read("github", 2, "/repo", failing);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = cache.read("github", 2, "/repo", failing);

    await expect(first).rejects.toThrow("gh 조회 실패");
    await expect(second).rejects.toThrow("gh 조회 실패");
    expect(calls).toBe(1);
  });

  it("조회가 끝난 뒤의 요청은 기다리지 않고 저장된 값을 바로 받는다", async () => {
    const cache = new GitDataCache();
    const loader = slowLoader({ ok: true }, 40);

    await cache.read("git", 3, "/repo", loader.load);
    const cached = await cache.read("git", 3, "/repo", loader.load);

    expect(cached.value).toEqual({ ok: true });
    expect(loader.calls()).toBe(1);
  });
});
