import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const cleanup: string[] = [];

afterEach(() => {
  while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

// systemd 설치 스크립트를 실제 시스템 경로에 쓰지 않고 돌리기 위한 스텁 bin을 만든다.
function createStubBin(root: string, options: { activeExit?: number } = {}) {
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "id"), "#!/usr/bin/env bash\nif [[ \"${1:-}\" == \"-u\" ]]; then printf '0\\n'; exit 0; fi\nexit 1\n");
  writeFileSync(path.join(bin, "useradd"), "#!/usr/bin/env bash\nexit 0\n");
  writeFileSync(path.join(bin, "chown"), "#!/usr/bin/env bash\nexit 0\n");
  writeFileSync(
    path.join(bin, "systemctl"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> "${path.join(root, "systemctl.log")}"`,
      `if [[ "\${1:-}" == "is-active" ]]; then exit ${options.activeExit ?? 0}; fi`,
      "exit 0",
      "",
    ].join("\n"),
  );
  for (const name of ["id", "useradd", "chown", "systemctl"]) chmodSync(path.join(bin, name), 0o755);
  return bin;
}

// 릴리즈 zip처럼 packaging/이 평탄화된 디렉터리에서 install-systemd.sh를 실행한다.
function runInstallSystemd(root: string, bin: string) {
  const envDir = path.join(root, "env");
  const unitFile = path.join(root, "web-agent-manager.service.installed");
  return spawnSync("bash", [path.join(root, "install-systemd.sh")], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      WEB_AGENT_MANAGER_ENV_DIR: envDir,
      WEB_AGENT_MANAGER_UNIT_FILE: unitFile,
      WEB_AGENT_MANAGER_SYSTEMD_WAIT: "0",
    },
  });
}

describe("packaging/install-systemd.sh 릴리즈 zip·기동 확인", () => {
  it("평탄화된 zip 레이아웃에서 packaging/·deploy/·.env.example 없이도 유닛과 env를 만든다", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wam-systemd-zip-"));
    cleanup.push(root);
    writeFileSync(path.join(root, "package.json"), '{"name":"web-agent-manager","version":"0.0.0"}\n');
    writeFileSync(path.join(root, "install.sh"), "#!/usr/bin/env bash\nprintf 'install-ok\\n'\n");
    chmodSync(path.join(root, "install.sh"), 0o755);
    writeFileSync(path.join(root, "install-systemd.sh"), readFileSync("packaging/install-systemd.sh"));
    chmodSync(path.join(root, "install-systemd.sh"), 0o755);
    const result = runInstallSystemd(root, createStubBin(root));
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("install-ok");
    expect(result.stdout).toContain("설치 완료");
    const unit = readFileSync(path.join(root, "web-agent-manager.service.installed"), "utf8");
    expect(unit).toContain(`WorkingDirectory=${root}`);
    expect(unit).toContain(`${root}/dist/server/src/server/index.js`);
    expect(readFileSync(path.join(root, "env/web-agent-manager.env"), "utf8")).toContain("WEB_AGENT_MANAGER_PORT=");
  });

  it("systemctl is-active가 실패하면 설치 완료를 출력하지 않고 종료 코드 1로 멈춘다", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wam-systemd-dead-"));
    cleanup.push(root);
    writeFileSync(path.join(root, "package.json"), '{"name":"web-agent-manager","version":"0.0.0"}\n');
    writeFileSync(path.join(root, "install.sh"), "#!/usr/bin/env bash\nprintf 'install-ok\\n'\n");
    chmodSync(path.join(root, "install.sh"), 0o755);
    writeFileSync(path.join(root, "install-systemd.sh"), readFileSync("packaging/install-systemd.sh"));
    chmodSync(path.join(root, "install-systemd.sh"), 0o755);
    const result = runInstallSystemd(root, createStubBin(root, { activeExit: 1 }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("활성 상태가 아닙니다");
    expect(result.stdout + result.stderr).not.toContain("설치 완료");
  });
});
