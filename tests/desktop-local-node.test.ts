import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { readSavedMode, saveMode, detectAddresses, normalizeLocalConfig, readLocalConfig, saveLocalConfig, bundledNode } = require("../electron/local-node.cjs");

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function userData(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wam-desktop-local-"));
  dirs.push(dir);
  return dir;
}

describe("Windows 데스크톱 로컬 모드 설정 (#156)", () => {
  it("모드는 local·remote만 저장하고 없으면 첫 실행(null)이다", () => {
    const dir = userData();
    expect(readSavedMode(dir)).toBeNull();
    saveMode(dir, "local");
    expect(readSavedMode(dir)).toBe("local");
    expect(() => saveMode(dir, "other")).toThrow();
  });

  it("접속 주소 후보는 Tailscale → 사설망 순서이고 루프백·공인·IPv6는 뺀다", () => {
    expect(detectAddresses({
      lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
      eth0: [{ family: "IPv4", address: "192.168.0.21", internal: false }, { family: "IPv6", address: "fe80::1", internal: false }],
      tailscale0: [{ family: "IPv4", address: "100.100.20.30", internal: false }],
      wan: [{ family: "IPv4", address: "8.8.8.8", internal: false }],
    })).toEqual(["100.100.20.30", "192.168.0.21"]);
  });

  it("이 PC 전용은 127.0.0.1, 외부 허용은 0.0.0.0에 Tailscale·사설 주소만 받는다", () => {
    const dir = userData();
    expect(normalizeLocalConfig({ port: 4317, allowNetwork: false }, dir)).toEqual({ host: "127.0.0.1", port: 4317, publicUrl: "http://127.0.0.1:4317", dataDir: path.join(dir, "data") });
    expect(normalizeLocalConfig({ port: 4400, allowNetwork: true, address: "100.100.20.30" }, dir)).toMatchObject({ host: "0.0.0.0", publicUrl: "http://100.100.20.30:4400" });
    expect(() => normalizeLocalConfig({ port: 4317, allowNetwork: true, address: "8.8.8.8" }, dir)).toThrow(/Tailscale/);
    expect(() => normalizeLocalConfig({ port: 80 }, dir)).toThrow(/포트/);
  });

  it("데이터 폴더는 저장하지 않고 항상 userData 기준으로 계산한다", () => {
    const dir = userData();
    saveLocalConfig(dir, normalizeLocalConfig({ port: 4317, allowNetwork: true, address: "100.100.20.30" }, dir));
    expect(JSON.parse(fs.readFileSync(path.join(dir, "local-node.json"), "utf8"))).toEqual({ host: "0.0.0.0", port: 4317, publicUrl: "http://100.100.20.30:4317" });
    expect(readLocalConfig(dir)?.dataDir).toBe(path.join(dir, "data"));
  });

  it("함께 넣은 node.exe는 Windows에서 파일이 있을 때만 쓴다", () => {
    const resources = userData();
    expect(bundledNode(resources, "win32")).toBeNull();
    fs.mkdirSync(path.join(resources, "node"));
    fs.writeFileSync(path.join(resources, "node", "node.exe"), "");
    expect(bundledNode(resources, "win32")).toBe(path.join(resources, "node", "node.exe"));
    expect(bundledNode(resources, "linux")).toBeNull();
  });
});
