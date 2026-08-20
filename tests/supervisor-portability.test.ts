import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("프로덕션 서버 supervisor 이식성", () => {
  it("특정 호스트 경로 없이 스크립트 위치를 기본 앱 폴더로 사용한다", () => {
    const source = readFileSync("scripts/run-server-supervised.sh", "utf8");
    expect(source).not.toContain("/home/ubuntu/myagent");
    expect(source).not.toContain("/root/.volta");

    const root = mkdtempSync(path.join(tmpdir(), "wam supervisor "));
    try {
      const scripts = path.join(root, "scripts");
      const target = path.join(scripts, "run-server-supervised.sh");
      mkdirSync(scripts, { recursive: true });
      copyFileSync("scripts/run-server-supervised.sh", target);
      chmodSync(target, 0o755);

      const result = spawnSync("bash", [target], {
        cwd: tmpdir(),
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", WAM_NODE_BIN: process.execPath },
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain(path.join(root, "dist/server/src/server/index.js"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("PATH의 node가 shim이어도 실제 process.execPath를 기본 실행 파일로 해석한다", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wam supervisor shim "));
    try {
      const scripts = path.join(root, "scripts");
      const fakeBin = path.join(root, "bin");
      const marker = path.join(root, "node-args.txt");
      const target = path.join(scripts, "run-server-supervised.sh");
      const fakeNode = path.join(fakeBin, "node");
      mkdirSync(scripts, { recursive: true });
      mkdirSync(fakeBin, { recursive: true });
      copyFileSync("scripts/run-server-supervised.sh", target);
      writeFileSync(fakeNode, "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" > \"$WAM_NODE_MARKER\"\nprintf '%s\\n' \"$WAM_REAL_NODE\"\n");
      chmodSync(target, 0o755);
      chmodSync(fakeNode, 0o755);

      const result = spawnSync("bash", [target], {
        cwd: tmpdir(),
        encoding: "utf8",
        env: {
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          WAM_NODE_MARKER: marker,
          WAM_REAL_NODE: process.execPath,
        },
      });

      expect(result.status).toBe(1);
      expect(readFileSync(marker, "utf8").trim()).toBe("-p process.execPath");
      expect(result.stdout).toContain(path.join(root, "dist/server/src/server/index.js"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
