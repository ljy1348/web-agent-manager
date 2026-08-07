import { loadConfig } from "../src/server/core/config";
import { openDatabase } from "../src/server/core/database";
import { AgentIntegrationManager } from "../src/server/services/agent-integration";

// 설치된 Claude·Codex CLI를 찾아 web-agent-manager 스킬과 MCP 연결을 사용자 범위에 구성한다.
async function main(): Promise<void> {
  const config = loadConfig();
  const database = openDatabase(config);
  const manager = new AgentIntegrationManager(config, database);
  try {
    const { integrations } = await manager.status();
    for (const integration of integrations) {
      if (!integration.cliInstalled) {
        process.stdout.write(`${integration.provider}: CLI 미설치, 연동을 건너뜁니다.\n`);
        continue;
      }
      if (integration.ready) {
        process.stdout.write(`${integration.provider}: 이미 연동되어 있습니다.\n`);
        continue;
      }
      try {
        await manager.install(integration.provider);
        process.stdout.write(`${integration.provider}: 스킬과 MCP 연동을 완료했습니다.\n`);
      } catch (error) {
        process.stderr.write(`${integration.provider}: 자동 연동을 건너뜁니다. ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  } finally {
    database.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
