import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAllowedRoots, readProductEnv, resolveHomeDir } from "../src/server/core/config";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("readProductEnv", () => {
  it("새 환경변수를 우선하고 기존 MYAGENT 변수도 호환값으로 읽는다", () => {
    vi.stubEnv("MYAGENT_PORT", "4000");
    expect(readProductEnv("PORT")).toBe("4000");
    vi.stubEnv("WEB_AGENT_MANAGER_PORT", "4317");
    expect(readProductEnv("PORT")).toBe("4317");
  });
});

describe("resolveHomeDir", () => {
  it("설치 경로가 /home/계정 아래면 프로세스 실행 계정과 무관하게 그 계정 홈을 반환한다", () => {
    // 실제 장애 사례: systemd가 root로 web-agent-manager를 띄우면 os.homedir()은 /root를 반환해
    // /home/testuser 하위 프로젝트 경로와 전혀 매칭되지 않았다.
    expect(resolveHomeDir("/home/testuser/web-agent-manager")).toBe("/home/testuser");
    expect(resolveHomeDir("/home/testuser/apps/web-agent-manager")).toBe("/home/testuser");
    expect(resolveHomeDir("/home/deploy/services/web-agent-manager")).toBe("/home/deploy");
  });

  it("/home 하위가 아닌 설치 경로는 os.homedir()로 폴백한다", () => {
    const spy = vi.spyOn(os, "homedir").mockReturnValue("/opt/fallback-home");
    expect(resolveHomeDir("/opt/web-agent-manager")).toBe("/opt/fallback-home");
    spy.mockRestore();
  });
});

describe("parseAllowedRoots", () => {
  it("미설정 또는 빈 값이면 전체 파일시스템을 기본 허용한다", () => {
    expect(parseAllowedRoots(undefined)).toEqual([path.resolve("/")]);
    expect(parseAllowedRoots("")).toEqual([path.resolve("/")]);
    expect(parseAllowedRoots(" , ")).toEqual([path.resolve("/")]);
  });

  it("명시한 경로가 있으면 해당 경로만 정규화한다", () => {
    expect(parseAllowedRoots(" /home/testuser, /srv/projects ")).toEqual([
      path.resolve("/home/testuser"),
      path.resolve("/srv/projects"),
    ]);
  });
});
