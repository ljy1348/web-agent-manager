import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDeterministicCheck } from "../src/server/experiments/deterministic-check";

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-check-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

describe("결정적 검사", () => {
  it("통과·실패를 종료 코드로 구분하고 출력을 남긴다", async () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "ok.js"), "console.log('테스트 통과');\n");
    fs.writeFileSync(path.join(root, "bad.js"), "console.error('단언 실패');\nprocess.exit(3);\n");

    const passed = await runDeterministicCheck(["node", "ok.js"], root);
    expect(passed).toMatchObject({ status: "passed", exitCode: 0 });
    expect(passed.output).toContain("테스트 통과");

    const failed = await runDeterministicCheck(["node", "bad.js"], root);
    expect(failed).toMatchObject({ status: "failed", exitCode: 3 });
    expect(failed.output).toContain("단언 실패");
  });

  it("명령이 없으면 skipped, 실행 자체가 불가하면 error로 구분한다", async () => {
    const root = workspace();
    expect(await runDeterministicCheck([], root)).toMatchObject({ status: "skipped", exitCode: null });

    // 실행 파일이 없는 것은 산출물 결함이 아니라 fixture 환경 문제이므로 failed와 구분해야 한다.
    const missing = await runDeterministicCheck(["wam-존재하지-않는-명령"], root);
    expect(missing.status).toBe("error");
    expect(missing.exitCode).toBeNull();
  });

  it("시간 초과를 실패가 아닌 error로 표시한다", async () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "slow.js"), "setTimeout(() => {}, 60_000);\n");
    const result = await runDeterministicCheck(["node", "slow.js"], root, { timeoutMs: 300 });
    expect(result.status).toBe("error");
    expect(result.output).toContain("시간 초과");
  });

  it("shell 연산자를 인자로 넘겨도 해석하지 않는다", async () => {
    const root = workspace();
    const canary = path.join(root, "canary.txt");
    fs.writeFileSync(canary, "지워지면 안 된다");
    // shell이 없으므로 "&&"와 rm은 echo의 인자일 뿐이다.
    const result = await runDeterministicCheck(["node", "-e", "console.log(process.argv.slice(1).join(' '))", "&&", "rm", canary], root);
    expect(result.status).toBe("passed");
    expect(result.output).toContain("&& rm");
    expect(fs.existsSync(canary)).toBe(true);
  });
});
