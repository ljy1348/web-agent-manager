import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CLI_ACCOUNT_PROVIDERS, CLI_AUTH_LABELS } from "../src/client/components/CliAuthPanel";
import { subagentStopConfirmMessage } from "../src/client/components/SubagentManager";
import { shouldClearWorkspaceBeforeLoad } from "../src/client/components/GitBranchControl";
import { experimentCancelConfirmMessage } from "../src/client/features/experiments/ExperimentsView";
import { githubRunsErrorState, githubRunsListMessage, worktreeChatProvider } from "../src/client/features/git/GitView";
import { effectiveChatViewMode } from "../src/client/lib/chat-view-mode";

function source(relative: string): string {
  return fs.readFileSync(path.resolve(relative), "utf8");
}

describe("CLI 인증 패널 Grok", () => {
  it("Grok 라벨과 계정 그룹을 Codex·Claude와 같이 노출한다", () => {
    expect(CLI_AUTH_LABELS.grok).toBe("Grok");
    expect([...CLI_ACCOUNT_PROVIDERS]).toEqual(["codex", "claude", "grok"]);
    expect(source("src/client/components/CliAuthPanel.tsx")).toContain("CLI_ACCOUNT_PROVIDERS.map");
  });
});

describe("위임 채팅 단건 열기", () => {
  it("목록에 없는 현재 채팅을 새로고침이 다른 채팅으로 바꾸지 않는다", () => {
    const text = source("src/client/main.tsx");
    expect(text).toContain("keepCurrent");
    expect(text).toContain("current.project_id === requestProjectId");
  });
});

describe("일반 사용자 채팅 화면 모드", () => {
  it("저장된 terminal 값도 채팅 모드로 제한하고 터미널 메뉴를 관리자에게만 렌더링한다", () => {
    expect(effectiveChatViewMode("user", "terminal")).toBe("chat");
    expect(effectiveChatViewMode("admin", "terminal")).toBe("terminal");
    const text = source("src/client/features/chat/ChatView.tsx");
    expect(text).toMatch(/user\?\.role === "admin" && <nav className="chat-view-tabs"/);
    expect(text).toMatch(/selectedChat && user\?\.role === "admin" && <div className="workspace-head-actions"/);
    expect(text).toMatch(/mode === "terminal" && user\?\.role !== "admin"/);
  });
});

describe("서브 에이전트 터미널 종료 확인", () => {
  it("종료 확인 문구에 대상 채팅 번호를 넣는다", () => {
    expect(subagentStopConfirmMessage(42)).toContain("#42");
    expect(subagentStopConfirmMessage(42)).toMatch(/종료/);
  });

  it("터미널 종료만 확인을 받고 응답 중단은 즉시 실행한다", () => {
    const text = source("src/client/components/SubagentManager.tsx");
    expect(text).toMatch(/window\.confirm\(subagentStopConfirmMessage\(item\.target_chat_id\)\)/);
    const interrupt = text.split("\n").find((line) => line.includes("응답 중단"));
    expect(interrupt).toBeTruthy();
    expect(interrupt).not.toMatch(/confirm/);
  });
});

describe("새 작업공간 공급자", () => {
  const providers = [{ id: "codex" }, { id: "claude" }, { id: "grok" }];

  it("현재 채팅 공급자를 쓰고 배열 첫 항목으로 덮지 않는다", () => {
    expect(worktreeChatProvider({ provider: "claude" }, providers)).toBe("claude");
    expect(worktreeChatProvider({ provider: "grok" }, providers)).toBe("grok");
    expect(source("src/client/features/git/GitView.tsx")).not.toMatch(/providers\?\.\[0\]\?\.id \?\? "claude"/);
  });

  it("선택 채팅이 없으면 목록의 첫 공급자로 떨어진다", () => {
    expect(worktreeChatProvider(null, providers)).toBe("codex");
    expect(worktreeChatProvider({}, [])).toBe("claude");
  });
});

describe("GitHub Actions 조회 실패", () => {
  it("실패를 빈 기록이 아니라 에러로 남긴다", () => {
    expect(githubRunsErrorState(new Error("gh 인증이 필요합니다"))).toEqual({
      runs: [],
      hasMore: false,
      error: "gh 인증이 필요합니다",
    });
    expect(githubRunsListMessage({ runs: [], error: "조회 실패" })).toEqual({
      kind: "error",
      text: "조회 실패",
    });
    expect(githubRunsListMessage({ runs: [] })).toEqual({
      kind: "empty",
      text: "워크플로 실행 기록 없음",
    });
    expect(githubRunsListMessage({ runs: [{ name: "ci" }] })).toEqual({ kind: "list", text: "" });
  });

  it("catch에서 빈 목록만 넣지 않는다", () => {
    expect(source("src/client/features/git/GitView.tsx")).not.toMatch(/setGithubRuns\(\{ runs: \[\], hasMore: false \}\)/);
    expect(source("src/client/features/git/GitView.tsx")).toContain("githubRunsErrorState");
  });
});

describe("Git 브랜치 위젯 폴링", () => {
  it("갱신 시작마다 작업공간을 비우지 않는다", () => {
    expect(shouldClearWorkspaceBeforeLoad()).toBe(false);
    const load = source("src/client/components/GitBranchControl.tsx").match(/async function load\(\)[\s\S]*?\n  \}/)?.[0] ?? "";
    expect(load).not.toMatch(/setWorkspace\(null\)/);
  });
});

describe("실험 실행 취소 확인", () => {
  it("실행 중인 run 취소 전에 확인 문구를 쓴다", () => {
    expect(experimentCancelConfirmMessage()).toMatch(/취소/);
    const text = source("src/client/features/experiments/ExperimentsView.tsx");
    expect(text).toMatch(/async function cancelRun[\s\S]*window\.confirm\(experimentCancelConfirmMessage\(\)\)/);
  });
});
