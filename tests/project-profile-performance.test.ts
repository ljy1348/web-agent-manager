import { performance } from "node:perf_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase } from "../src/server/core/database";
import { AgentPresetService } from "../src/server/services/agent-preset-service";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("project profile 응답 성능", () => {
  it("현재 8개 등록 프로젝트의 맞춤 초안을 1초 안에 일괄 계산한다", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wam-profile-perf-data-"));
    const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wam-profile-perf-projects-"));
    roots.push(dataDir, projectsRoot);
    const database = openDatabase({ dataDir } as AppConfig);
    const names = ["WSS-Server", "WSS-admin-web", "myagent", "geulmeok-frontend", "geulmeok-scrap", "resume", "스터디", "genshincalculator"];
    const ids: number[] = [];
    for (const name of names) {
      const projectPath = path.join(projectsRoot, name);
      fs.mkdirSync(projectPath, { recursive: true });
      fs.writeFileSync(path.join(projectPath, "AGENTS.md"), "test instructions");
      fs.writeFileSync(path.join(projectPath, "CLAUDE.md"), "@AGENTS.md\n");
      fs.writeFileSync(path.join(projectPath, "package.json"), JSON.stringify({ scripts: { verify: "vitest", "test:ui": "playwright", test: "vitest", build: "vite build", typecheck: "tsc" } }));
      if (name === "WSS-Server") fs.writeFileSync(path.join(projectPath, "gradlew"), "#!/bin/sh\n");
      if (name === "geulmeok-scrap") fs.writeFileSync(path.join(projectPath, "pyproject.toml"), "[project]\nname='scrap'\n");
      if (name === "resume") {
        fs.mkdirSync(path.join(projectPath, "job-automation"));
        fs.writeFileSync(path.join(projectPath, "job-automation/package.json"), "{}");
      }
      ids.push(Number(database.prepare("INSERT INTO projects(name, path) VALUES (?, ?)").run(name, projectPath).lastInsertRowid));
    }
    const service = new AgentPresetService(database);
    const started = performance.now();
    const drafts = ids.map((id) => service.draft(id, "codex", "implementation") as any);
    const elapsedMs = performance.now() - started;
    expect(drafts.map((draft) => draft.detected.recommendationId)).toHaveLength(8);
    expect(new Set(drafts.map((draft) => draft.detected.recommendationId)).size).toBe(8);
    expect(elapsedMs).toBeLessThan(1_000);
    database.close();
  });
});
