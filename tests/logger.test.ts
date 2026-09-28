import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import type { Request, Response } from "express";
import { createRequestLogger, defaultLogLevel, forwardedClientHint, keepDays, listLogDates, parseLogQuery, pruneLogsIn, readLogLines, requestLogLevel } from "../src/server/core/logger";

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
  it("기본 보존 기간은 7일이다", () => {
    delete process.env.WEB_AGENT_MANAGER_LOG_KEEP_DAYS;
    delete process.env.MYAGENT_LOG_KEEP_DAYS;
    expect(keepDays()).toBe(7);
  });

  it("환경변수로 보존 기간을 늘릴 수 있다", () => {
    process.env.WEB_AGENT_MANAGER_LOG_KEEP_DAYS = "10";
    expect(keepDays()).toBe(10);
  });

  it("이상한 값이면 기본값으로 되돌린다", () => {
    for (const value of ["0", "-5", "abc", ""]) {
      process.env.WEB_AGENT_MANAGER_LOG_KEEP_DAYS = value;
      expect(keepDays()).toBe(7);
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

// 공격 추적을 위해 운영(info)에서도 모든 요청이 남아야 하고, 프록시 뒤 원 출처를 참고값으로 남긴다(#106).
describe("요청 로그", () => {
  it("성공 요청도 info로 남기고 4xx는 warn, 5xx는 error다", () => {
    expect(requestLogLevel(200)).toBe("info");
    expect(requestLogLevel(304)).toBe("info");
    expect(requestLogLevel(401)).toBe("warn");
    expect(requestLogLevel(503)).toBe("error");
  });

  it("첫 번째로 있는 프록시 전달 헤더를 원문 그대로 남긴다", () => {
    expect(forwardedClientHint({ "x-forwarded-for": "203.0.113.7, 10.0.0.1", "cf-connecting-ip": "198.51.100.2" })).toBe("cf-connecting-ip=198.51.100.2");
    expect(forwardedClientHint({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" })).toBe("x-forwarded-for=203.0.113.7, 10.0.0.1");
    expect(forwardedClientHint({ "user-agent": "curl" })).toBeUndefined();
  });

  it("헬스 체크 폴링은 기록하지 않고 다른 경로는 기록한다", () => {
    const logger = createRequestLogger();
    for (const [pathName, listeners] of [["/health", 0], ["/wp-login.php", 1]] as const) {
      const response = new EventEmitter();
      let passed = false;
      logger({ path: pathName, headers: {} } as Request, response as unknown as Response, () => { passed = true; });
      expect(passed).toBe(true);
      expect(response.listenerCount("finish")).toBe(listeners);
    }
  });

  it("위조된 긴 헤더는 잘라서 남긴다", () => {
    expect(forwardedClientHint({ "x-real-ip": "a".repeat(1000) })!.length).toBe(200);
  });
});

// 관리자가 화면에서, 연결 컴퓨터는 federation 중계로 같은 API를 통해 로그를 본다(#116).
describe("로그 조회", () => {
  const makeLogs = (): string => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-log-read-"));
    temporaryDirectories.push(directory);
    fs.writeFileSync(path.join(directory, "server-2026-09-25.log"), "old\n");
    fs.writeFileSync(path.join(directory, "server-2026-09-26.log"), [
      "2026-09-26T00:00:01.000Z INFO  [http] 요청 처리 {\"path\":\"/a\"}",
      "2026-09-26T00:00:02.000Z WARN  [http] 요청 거부 {\"path\":\"/api/.env\"}",
      "2026-09-26T00:00:03.000Z ERROR [server] API 오류 응답",
      "    at handler (index.js:1:1)",
      "2026-09-26T00:00:04.000Z DEBUG [state-check] busy",
      "2026-09-26T00:00:05.000Z INFO  [http] 요청 처리 {\"path\":\"/b\"}",
    ].join("\n") + "\n");
    fs.writeFileSync(path.join(directory, "client-2026-09-26.log"), "x\n");
    fs.writeFileSync(path.join(directory, "notes.txt"), "x");
    return directory;
  };

  it("날짜 형식이 아닌 값은 오늘로 바꿔 경로 조작을 막고 줄 수를 제한한다", () => {
    const query = parseLogQuery({ date: "../../secrets/fcm", kind: "../x", limit: "99999", level: "WARN", q: "ENV" }, "2026-09-26");
    expect(query).toEqual({ kind: "server", date: "2026-09-26", minLevel: "warn", search: "env", limit: 2000 });
    expect(parseLogQuery({}, "2026-09-26").limit).toBe(500);
  });

  it("해당 종류의 날짜 파일만 최신순으로 나열한다", () => {
    expect(listLogDates(makeLogs(), "server")).toEqual(["2026-09-26", "2026-09-25"]);
  });

  it("최소 레벨 이상만 남기고 스택 줄은 앞 줄 레벨을 따른다", async () => {
    const result = await readLogLines(makeLogs(), parseLogQuery({ date: "2026-09-26", level: "warn" }));
    expect(result.lines).toEqual([
      "2026-09-26T00:00:02.000Z WARN  [http] 요청 거부 {\"path\":\"/api/.env\"}",
      "2026-09-26T00:00:03.000Z ERROR [server] API 오류 응답",
      "    at handler (index.js:1:1)",
    ]);
  });

  it("검색어로 거르고 마지막 limit줄만 돌려준다", async () => {
    const directory = makeLogs();
    const searched = await readLogLines(directory, parseLogQuery({ date: "2026-09-26", q: "요청 처리" }));
    expect(searched.matched).toBe(2);
    const limited = await readLogLines(directory, parseLogQuery({ date: "2026-09-26", limit: "2" }));
    expect(limited.lines).toEqual(["2026-09-26T00:00:04.000Z DEBUG [state-check] busy", "2026-09-26T00:00:05.000Z INFO  [http] 요청 처리 {\"path\":\"/b\"}"]);
    expect(limited.truncated).toBe(true);
  });

  it("없는 날짜는 빈 결과와 날짜 목록을 돌려준다", async () => {
    const result = await readLogLines(makeLogs(), parseLogQuery({ date: "2026-01-01" }));
    expect(result.lines).toEqual([]);
    expect(result.dates).toEqual(["2026-09-26", "2026-09-25"]);
  });
});
