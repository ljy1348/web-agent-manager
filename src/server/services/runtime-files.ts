import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../core/config";

export interface RuntimeFiles {
  hookToken: string;
  claudeSettingsFile: string;
  hookEnvironment: Record<string, string>;
}

// 앱 내부 훅 인증 토큰을 처음 한 번만 생성하고 권한을 제한한다.
function loadOrCreateHookToken(dataDir: string): string {
  const file = path.join(dataDir, "hook-token");
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString("base64url"), { mode: 0o600, flag: "wx" });
  return fs.readFileSync(file, "utf8").trim();
}

// Claude PermissionRequest 훅에 필요한 런타임 설정 파일을 생성한다.
export function prepareRuntimeFiles(config: AppConfig): RuntimeFiles {
  const hookToken = loadOrCreateHookToken(config.dataDir);
  const productionBridge = path.join(config.rootDir, "dist", "server", "scripts", "claude-permission-bridge.js");
  const developmentBridge = path.join(config.rootDir, "scripts", "claude-permission-bridge.ts");
  const command = process.env.NODE_ENV === "production"
    ? `${process.execPath} ${JSON.stringify(productionBridge)}`
    : `${path.join(config.rootDir, "node_modules", ".bin", "tsx")} ${JSON.stringify(developmentBridge)}`;
  const claudeSettingsFile = path.join(config.dataDir, "claude-web-settings.json");
  fs.writeFileSync(claudeSettingsFile, JSON.stringify({
    hooks: {
      PermissionRequest: [{ hooks: [{ type: "command", command, timeout: 600 }] }],
    },
  }, null, 2), { mode: 0o600 });
  return {
    hookToken,
    claudeSettingsFile,
    hookEnvironment: {
      WEB_AGENT_MANAGER_HOOK_URL: `http://127.0.0.1:${config.port}/internal/claude/permission`,
      WEB_AGENT_MANAGER_HOOK_TOKEN: hookToken,
    },
  };
}
