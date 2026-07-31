import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthenticatedRequest } from "../src/server/core/auth";
import type { AppDatabase } from "../src/server/core/database";
import { createInstructionRouter } from "../src/server/routes/instruction-routes";

let closeServer: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
});

// 지침 라우터가 조회하는 프로젝트 경로와 감사 로그만 응답한다.
function stubDatabase(projectPath: string): AppDatabase {
  return {
    prepare: (sql: string) => {
      if (sql.includes("SELECT path FROM projects")) return { get: () => ({ path: projectPath }) };
      return { get: () => undefined, run: () => undefined, all: () => [] };
    },
  } as unknown as AppDatabase;
}

// 인증 사용자를 주입한 테스트용 지침 API를 띄운다.
async function startInstructionApi(projectPath: string): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((request: AuthenticatedRequest, _response, next) => {
    request.authUser = { id: 1, username: "admin", role: "admin" };
    next();
  });
  app.use(createInstructionRouter(stubDatabase(projectPath)));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(400).json({ error: error instanceof Error ? error.message : "오류" });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  closeServer = () => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("지침 파일 통합 API", () => {
  it("프로젝트 CLAUDE.md가 AGENTS.md를 import하도록 생성하고 반복 호출은 중복하지 않는다", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-instructions-"));
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "## Claude 전용\n\nplan mode를 우선 사용합니다.\n", "utf8");
    const baseUrl = await startInstructionApi(root);

    const first = await fetch(`${baseUrl}/instructions/unify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "project", projectId: 1 }),
    });
    const second = await fetch(`${baseUrl}/instructions/unify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "project", projectId: 1 }),
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ saved: true, name: "CLAUDE.md" });
    await expect(second.json()).resolves.toMatchObject({ saved: false, name: "CLAUDE.md" });
    expect(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8")).toContain("공통 에이전트 지침");
    const claude = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
    expect(claude.match(/^@AGENTS\.md$/gm)).toHaveLength(1);
    expect(claude).toContain("plan mode를 우선 사용합니다.");
    fs.rmSync(root, { recursive: true, force: true });
  });
});
