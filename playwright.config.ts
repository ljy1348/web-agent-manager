import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  use: {
    baseURL: process.env.WEB_AGENT_MANAGER_TEST_URL ?? process.env.MYAGENT_TEST_URL ?? "http://127.0.0.1:4399",
    channel: "chrome",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
  reporter: "list",
});
