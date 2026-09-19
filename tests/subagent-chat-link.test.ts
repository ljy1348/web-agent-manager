import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHAT_SUBAGENT_BADGE_POLL_MS,
  filterDelegationsForScope,
  groupDelegationsForProjectView,
  workingSubagentCountsBySourceChat,
} from "../src/client/components/SubagentManager";

function source(relative: string): string {
  return fs.readFileSync(path.resolve(relative), "utf8");
}

const currentParent = {
  id: "parent-working",
  source_chat_id: 10,
  target_chat_id: 21,
  target_busy: 1,
  target_status: "running",
  status: "sent",
};
const currentIdle = {
  id: "parent-idle",
  source_chat_id: 10,
  target_chat_id: 22,
  target_busy: 0,
  target_status: "running",
  status: "sent",
};
const otherWorking = {
  id: "other-working",
  source_chat_id: 20,
  target_chat_id: 31,
  target_busy: 1,
  target_status: "running",
  status: "sent",
};
const parentlessWorking = {
  id: "cli-working",
  source_chat_id: null,
  target_chat_id: 41,
  target_busy: 1,
  target_status: "running",
  status: "sent",
};
const startingChild = {
  id: "parent-starting",
  source_chat_id: 10,
  target_chat_id: 23,
  target_busy: 0,
  target_status: "starting",
  status: "sent",
};
const completedChild = {
  id: "parent-done",
  source_chat_id: 10,
  target_chat_id: 24,
  target_busy: 0,
  target_status: "running",
  status: "completed",
};

const allDelegations = [currentParent, currentIdle, otherWorking, parentlessWorking, startingChild, completedChild];

describe("서브 에이전트 패널 범위", () => {
  it("기본 필터는 지금 열린 채팅이 부모인 위임만 남긴다", () => {
    expect(filterDelegationsForScope(allDelegations, 10, false).map((item) => item.id)).toEqual([
      "parent-working",
      "parent-idle",
      "parent-starting",
      "parent-done",
    ]);
  });

  it("토글하면 프로젝트 전체 위임을 보여준다", () => {
    expect(filterDelegationsForScope(allDelegations, 10, true).map((item) => item.id)).toEqual(
      allDelegations.map((item) => item.id),
    );
  });

  it("이 채팅 보기에서는 부모 없는 위임이 나오지 않는다", () => {
    expect(filterDelegationsForScope(allDelegations, 10, false).some((item) => item.source_chat_id == null)).toBe(false);
    expect(filterDelegationsForScope([parentlessWorking], 10, false)).toEqual([]);
  });

  it("전체 보기에서 부모 없는 위임을 직접 실행 그룹으로 나눈다", () => {
    const grouped = groupDelegationsForProjectView(allDelegations);
    expect(grouped.parented.map((item) => item.id)).toEqual([
      "parent-working",
      "parent-idle",
      "other-working",
      "parent-starting",
      "parent-done",
    ]);
    expect(grouped.parentless.map((item) => item.id)).toEqual(["cli-working"]);
  });
});

describe("채팅 목록 서브에이전트 배지", () => {
  it("진행 중 서브에이전트만 부모 채팅 수로 센다", () => {
    expect(workingSubagentCountsBySourceChat(allDelegations)).toEqual({ 10: 2, 20: 1 });
  });

  it("진행 중이 없으면 배지 수를 만들지 않는다", () => {
    expect(workingSubagentCountsBySourceChat([currentIdle, completedChild, parentlessWorking])).toEqual({});
    expect(workingSubagentCountsBySourceChat(allDelegations)[99] ?? 0).toBe(0);
  });

  it("배지 갱신은 15초이며 채팅 목록을 매초 다시 부르지 않는다", () => {
    expect(CHAT_SUBAGENT_BADGE_POLL_MS).toBe(15_000);
    const chatView = source("src/client/features/chat/ChatView.tsx");
    expect(chatView).toContain("CHAT_SUBAGENT_BADGE_POLL_MS");
    expect(chatView).toContain("/projects/${project.id}/agent-delegations");
    expect(chatView).not.toMatch(/setInterval\([^,]+,\s*1_?000/);
    expect(chatView).toMatch(/workingSubagents > 0 && <span className="chat-subagent-badge"/);
  });

  it("패널 토글과 직접 실행 그룹을 화면에 둔다", () => {
    const manager = source("src/client/components/SubagentManager.tsx");
    expect(manager).toContain("이 채팅");
    expect(manager).toContain("프로젝트 전체");
    expect(manager).toContain("직접 실행(CLI·MCP)");
    expect(manager).toContain("useState(false)");
    expect(manager).toContain("filterDelegationsForScope");
    expect(manager).toContain("groupDelegationsForProjectView");
  });
});
