import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// PATH에서 명령 절대경로를 찾아 supervisor 테스트용 최소 bin에 심볼릭 링크한다.
function resolveCommand(command: string): string {
  const result = spawnSync("bash", ["-lc", `command -v ${command}`], { encoding: "utf8" });
  const found = result.stdout.trim();
  if (result.status !== 0 || !found) throw new Error(`${command} 명령을 찾지 못했다`);
  return found;
}

// curl이 없는 PATH를 만들기 위해 필요한 명령만 복사한 bin 디렉터리를 준비한다.
function makeBinWithoutCurl(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  for (const command of ["date", "tee", "mkdir", "sleep", "rm", "cat", "touch", "dirname", "pwd"]) {
    const destination = path.join(binDir, command);
    if (existsSync(destination)) continue;
    symlinkSync(resolveCommand(command), destination);
  }
}

// 테스트용 임시 포트를 하나 빌려 바로 닫고 번호를 반환한다.
async function allocatePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("임시 포트를 할당하지 못했다"));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
    server.on("error", reject);
  });
}

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

  it("curl이 PATH에 없어도 헬스에 응답하는 서버를 기동 실패로 죽이지 않는다", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wam supervisor curl "));
    const scripts = path.join(root, "scripts");
    const bin = path.join(root, "bin");
    const entryDir = path.join(root, "dist/server/src/server");
    const runDir = path.join(root, "run");
    const target = path.join(scripts, "run-server-supervised.sh");
    mkdirSync(scripts, { recursive: true });
    mkdirSync(entryDir, { recursive: true });
    mkdirSync(runDir, { recursive: true });
    makeBinWithoutCurl(bin);
    copyFileSync("scripts/run-server-supervised.sh", target);
    chmodSync(target, 0o755);
    writeFileSync(path.join(root, "package.json"), "{}\n");
    writeFileSync(path.join(entryDir, "index.js"), [
      'const http = require("http");',
      "const port = Number(process.env.WEB_AGENT_MANAGER_PORT);",
      "http.createServer((req, res) => {",
      '  if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }',
      "  res.writeHead(404); res.end();",
      "}).listen(port, \"127.0.0.1\");",
      "",
    ].join("\n"));

    const port = await allocatePort();
    const child = spawn(resolveCommand("bash"), [target], {
      cwd: root,
      env: {
        PATH: bin,
        WAM_APP_DIR: root,
        WAM_RUN_DIR: runDir,
        WAM_NODE_BIN: process.execPath,
        WAM_HEALTH_INTERVAL: "1",
        WAM_STARTUP_TIMEOUT: "3",
        WAM_HEALTH_FAIL_LIMIT: "2",
        WAM_RESTART_DELAY: "1",
        WEB_AGENT_MANAGER_PORT: String(port),
      },
    });
    let output = "";
    child.stdout?.on("data", (chunk) => { output += String(chunk); });
    child.stderr?.on("data", (chunk) => { output += String(chunk); });
    child.on("error", (error) => { output += String(error); });
    try {
      await new Promise((resolve) => setTimeout(resolve, 4500));
      const logFile = path.join(runDir, "server.log");
      if (existsSync(logFile)) output += readFileSync(logFile, "utf8");
      expect(output).toContain("헬스 응답 확인");
      expect(output).not.toContain("헬스가 열리지 않아");
      expect(output).not.toContain("정리 후 재시작한다");
    } finally {
      writeFileSync(path.join(runDir, "server.stop"), "");
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          resolve(undefined);
        }, 2000);
        child.once("exit", () => {
          clearTimeout(timeout);
          resolve(undefined);
        });
      });
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
