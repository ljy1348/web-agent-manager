import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import type { AppDatabase } from "../src/server/core/database";
import { createToolRouter, parseCatalogKinds } from "../src/server/routes/tool-routes";

const originalPath = process.env.PATH;
const temporaryDirectories: string[] = [];
let closeServer: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
  process.env.PATH = originalPath;
  while (temporaryDirectories.length) fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

// 실행되면 흔적 파일을 남기는 가짜 claude·codex·grok을 PATH 맨 앞에 둔다.
function installFakeClis(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wam-tool-catalog-"));
  temporaryDirectories.push(directory);
  const marker = path.join(directory, "invoked.log");
  for (const name of ["claude", "codex", "grok"]) {
    const script = path.join(directory, name);
    fs.writeFileSync(script, `#!/bin/sh\necho "${name} $*" >> "${marker}"\necho "fake-${name}-mcp: npx fake - ✓ Connected"\n`, { mode: 0o755 });
  }
  process.env.PATH = `${directory}${path.delimiter}${originalPath}`;
  return marker;
}

// 카탈로그 라우터가 조회하는 프로젝트 경로만 응답하는 DB 대역이다.
function stubDatabase(projectPath: string): AppDatabase {
  return {
    prepare: (sql: string) => ({ get: () => (sql.includes("SELECT path FROM projects") ? { path: projectPath } : undefined), run: () => undefined, all: () => [] }),
    transaction: (fn: () => void) => fn,
  } as unknown as AppDatabase;
}

async function startCatalogApi(projectPath: string): Promise<string> {
  const app = express();
  app.use(createToolRouter(stubDatabase(projectPath)));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  closeServer = () => new Promise((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

// 채팅 명령어 자동완성이 느린 MCP 상태 점검을 기다리지 않아야 한다(#123).
describe("도구 카탈로그 종류 한정", () => {
  it("kinds 값을 알려진 종류로만 해석하고 비었거나 모르는 값이면 전체로 본다", () => {
    expect([...parseCatalogKinds("commands, skills")!]).toEqual(["commands", "skills"]);
    expect(parseCatalogKinds("bogus")).toBeNull();
    expect(parseCatalogKinds("")).toBeNull();
    expect(parseCatalogKinds(undefined)).toBeNull();
  });

  it("명령어·스킬만 요청하면 CLI MCP 조회를 하지 않고 두 종류만 돌려준다", async () => {
    const marker = installFakeClis();
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "wam-tool-project-"));
    temporaryDirectories.push(projectPath);
    const base = await startCatalogApi(projectPath);
    const response = await fetch(`${base}/tools/catalog?projectId=1&kinds=commands,skills`);
    const { items } = await response.json() as { items: Array<{ kind: string }> };
    expect(response.status).toBe(200);
    expect(items.length).toBeGreaterThan(0);
    expect(new Set(items.map((item) => item.kind))).toEqual(new Set(["commands", "skills"]));
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("종류를 지정하지 않은 도구 탭 요청은 기존처럼 CLI MCP까지 조회한다", async () => {
    const marker = installFakeClis();
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "wam-tool-project-all-"));
    temporaryDirectories.push(projectPath);
    const base = await startCatalogApi(projectPath);
    const response = await fetch(`${base}/tools/catalog?projectId=1`);
    const { items } = await response.json() as { items: Array<{ kind: string }> };
    expect(items.some((item) => item.kind === "commands")).toBe(true);
    expect(fs.readFileSync(marker, "utf8")).toContain("claude mcp list");
  });
});
