import { defineConfig } from "@playwright/test";

const externalTestUrl = process.env.WEB_AGENT_MANAGER_TEST_URL ?? process.env.MYAGENT_TEST_URL;
const testUrl = externalTestUrl ?? "http://127.0.0.1:4399";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  use: {
    baseURL: testUrl,
    channel: "chrome",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
  reporter: "list",
  webServer: externalTestUrl ? undefined : {
    command: "npx vite --host 127.0.0.1 --port 4399",
    url: testUrl,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
