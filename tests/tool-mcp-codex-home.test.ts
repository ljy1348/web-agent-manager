import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase } from "../src/server/core/database";
import { createToolRouter } from "../src/server/routes/tool-routes";

// MCP 편집 화면이 WAM이 실행하는 Codex의 CODEX_HOME에 쓰는지 확인한다(#146).
describe("Codex MCP 설정 위치 (#146)", () => {
  it("사용자 범위 Codex MCP를 WAM의 CODEX_HOME/config.toml에 저장한다", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-codex-home-"));
    const codexHome = path.join(root, "install-home", ".codex");
    const dataDir = path.join(root, "data");
    fs.mkdirSync(dataDir);
    const database = openDatabase({ dataDir } as AppConfig);
    const projectRoot = path.join(root, "project");
    fs.mkdirSync(projectRoot);
    const projectId = Number(database.prepare("INSERT INTO projects(name, path) VALUES ('p', ?)").run(projectRoot).lastInsertRowid);
    database.prepare("INSERT INTO users(id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')").run();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).authUser = { id: 1, username: "admin", role: "admin", accessScope: "standard" }; next(); });
    app.use("/api", createToolRouter(database, undefined, codexHome));
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${address.port}/api/tools/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "codex", scope: "user", projectId, name: "docs", transport: "stdio", command: "node" }),
      });
      expect(response.status, await response.text()).toBe(201);
      expect(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8")).toContain("[mcp_servers.\"docs\"]");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      database.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
