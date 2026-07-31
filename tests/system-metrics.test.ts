import { describe, expect, it } from "vitest";
import { linkProcessesToChats } from "../src/server/services/system-metrics";

describe("프로세스-채팅 연결", () => {
  it("tmux pane의 최상위 pid를 채팅에 직접 연결한다", () => {
    const chats = [{ id: 1, tmux_name: "web_agent_manager_chat_1", provider: "codex" as const, title: "채팅1", project_id: 10, project_name: "프로젝트A" }];
    const panePids = new Map([["web_agent_manager_chat_1", 100]]);
    const processes = [{ pid: 100, parentPid: 1 }];
    const linked = linkProcessesToChats(processes, chats, panePids);
    expect(linked.get(100)).toEqual({ chatId: 1, provider: "codex", title: "채팅1", projectId: 10, projectName: "프로젝트A" });
  });

  it("최상위 pid의 자식·손자 프로세스까지 같은 채팅 정보를 전파한다", () => {
    const chats = [{ id: 2, tmux_name: "web_agent_manager_chat_2", provider: "claude" as const, title: "채팅2", project_id: 20, project_name: "프로젝트B" }];
    const panePids = new Map([["web_agent_manager_chat_2", 200]]);
    // 200(래퍼) -> 201(node) -> 202(실제 claude 워커) 형태의 프로세스 트리를 흉내낸다.
    const processes = [{ pid: 200, parentPid: 1 }, { pid: 201, parentPid: 200 }, { pid: 202, parentPid: 201 }];
    const linked = linkProcessesToChats(processes, chats, panePids);
    expect(linked.get(201)?.chatId).toBe(2);
    expect(linked.get(202)?.chatId).toBe(2);
  });

  it("연결할 tmux pane pid가 없는 채팅은 무시하고, 관계없는 프로세스는 연결하지 않는다", () => {
    const chats = [{ id: 3, tmux_name: "web_agent_manager_chat_3", provider: "codex" as const, title: "채팅3", project_id: 30, project_name: "프로젝트C" }];
    const panePids = new Map<string, number>();
    const processes = [{ pid: 999, parentPid: 1 }];
    const linked = linkProcessesToChats(processes, chats, panePids);
    expect(linked.size).toBe(0);
  });
});
