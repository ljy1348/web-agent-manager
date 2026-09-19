import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/server/core/config";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function isolatedConfig(): ReturnType<typeof loadConfig> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-structured-config-"));
  roots.push(root);
  vi.stubEnv("WEB_AGENT_MANAGER_DATA_DIR", path.join(root, "data"));
  vi.stubEnv("WEB_AGENT_MANAGER_PROJECTS_DIR", path.join(root, "projects"));
  return loadConfig();
}

describe("Codex structured transport config", () => {
  it("flag만으로는 cohort/quota를 만들지 않는다", () => {
    vi.stubEnv("WEB_AGENT_MANAGER_CODEX_INTERACTIVE_TRANSPORT_CANDIDATE", "1");
    vi.stubEnv("WEB_AGENT_MANAGER_CODEX_INTERACTIVE_TRANSPORT_COHORT", "   ");
    vi.stubEnv("WEB_AGENT_MANAGER_CODEX_INTERACTIVE_TRANSPORT_MAX_NEW_CHATS", "0");
    expect(isolatedConfig()).toMatchObject({
      codexInteractiveTransportCandidateEnabled: true,
      codexInteractiveTransportCandidateCohort: undefined,
      codexInteractiveTransportMaxNewChats: 0,
    });
  });

  it("cohort 공백을 정리하고 신규 채팅 quota를 20으로 제한한다", () => {
    vi.stubEnv("WEB_AGENT_MANAGER_CODEX_INTERACTIVE_TRANSPORT_COHORT", "  qa-limited  ");
    vi.stubEnv("WEB_AGENT_MANAGER_CODEX_INTERACTIVE_TRANSPORT_MAX_NEW_CHATS", "999");
    expect(isolatedConfig()).toMatchObject({
      codexInteractiveTransportCandidateCohort: "qa-limited",
      codexInteractiveTransportMaxNewChats: 20,
    });
  });
});
