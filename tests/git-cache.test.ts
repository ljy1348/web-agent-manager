import { describe, expect, it } from "vitest";
import { GitDataCache } from "../src/server/services/git-cache";

// loader 호출 횟수를 세면서 값이 매번 달라지는 로더를 만든다.
function countingLoader(): { load: () => Promise<string>; calls: () => number } {
  let calls = 0;
  return {
    load: async () => { calls += 1; return `값${calls}`; },
    calls: () => calls,
  };
}

describe("Git 조회 캐시", () => {
  it("첫 조회만 실제로 실행하고 이후에는 저장된 값을 즉시 돌려준다", async () => {
    const cache = new GitDataCache(60_000);
    const loader = countingLoader();

    const first = await cache.read("git", 1, "/repo", loader.load);
    const second = await cache.read("git", 1, "/repo", loader.load);

    expect(first.value).toBe("값1");
    expect(second.value).toBe("값1");
    expect(second.stale).toBe(false);
    expect(loader.calls()).toBe(1);
  });

  it("TTL이 지나면 응답을 막지 않고 이전 값을 준 뒤 뒤에서 갱신한다", async () => {
    const cache = new GitDataCache(0);
    const loader = countingLoader();
    await cache.read("git", 1, "/repo", loader.load);

    const stale = await cache.read("git", 1, "/repo", loader.load);
    expect(stale.value).toBe("값1");
    expect(stale.stale).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 10));
    const refreshed = await cache.read("git", 1, "/repo", loader.load);
    expect(refreshed.value).toBe("값2");
  });

  it("force면 캐시를 건너뛰고 새 결과를 기다린다", async () => {
    const cache = new GitDataCache(60_000);
    const loader = countingLoader();
    await cache.read("git", 1, "/repo", loader.load);

    const forced = await cache.read("git", 1, "/repo", loader.load, true);

    expect(forced.value).toBe("값2");
    expect(loader.calls()).toBe(2);
  });

  it("프로젝트 캐시를 버리면 같은 프로젝트만 다시 읽고 다른 프로젝트는 유지한다", async () => {
    const cache = new GitDataCache(60_000);
    const first = countingLoader();
    const other = countingLoader();
    await cache.read("git", 1, "/repo", first.load);
    await cache.read("github", 1, "/repo", first.load);
    await cache.read("git", 2, "/other", other.load);

    cache.invalidateProject(1);
    await cache.read("git", 1, "/repo", first.load);
    await cache.read("git", 2, "/other", other.load);

    expect(first.calls()).toBe(3);
    expect(other.calls()).toBe(1);
  });

  it("첫 조회가 실패하면 캐시에 남기지 않고 다음 요청에서 다시 시도한다", async () => {
    const cache = new GitDataCache(60_000);
    let attempt = 0;
    const load = async (): Promise<string> => {
      attempt += 1;
      if (attempt === 1) throw new Error("gh 실패");
      return "복구";
    };

    await expect(cache.read("github", 1, "/repo", load)).rejects.toThrow("gh 실패");
    const recovered = await cache.read("github", 1, "/repo", load);

    expect(recovered.value).toBe("복구");
  });

  it("갱신에 실패해도 마지막으로 성공한 값은 계속 돌려준다", async () => {
    const cache = new GitDataCache(0);
    let attempt = 0;
    const load = async (): Promise<string> => {
      attempt += 1;
      if (attempt === 1) return "성공값";
      throw new Error("네트워크 끊김");
    };
    await cache.read("github", 1, "/repo", load);

    const stale = await cache.read("github", 1, "/repo", load);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const afterFailure = await cache.read("github", 1, "/repo", load);

    expect(stale.value).toBe("성공값");
    expect(afterFailure.value).toBe("성공값");
  });
});
