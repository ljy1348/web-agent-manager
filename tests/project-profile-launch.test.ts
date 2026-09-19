import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectProfileLaunch } from "../src/server/services/project-profile-launch";

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-profile-launch-"));
  roots.push(root);
  return root;
}

describe("project profile 실행 경계", () => {
  it("profile 없는 기존 채팅은 legacy 실행을 유지한다", () => {
    expect(projectProfileLaunch(null, workspace())).toBeUndefined();
  });

  it("검토한 sandbox·승인·모델·추론·추가 경로를 정규화한다", () => {
    const root = workspace();
    const sibling = fs.mkdtempSync(path.join(os.tmpdir(), "wam-profile-extra-")); roots.push(sibling);
    const result = projectProfileLaunch(JSON.stringify({
      taskKind: "implementation",
      runtime: { model: "model-safe", reasoningEffort: "high" },
      permissions: {
        sandbox: "workspace-write", approvalMode: "untrusted", additionalWritePaths: [sibling],
        allowedTools: ["Read"], disallowedTools: ["WebFetch"],
      },
    }), root);
    expect(result).toEqual({
      sandbox: "workspace-write", approvalMode: "on-request", model: "model-safe", reasoningEffort: "high",
      additionalWritePaths: [fs.realpathSync(sibling)], allowedTools: ["Read"], disallowedTools: ["WebFetch"],
    });
  });

  it("taskKind 없는 기존 Agent Lab preset도 runtime sandbox를 보존한다", () => {
    expect(projectProfileLaunch(JSON.stringify({ runtime: { sandbox: "read-only", model: "legacy-model" } }), workspace())).toMatchObject({
      sandbox: "read-only", approvalMode: "on-request", model: "legacy-model",
    });
  });

  it("analysis 쓰기, 무승인 full access, read-only 추가 쓰기와 손상 snapshot을 거부한다", () => {
    const root = workspace();
    const extra = fs.mkdtempSync(path.join(os.tmpdir(), "wam-profile-extra-")); roots.push(extra);
    expect(() => projectProfileLaunch(JSON.stringify({ taskKind: "analysis", permissions: { sandbox: "workspace-write" } }), root)).toThrow("analysis profile");
    expect(() => projectProfileLaunch(JSON.stringify({ taskKind: "operations", permissions: { sandbox: "danger-full-access", approvalMode: "never" } }), root)).toThrow("승인을 끌 수 없습니다");
    expect(() => projectProfileLaunch(JSON.stringify({ taskKind: "analysis", permissions: { sandbox: "read-only", additionalWritePaths: [extra] } }), root)).toThrow("read-only profile");
    expect(() => projectProfileLaunch("{", root)).toThrow("snapshot을 읽을 수 없습니다");
  });
});
