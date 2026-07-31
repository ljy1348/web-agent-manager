import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

// 테스트용 임시 릴리즈 디렉터리를 만들고 종료 시 정리 대상으로 등록한다.
function createTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wam-checksums-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("릴리즈 체크섬", () => {
  it("파일명을 정렬하고 출력 파일 자체는 제외한다", () => {
    const directory = createTemporaryDirectory();
    fs.writeFileSync(path.join(directory, "b.zip"), "두 번째");
    fs.writeFileSync(path.join(directory, "a.zip"), "첫 번째");

    const script = path.resolve("scripts/create-release-checksums.mjs");
    execFileSync(process.execPath, [script, directory]);
    const first = fs.readFileSync(path.join(directory, "SHA256SUMS"), "utf8");
    execFileSync(process.execPath, [script, directory]);

    expect(fs.readFileSync(path.join(directory, "SHA256SUMS"), "utf8")).toBe(first);
    expect(first.split("\n").filter(Boolean).map((line) => line.slice(66))).toEqual(["a.zip", "b.zip"]);
  });
});
