import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSecretInput } from "../src/server/core/secret-input";

const roots: string[] = [];
const options = {
  valueEnvironment: "WAM_TEST_SECRET_VALUE",
  fileEnvironment: "WAM_TEST_SECRET_FILE",
  label: "테스트 secret",
  minimumLength: 12,
  maximumLength: 64,
};

afterEach(() => {
  vi.unstubAllEnvs();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "wam-secret-input-"));
  roots.push(value);
  return value;
}

describe("owner-only secret input", () => {
  it("0600 absolute file의 마지막 개행 하나만 제거해 읽는다", () => {
    const file = path.join(root(), "secret");
    fs.writeFileSync(file, "owner-only-secret\n", { mode: 0o600 });
    vi.stubEnv(options.fileEnvironment, file);
    expect(readSecretInput(options)).toBe("owner-only-secret");
  });

  it("symlink·열린 권한·relative path를 원문 읽기 전에 거부한다", () => {
    const directory = root();
    const target = path.join(directory, "target");
    const link = path.join(directory, "link");
    fs.writeFileSync(target, "owner-only-secret", { mode: 0o600 });
    fs.symlinkSync(target, link);
    vi.stubEnv(options.fileEnvironment, link);
    expect(() => readSecretInput(options)).toThrow(/symlink/);

    vi.stubEnv(options.fileEnvironment, target);
    fs.chmodSync(target, 0o640);
    expect(() => readSecretInput(options)).toThrow(/owner/);

    vi.stubEnv(options.fileEnvironment, "relative-secret");
    expect(() => readSecretInput(options)).toThrow(/absolute/);
  });

  it("직접 값과 파일의 동시 설정 및 내부 줄바꿈을 거부한다", () => {
    const file = path.join(root(), "secret");
    fs.writeFileSync(file, "owner-only-secret", { mode: 0o600 });
    vi.stubEnv(options.valueEnvironment, "direct-secret-value");
    vi.stubEnv(options.fileEnvironment, file);
    expect(() => readSecretInput(options)).toThrow(/동시에/);

    vi.stubEnv(options.fileEnvironment, undefined);
    vi.stubEnv(options.valueEnvironment, "secret-line-1\nsecret-line-2");
    expect(() => readSecretInput(options)).toThrow(/줄바꿈/);
  });
});
