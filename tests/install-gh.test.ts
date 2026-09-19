import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const cleanup: string[] = [];

afterEach(() => {
  while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

// install.sh에서 최상위 함수 정의만 잘라낸다.
function extractBashFunction(source: string, name: string): string {
  const match = source.match(new RegExp(`${name}\\(\\) \\{[\\s\\S]*?\\n\\}`));
  if (!match) throw new Error(`${name} 함수를 찾지 못했다`);
  return match[0];
}

// apt 설치를 막고 가짜 gh만 보이게 한 채 ensure_gh만 실행한다.
function runEnsureGh(ghHelp: string) {
  const root = mkdtempSync(path.join(tmpdir(), "wam-gh-"));
  cleanup.push(root);
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    path.join(bin, "gh"),
    `#!/usr/bin/env bash\nif [[ "\${1:-}" == "auth" && "\${2:-}" == "login" && "\${3:-}" == "--help" ]]; then\ncat <<'EOF'\n${ghHelp}\nEOF\nexit 0\nfi\nexit 0\n`,
  );
  chmodSync(path.join(bin, "gh"), 0o755);
  const source = readFileSync("packaging/install.sh", "utf8");
  const harness = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "can_apt_install() { return 1; }",
    extractBashFunction(source, "ensure_gh"),
    "ensure_gh",
    "printf 'ensure-gh-ok\\n'",
    "",
  ].join("\n");
  const script = path.join(root, "ensure-gh.sh");
  writeFileSync(script, harness);
  chmodSync(script, 0o755);
  return spawnSync("bash", [script], {
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
  });
}

describe("packaging/install.sh GitHub CLI 버전 검사", () => {
  it("--skip-ssh-key가 없는 구버전 gh면 설치를 성공으로 끝내지 않는다", () => {
    const result = runEnsureGh("USAGE\n  gh auth login [flags]\n");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/오래되어|최신 버전/);
    expect(result.stdout).not.toContain("ensure-gh-ok");
  });

  it("--skip-ssh-key를 지원하면 통과한다", () => {
    const result = runEnsureGh("USAGE\n  gh auth login [flags]\n      --skip-ssh-key\n");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("ensure-gh-ok");
  });
});
