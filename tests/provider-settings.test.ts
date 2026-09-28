import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import express, { type NextFunction, type Response } from "express";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase } from "../src/server/core/database";
import { requireAuth, requireCsrf, type AuthenticatedRequest } from "../src/server/core/auth";
import { authenticateFederationAgent, createFederationAgentToken, FederationService } from "../src/server/services/federation";
import { CredentialVault } from "../src/server/services/credential-vault";
import { ProviderSettingsService, windowsCompatibilityWarnings } from "../src/server/services/provider-settings";
import { createProviderSettingsRouter } from "../src/server/routes/provider-settings-routes";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

// 테스트용 홈 디렉터리에 파일을 만든다.
function put(home: string, relative: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(home, relative)), { recursive: true });
  fs.writeFileSync(path.join(home, relative), content);
}

function read(home: string, relative: string): string | undefined {
  try { return fs.readFileSync(path.join(home, relative), "utf8"); } catch { return undefined; }
}

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

// 메인 컴퓨터 역할의 홈: 동기화 대상과 제외 대상이 섞여 있다.
function mainHome(): string {
  const home = tempDir("wam-settings-main-");
  const wamSkill = tempDir("wam-skill-src-");
  put(wamSkill, "SKILL.md", "wam skill");
  put(home, ".claude/CLAUDE.md", "main claude rules");
  put(home, ".claude/.credentials.json", "{\"secret\":\"main\"}");
  put(home, ".claude/settings.json", JSON.stringify({ model: "main-model", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo main" }] }] } }));
  put(home, ".claude/skills/review/SKILL.md", "review skill");
  put(home, ".claude/skills/review/scripts/run.sh", "#!/bin/sh\necho hi\n");
  put(home, ".claude/skills/synced/cache/SKILL.md", "claude managed");
  fs.symlinkSync(wamSkill, path.join(home, ".claude/skills/web-agent-manager-delegate"));
  put(home, ".codex/AGENTS.md", "main codex rules");
  put(home, ".codex/auth.json", "{\"token\":\"main\"}");
  put(home, ".codex/config.toml", "model = \"main\"\n");
  put(home, ".codex/hooks.json", "{\"hooks\":{}}");
  put(home, ".codex/skills/.system/builtin/SKILL.md", "codex builtin");
  put(home, ".codex/skills/deploy/SKILL.md", "deploy skill");
  put(home, ".grok/hooks/web-agent-manager.json", "{\"main\":true}");
  put(home, ".grok/hooks/notify.json", "{\"hooks\":{}}");
  return home;
}

// 서브 컴퓨터 역할의 홈: 자체 설정·자격증명·WAM 훅이 이미 있다.
function subHome(): string {
  const home = tempDir("wam-settings-sub-");
  put(home, ".claude/CLAUDE.md", "sub claude rules");
  put(home, ".claude/.credentials.json", "{\"secret\":\"sub\"}");
  put(home, ".claude/settings.json", JSON.stringify({ model: "sub-model", permissions: { allow: ["Bash(ls)"] } }));
  put(home, ".claude/skills/old-skill/SKILL.md", "old");
  put(home, ".codex/AGENTS.override.md", "sub override");
  put(home, ".codex/auth.json", "{\"token\":\"sub\"}");
  put(home, ".codex/config.toml", "model = \"sub\"\n");
  put(home, ".codex/skills/.system/builtin/SKILL.md", "sub builtin");
  put(home, ".grok/hooks/web-agent-manager.json", "{\"sub\":true}");
  put(home, ".grok/hooks/stale.json", "{}");
  return home;
}

describe("provider settings backup and sync", () => {
  it("exports only instructions, user skills and user hooks", () => {
    const home = mainHome();
    const service = new ProviderSettingsService(tempDir("wam-settings-data-"), home);
    const paths = service.exportBundle(["claude", "codex", "grok"]).files.map((file) => file.path).sort();
    expect(paths).toEqual([
      ".claude/CLAUDE.md", ".claude/skills/review/SKILL.md", ".claude/skills/review/scripts/run.sh",
      ".codex/AGENTS.md", ".codex/hooks.json", ".codex/skills/deploy/SKILL.md", ".grok/hooks/notify.json",
    ]);
    expect(service.summary().find((item) => item.provider === "claude")).toMatchObject({ skills: ["review"], hooks: ["settings.json hooks.Stop"] });
  });

  it("mirrors a bundle, keeps credentials and machine-specific files, and restores the safety backup", () => {
    const source = new ProviderSettingsService(tempDir("wam-settings-data-"), mainHome());
    const subHomeDir = subHome();
    const target = new ProviderSettingsService(tempDir("wam-settings-data-"), subHomeDir);
    const result = target.apply(source.exportBundle(["claude", "codex", "grok"]), "before-sync");

    expect(read(subHomeDir, ".claude/CLAUDE.md")).toBe("main claude rules");
    expect(read(subHomeDir, ".claude/skills/review/scripts/run.sh")).toContain("echo hi");
    expect(read(subHomeDir, ".claude/skills/old-skill/SKILL.md")).toBeUndefined();
    const settings = JSON.parse(read(subHomeDir, ".claude/settings.json")!);
    expect(settings).toMatchObject({ model: "sub-model", permissions: { allow: ["Bash(ls)"] }, hooks: { Stop: expect.any(Array) } });
    expect(read(subHomeDir, ".codex/AGENTS.md")).toBe("main codex rules");
    expect(read(subHomeDir, ".codex/AGENTS.override.md")).toBeUndefined();
    expect(read(subHomeDir, ".grok/hooks/stale.json")).toBeUndefined();
    expect(read(subHomeDir, ".grok/hooks/notify.json")).toBe("{\"hooks\":{}}");
    // 자격증명·WAM 자체 훅·Codex 내장 스킬·config.toml은 그대로다.
    expect(read(subHomeDir, ".claude/.credentials.json")).toBe("{\"secret\":\"sub\"}");
    expect(read(subHomeDir, ".codex/auth.json")).toBe("{\"token\":\"sub\"}");
    expect(read(subHomeDir, ".codex/config.toml")).toBe("model = \"sub\"\n");
    expect(read(subHomeDir, ".codex/skills/.system/builtin/SKILL.md")).toBe("sub builtin");
    expect(read(subHomeDir, ".grok/hooks/web-agent-manager.json")).toBe("{\"sub\":true}");
    expect(result.backup.reason).toBe("before-sync");

    target.restore(result.backup.id);
    expect(read(subHomeDir, ".claude/CLAUDE.md")).toBe("sub claude rules");
    expect(read(subHomeDir, ".claude/skills/old-skill/SKILL.md")).toBe("old");
    expect(read(subHomeDir, ".claude/skills/review/SKILL.md")).toBeUndefined();
    expect(JSON.parse(read(subHomeDir, ".claude/settings.json")!)).toEqual({ model: "sub-model", permissions: { allow: ["Bash(ls)"] } });
    expect(read(subHomeDir, ".codex/AGENTS.override.md")).toBe("sub override");
    expect(read(subHomeDir, ".grok/hooks/stale.json")).toBe("{}");
    expect(target.listBackups().map((item) => item.reason)).toEqual(["before-restore", "before-sync"]);
  });

  it("leaves providers outside the bundle untouched and rejects paths outside the managed scope", () => {
    const subHomeDir = subHome();
    const target = new ProviderSettingsService(tempDir("wam-settings-data-"), subHomeDir);
    target.apply(new ProviderSettingsService(tempDir("wam-settings-data-"), mainHome()).exportBundle(["codex"]), "before-sync");
    expect(read(subHomeDir, ".claude/CLAUDE.md")).toBe("sub claude rules");
    expect(read(subHomeDir, ".grok/hooks/stale.json")).toBe("{}");
    const content = Buffer.from("x").toString("base64");
    for (const bad of [".claude/.credentials.json", ".claude/skills/../.credentials.json", ".claude/skills/review", ".grok/hooks/web-agent-manager.json", ".claude/skills/synced/a.md", "/etc/passwd"]) {
      expect(() => target.apply({ schemaVersion: 1, providers: ["claude", "grok"], files: [{ provider: bad.startsWith(".grok") ? "grok" : "claude", path: bad, content, mode: 0o600 }] }, "before-sync")).toThrow(/허용되지 않은 설정 경로/);
    }
    expect(read(subHomeDir, ".claude/.credentials.json")).toBe("{\"secret\":\"sub\"}");
  });

  it("reads and writes Codex settings under CODEX_HOME when it differs from the process HOME", () => {
    const mainProcessHome = tempDir("wam-settings-main-home-");
    const mainCodexHome = tempDir("wam-settings-main-codex-");
    put(mainCodexHome, "AGENTS.md", "codex home rules");
    put(mainCodexHome, "skills/deploy/SKILL.md", "deploy");
    put(mainProcessHome, ".codex/AGENTS.md", "wrong home");
    const bundle = new ProviderSettingsService(tempDir("wam-settings-data-"), mainProcessHome, mainCodexHome).exportBundle(["codex"]);
    expect(bundle.files.map((file) => [file.path, Buffer.from(file.content, "base64").toString()])).toEqual([[".codex/AGENTS.md", "codex home rules"], [".codex/skills/deploy/SKILL.md", "deploy"]]);
    const subProcessHome = tempDir("wam-settings-sub-home-");
    const subCodexHome = tempDir("wam-settings-sub-codex-");
    new ProviderSettingsService(tempDir("wam-settings-data-"), subProcessHome, subCodexHome).apply(bundle, "before-sync");
    expect(read(subCodexHome, "AGENTS.md")).toBe("codex home rules");
    expect(read(subCodexHome, "skills/deploy/SKILL.md")).toBe("deploy");
    expect(fs.existsSync(path.join(subProcessHome, ".codex"))).toBe(false);
  });

  it("warns about Linux-only hooks and shell scripts only when the target is Windows (#140)", () => {
    const home = tempDir("wam-settings-win-");
    put(home, ".claude/settings.json", JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "bash /home/me/notify.sh" }, { type: "command", command: "powershell -File C:\\hooks\\notify.ps1" }] }] } }));
    put(home, ".claude/skills/deploy/scripts/run.sh", "#!/bin/sh\n");
    put(home, ".claude/skills/deploy/SKILL.md", "deploy");
    put(home, ".codex/hooks.json", JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "/usr/local/bin/notify" }] }] } }));
    const bundle = new ProviderSettingsService(tempDir("wam-settings-data-"), home).exportBundle(["claude", "codex"]);
    const warnings = windowsCompatibilityWarnings(bundle);
    expect(warnings).toHaveLength(3);
    expect(warnings.join("\n")).toContain("bash /home/me/notify.sh");
    expect(warnings.join("\n")).toContain(".claude/skills/deploy/scripts/run.sh");
    expect(warnings.join("\n")).toContain("/usr/local/bin/notify");
    expect(warnings.join("\n")).not.toContain("powershell");
    const target = new ProviderSettingsService(tempDir("wam-settings-data-"), tempDir("wam-settings-target-"));
    expect(target.apply(bundle, "before-sync", "win32").warnings).toHaveLength(3);
    expect(target.apply(bundle, "before-sync", "linux").warnings).toEqual([]);
  });

  it("sends main settings only to follow-mode computers through the federation relay", async () => {
    const hubData = tempDir("wam-settings-hub-");
    const nodeData = tempDir("wam-settings-node-");
    const config = (dataDir: string): AppConfig => ({ rootDir: dataDir, homeDir: dataDir, dataDir, host: "127.0.0.1", port: 0, publicUrl: "http://127.0.0.1:9999", allowedRoots: [dataDir], sessionTtlHours: 1, runtimeEnabled: false, slack: {}, ntfy: { serverUrl: "https://ntfy.sh" } });
    const hubDb = openDatabase(config(hubData));
    const nodeDb = openDatabase(config(nodeData));
    for (const db of [hubDb, nodeDb]) db.prepare("INSERT INTO users(id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')").run();
    const subHomeDir = subHome();
    const nodeApp = express();
    nodeApp.use(authenticateFederationAgent(nodeDb));
    nodeApp.use("/api", requireAuth, requireCsrf);
    nodeApp.get("/api/federation/ping", (_request, response) => response.json({ protocol: 1 }));
    const federationUnused = new FederationService(nodeDb, new CredentialVault(nodeDb, nodeData), "http://127.0.0.1:9998");
    nodeApp.use("/api", createProviderSettingsRouter(nodeDb, new ProviderSettingsService(nodeData, subHomeDir), federationUnused));
    const server = http.createServer(nodeApp);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const federation = new FederationService(hubDb, new CredentialVault(hubDb, hubData), "http://127.0.0.1:9999");
    const hubApp = express();
    hubApp.use(express.json());
    hubApp.use((request: AuthenticatedRequest, _response: Response, next: NextFunction) => {
      request.authUser = { id: 1, username: "admin", role: "admin" } as AuthenticatedRequest["authUser"];
      request.authSession = { id: 1, csrfToken: "", expiresAt: "", temporary: false, reauthenticatedAt: null };
      next();
    });
    hubApp.use("/api", createProviderSettingsRouter(hubDb, new ProviderSettingsService(hubData, mainHome()), federation));
    hubApp.use((error: Error & { statusCode?: number }, _request: express.Request, response: Response, _next: NextFunction) => response.status(error.statusCode ?? 500).json({ error: error.message }));
    const hub = http.createServer(hubApp);
    await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", resolve));
    const hubUrl = `http://127.0.0.1:${(hub.address() as { port: number }).port}`;
    try {
      const node = await federation.add("sub", `http://127.0.0.1:${address.port}/`, createFederationAgentToken(nodeDb, 1), 1);
      expect(federation.list()[0].settings_mode).toBe("independent");
      const refused = await fetch(`${hubUrl}/api/federation/nodes/${node.id}/provider-settings/sync`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      expect(refused.status).toBe(409);
      expect(read(subHomeDir, ".claude/CLAUDE.md")).toBe("sub claude rules");

      const mode = await fetch(`${hubUrl}/api/federation/nodes/${node.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settingsMode: "follow" }) });
      expect(mode.status).toBe(200);
      const synced = await fetch(`${hubUrl}/api/federation/nodes/${node.id}/provider-settings/sync`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providers: ["claude"] }) });
      expect(synced.status).toBe(200);
      expect(await synced.json()).toMatchObject({ sentFiles: 3, backup: { reason: "before-sync" } });
      expect(read(subHomeDir, ".claude/CLAUDE.md")).toBe("main claude rules");
      expect(read(subHomeDir, ".codex/AGENTS.override.md")).toBe("sub override");
      // 서브의 백업 목록도 중계 경로로 조회할 수 있다.
      const backups = await federation.request(node.id, "/provider-settings/backups");
      expect(JSON.parse(Buffer.from(backups.body).toString()).backups).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => hub.close(() => resolve()));
      hubDb.close(); nodeDb.close();
    }
  });
});
