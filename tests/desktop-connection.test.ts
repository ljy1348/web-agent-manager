import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { normalizeServerUrl, isUnencryptedPublic, readSavedServer, saveServer, probeServer } = require("../electron/connection.cjs");

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

// 경로별 응답을 정해 둔 테스트 HTTP 서버.
async function serve(routes: Record<string, { status: number; body: string }>): Promise<string> {
  const server = http.createServer((request, response) => {
    const route = routes[request.url ?? ""];
    response.writeHead(route?.status ?? 404, { "Content-Type": "application/json" });
    response.end(route?.body ?? "{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe("desktop relay-mode connection (#139)", () => {
  it("normalizes addresses to an origin and rejects paths, credentials and other schemes", () => {
    expect(normalizeServerUrl(" 100.101.102.103:14003 ")).toBe("http://100.101.102.103:14003");
    expect(normalizeServerUrl("https://wam.example.com/")).toBe("https://wam.example.com");
    for (const bad of ["https://wam.example.com/app", "https://user:pw@wam.example.com", "https://wam.example.com/?token=x", "ftp://wam.example.com", "http://"]) {
      expect(() => normalizeServerUrl(bad)).toThrow();
    }
  });

  it("warns only for plain HTTP to public addresses", () => {
    for (const safe of ["https://wam.example.com", "http://localhost:14003", "http://127.0.0.1:1", "http://10.0.0.2", "http://172.20.0.1", "http://192.168.0.21:14003", "http://100.88.12.4:14003", "http://[fd00::1]:1"]) {
      expect(isUnencryptedPublic(safe)).toBe(false);
    }
    for (const risky of ["http://8.8.8.8", "http://100.128.0.1", "http://wam.example.com", "http://172.32.0.1"]) expect(isUnencryptedPublic(risky)).toBe(true);
  });

  it("saves only the normalized address and ignores broken config", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wam-desktop-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    expect(readSavedServer(dir)).toBeNull();
    saveServer(dir, "https://wam.example.com/");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "connection.json"), "utf8"))).toEqual({ serverUrl: "https://wam.example.com" });
    expect(fs.statSync(path.join(dir, "connection.json")).mode & 0o777).toBe(0o600);
    expect(readSavedServer(dir)).toBe("https://wam.example.com");
    fs.writeFileSync(path.join(dir, "connection.json"), "{broken");
    expect(readSavedServer(dir)).toBeNull();
  });

  it("accepts only servers that answer like a WAM", async () => {
    const wam = await serve({ "/health": { status: 200, body: "{\"ok\":true}" }, "/api/auth/setup-status": { status: 200, body: "{\"setupRequired\":false}" } });
    await expect(probeServer(wam)).resolves.toEqual({ setupRequired: false });
    const other = await serve({ "/health": { status: 200, body: "ok" } });
    await expect(probeServer(other)).rejects.toThrow(/WAM 서버가 아니거나/);
    const down = await serve({});
    await expect(probeServer(down)).rejects.toThrow(/WAM 서버가 아닙니다/);
    await expect(probeServer("http://127.0.0.1:1", fetch, 1000)).rejects.toThrow(/연결할 수 없습니다/);
  });
});
