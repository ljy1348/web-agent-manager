import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderCliBackupService } from "../src/server/services/provider-cli-backup";

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-cli-backup-"));
  roots.push(root);
  const dataDir = path.join(root, "data");
  const homeDir = path.join(root, "home");
  const binDir = path.join(root, "bin");
  fs.mkdirSync(dataDir); fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true }); fs.mkdirSync(binDir);
  const oldBinary = path.join(root, "codex-v1");
  const newBinary = path.join(root, "codex-v2");
  fs.writeFileSync(oldBinary, "binary-v1"); fs.chmodSync(oldBinary, 0o755);
  fs.writeFileSync(newBinary, "binary-v2"); fs.chmodSync(newBinary, 0o755);
  const command = path.join(binDir, "codex");
  fs.symlinkSync(oldBinary, command);
  fs.writeFileSync(path.join(homeDir, ".codex/config.toml"), "model='old'\n");
  fs.writeFileSync(path.join(homeDir, ".codex/auth.json"), "secret-token");
  return { root, dataDir, homeDir, oldBinary, newBinary, command };
}

describe("provider CLI backup", () => {
  it("versioned symlink binary와 credential 제외 설정을 hash manifest로 백업·복원한다", () => {
    const item = fixture();
    const service = new ProviderCliBackupService(item.dataDir, item.homeDir, () => item.command);
    const manifest = service.prepare("12345678", "codex", "codex");
    expect(manifest).toMatchObject({ schemaVersion: 1, provider: "codex", command: "codex", commandWasSymlink: true, excludedCredentialFiles: true });
    expect(manifest.files.map((file) => [file.kind, file.sourceRelative])).toEqual([["binary", ""], ["config", ".codex/config.toml"]]);
    expect(JSON.stringify(manifest)).not.toContain(item.root);
    expect(JSON.stringify(manifest)).not.toContain("auth.json");

    fs.unlinkSync(item.command); fs.symlinkSync(item.newBinary, item.command);
    fs.writeFileSync(path.join(item.homeDir, ".codex/config.toml"), "model='new'\n");
    fs.writeFileSync(path.join(item.homeDir, ".codex/auth.json"), "rotated-secret");
    service.restore("12345678", manifest);

    expect(fs.readFileSync(fs.realpathSync(item.command), "utf8")).toBe("binary-v1");
    expect(fs.readFileSync(path.join(item.homeDir, ".codex/config.toml"), "utf8")).toBe("model='old'\n");
    expect(fs.readFileSync(path.join(item.homeDir, ".codex/auth.json"), "utf8")).toBe("rotated-secret");
  });

  it("backup이 변조되면 command/config를 건드리기 전에 복구를 거부한다", () => {
    const item = fixture();
    const service = new ProviderCliBackupService(item.dataDir, item.homeDir, () => item.command);
    const manifest = service.prepare("abcdef12", "codex", "codex");
    fs.writeFileSync(path.join(item.dataDir, "provider-cli-backups/abcdef12/cli-binary"), "tampered");
    fs.unlinkSync(item.command); fs.symlinkSync(item.newBinary, item.command);

    expect(() => service.restore("abcdef12", manifest)).toThrow("hash 검증");
    expect(fs.realpathSync(item.command)).toBe(item.newBinary);
  });
});
