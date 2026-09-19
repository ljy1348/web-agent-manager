import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultLogLevel, keepDays, pruneLogsIn } from "../src/server/core/logger";

const temporaryDirectories: string[] = [];
const savedEnv = { ...process.env };

afterEach(() => {
  process.env = { ...savedEnv };
  while (temporaryDirectories.length) fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe("로그 기본 레벨", () => {
  it("production은 info이고 개발·테스트는 debug다", () => {
    expect(defaultLogLevel("production")).toBe("info");
    expect(defaultLogLevel("development")).toBe("debug");
    expect(defaultLogLevel("test")).toBe("debug");
  });
});

// 디버그 레벨로 오래 운용하려면 보존 기간이 짧고 정리가 주기적으로 돌아야 한다(#58).
describe("로그 보존", () => {
  it("기본 보존 기간은 3일이다", () => {
    delete process.env.WEB_AGENT_MANAGER_LOG_KEEP_DAYS;
    delete process.env.MYAGENT_LOG_KEEP_DAYS;
    expect(keepDays()).toBe(3);
  });

  it("환경변수로 보존 기간을 늘릴 수 있다", () => {
    process.env.WEB_AGENT_MANAGER_LOG_KEEP_DAYS = "10";
    expect(keepDays()).toBe(10);
  });

  it("이상한 값이면 기본값으로 되돌린다", () => {
    for (const value of ["0", "-5", "abc", ""]) {
      process.env.WEB_AGENT_MANAGER_LOG_KEEP_DAYS = value;
      expect(keepDays()).toBe(3);
    }
  });

  it("기준 시각보다 오래된 날짜 로그만 지운다", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-log-prune-"));
    temporaryDirectories.push(directory);
    const names = ["server-2026-08-10.log", "client-2026-08-10.log", "server-2026-08-20.log", "client-2026-08-21.log"];
    for (const name of names) fs.writeFileSync(path.join(directory, name), "x");
    // 로그가 아닌 파일은 형식이 달라 건드리면 안 된다.
    fs.writeFileSync(path.join(directory, "keep-me.txt"), "x");
    fs.writeFileSync(path.join(directory, "server.pid"), "x");

    pruneLogsIn(directory, new Date("2026-08-19T00:00:00Z").getTime());

    expect(fs.readdirSync(directory).sort()).toEqual([
      "client-2026-08-21.log", "keep-me.txt", "server-2026-08-20.log", "server.pid",
    ]);
  });

  it("없는 디렉터리를 지워도 예외로 죽지 않는다", () => {
    expect(() => pruneLogsIn(path.join(os.tmpdir(), "web-agent-manager-missing-dir-xyz"), Date.now())).not.toThrow();
  });
});
