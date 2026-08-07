import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppDatabase } from "../src/server/core/database";
import type { RealtimeHub } from "../src/server/services/realtime";
import { classifySystemProcesses, linkProcessesToChats, processGroup, SystemMetricsService, type SystemMetricsRuntime } from "../src/server/services/system-metrics";

afterEach(() => {
  vi.useRealTimers();
});

// 시스템 지표 테스트용 DB 조회 결과를 제공한다.
function database(): AppDatabase {
  return {
    prepare: (sql: string) => sql.includes("FROM chats c")
      ? { all: () => [] }
      : { get: () => ({ total: 0, running: 0, starting: 0, stopped: 0, error: 0 }) },
  } as unknown as AppDatabase;
}

// 각 시스템 조회 호출 횟수를 기록하는 가짜 런타임을 만든다.
function runtime(calls: Record<string, number>): SystemMetricsRuntime {
  const hit = (name: string): void => { calls[name] = (calls[name] ?? 0) + 1; };
  return {
    currentLoad: async () => { hit("load"); return { currentLoad: 25, avgLoad: 1, currentLoadUser: 20, currentLoadSystem: 5 }; },
    mem: async () => { hit("memory"); return { total: 100, used: 40, available: 60, swaptotal: 10, swapused: 2 }; },
    fsSize: async () => { hit("disk"); return [{ mount: "/", size: 100, used: 30, use: 30 }]; },
    networkStats: async () => { hit("network"); return [{ rx_bytes: 10, tx_bytes: 20 }]; },
    processes: async () => { hit("process"); return { list: [{ pid: 10, parentPid: 1, name: "node", cpu: 3, memRss: 1000 }] }; },
    panePids: () => { hit("pane"); return new Map(); },
    uptime: () => { hit("uptime"); return 123; },
  };
}

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

describe("프로세스 묶음 분류", () => {
  const processes = [
    { pid: 100, parentPid: 1, name: "node" },      // 서버 본체
    { pid: 101, parentPid: 100, name: "node" },    // 서버가 띄운 MCP 브리지
    { pid: 102, parentPid: 101, name: "claude" },  // 서버 자손인 사용량 조회 PTY
    { pid: 200, parentPid: 1, name: "tmux: server" },
    { pid: 300, parentPid: 1, name: "node" },      // 채팅 pane 최상위
    { pid: 301, parentPid: 300, name: "claude" },  // 채팅 CLI
    { pid: 400, parentPid: 1, name: "node" },      // 앱과 무관한 프로세스
  ];

  it("서버 자신과 그 자손, tmux 데몬을 시스템으로 분류한다", () => {
    const system = classifySystemProcesses(processes, new Set([300, 301]), 100);

    expect([...system].sort((a, b) => a - b)).toEqual([100, 101, 102, 200]);
  });

  it("서버를 띄운 부모(tsx watch)도 시스템으로 본다", () => {
    // 자손 전파만으로는 서버의 위쪽을 못 잡아 개발 모드의 watch 프로세스가 기타로 새던 문제를 막는다.
    const withParent = [
      { pid: 34, parentPid: 1, name: "sh" },
      { pid: 35, parentPid: 34, name: "node" },   // tsx watch
      { pid: 100, parentPid: 35, name: "node" },  // 실제 서버
    ];

    const system = classifySystemProcesses(withParent, new Set(), 100);

    expect([...system].sort((a, b) => a - b)).toEqual([35, 100]);
  });

  it("표시 대상이 아닌 조상을 만나면 더 올라가지 않는다", () => {
    // 셸 위쪽까지 삼키면 앱과 무관한 프로세스가 시스템으로 잘못 묶인다.
    const chain = [
      { pid: 10, parentPid: 1, name: "node" },   // 무관한 상위 노드 프로세스
      { pid: 20, parentPid: 10, name: "sh" },    // 여기서 멈춰야 한다
      { pid: 30, parentPid: 20, name: "node" },  // 서버
    ];

    const system = classifySystemProcesses(chain, new Set(), 30);

    expect([...system]).toEqual([30]);
  });

  it("채팅에 연결된 프로세스는 서버 자손이어도 시스템으로 흡수하지 않는다", () => {
    // 채팅 CLI가 서버 프로세스 트리 아래에 있는 배치에서도 채팅 소속이 우선이어야 한다.
    const nested = [
      { pid: 100, parentPid: 1, name: "node" },
      { pid: 110, parentPid: 100, name: "node" },
      { pid: 111, parentPid: 110, name: "claude" },
    ];

    const system = classifySystemProcesses(nested, new Set([110, 111]), 100);

    expect([...system]).toEqual([100]);
  });

  it("채팅·시스템·기타를 각각 다른 묶음 키로 만든다", () => {
    const chatLink = { chatId: 7, provider: "claude" as const, title: "리팩터링", projectId: 3, projectName: "myagent" };

    expect(processGroup(chatLink, false)).toEqual({ kind: "chat", key: "chat:7", label: "myagent · 리팩터링" });
    expect(processGroup(null, true)).toMatchObject({ kind: "system", key: "system" });
    expect(processGroup(null, false)).toMatchObject({ kind: "other", key: "other" });
    expect(processGroup(null, false).label).toContain("앱이 띄우지 않음");
  });

  it("같은 채팅의 프로세스들은 같은 묶음 키를 받는다", () => {
    const chatLink = { chatId: 7, provider: "claude" as const, title: "리팩터링", projectId: 3, projectName: "myagent" };

    const keys = [processGroup(chatLink, false).key, processGroup(chatLink, false).key, processGroup(chatLink, true).key];

    expect(new Set(keys).size).toBe(1);
  });
});

describe("시스템 지표 수집 주기", () => {
  it("빠른 지표는 5초, 프로세스는 15초, 디스크는 60초마다 갱신한다", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const calls: Record<string, number> = {};
    const broadcasts: unknown[] = [];
    const realtime = {
      broadcast: (_type: string, payload: unknown): void => { broadcasts.push(payload); },
    } as unknown as RealtimeHub;
    const service = new SystemMetricsService(realtime, database(), runtime(calls), Date.now);

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toMatchObject({ load: 1, memory: 1, network: 1, process: 1, pane: 1, disk: 1 });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toMatchObject({ load: 3, memory: 3, network: 3, process: 1, pane: 1, disk: 1 });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toMatchObject({ load: 4, process: 2, pane: 2, disk: 1 });

    await vi.advanceTimersByTimeAsync(45_000);
    expect(calls).toMatchObject({ load: 13, memory: 13, network: 13, process: 5, pane: 5, disk: 2, uptime: 13 });
    expect(broadcasts).toHaveLength(13);
    // memRss는 KiB라 화면이 바이트로 포맷해도 실제 크기가 나오도록 여기서 바이트로 변환해 내보낸다.
    expect(service.snapshot().latest).toMatchObject({ disks: [{ mount: "/" }], processes: [{ pid: 10, memory: 1000 * 1024 }] });
    service.stop();
  });
});
