import { spawnSync } from "node:child_process";
import os from "node:os";
import si from "systeminformation";
import type { RealtimeHub } from "./realtime";
import type { AppDatabase } from "../core/database";
import type { Provider } from "../../shared/types";

export interface ProcessChatLink {
  chatId: number;
  provider: Provider;
  title: string;
  projectId: number;
  projectName: string;
}

export interface SystemSnapshot {
  timestamp: string;
  cpuPercent: number;
  loadAverage: number[];
  memory: { total: number; used: number; available: number; swapTotal: number; swapUsed: number };
  disks: Array<{ mount: string; size: number; used: number; usePercent: number }>;
  network: { rxBytes: number; txBytes: number };
  processes: Array<{ pid: number; name: string; cpu: number; memory: number; chat: ProcessChatLink | null; group: ProcessGroup }>;
  uptimeSeconds: number;
  sessions: { total: number; running: number; starting: number; stopped: number; error: number };
}

interface ChatMeta {
  id: number;
  tmux_name: string;
  provider: Provider;
  title: string;
  project_id: number;
  project_name: string;
}

// 프로세스를 화면에서 묶어 보여줄 단위. 채팅 하나에 tmux·node·claude가 따로 뜨는 걸 한 줄로 접기 위한 것이다.
export interface ProcessGroup {
  kind: "chat" | "system" | "other";
  key: string;
  label: string;
}

const SYSTEM_METRICS_INTERVAL_MS = 5_000;
const PROCESS_METRICS_INTERVAL_MS = 15_000;
const DISK_METRICS_INTERVAL_MS = 60_000;

export interface SystemMetricsRuntime {
  currentLoad(): Promise<{ currentLoad: number; avgLoad: number; currentLoadUser: number; currentLoadSystem: number }>;
  mem(): Promise<{ total: number; used: number; available: number; swaptotal: number; swapused: number }>;
  fsSize(): Promise<Array<{ mount: string; size: number; used: number; use: number }>>;
  networkStats(): Promise<Array<{ rx_bytes: number; tx_bytes: number }>>;
  processes(): Promise<{ list: Array<{ pid: number; parentPid: number; name: string; cpu: number; memRss: number }> }>;
  panePids(): Map<string, number>;
  uptime(): number;
}

const DEFAULT_RUNTIME: SystemMetricsRuntime = {
  currentLoad: () => si.currentLoad(),
  mem: () => si.mem(),
  fsSize: () => si.fsSize(),
  networkStats: () => si.networkStats(),
  processes: () => si.processes(),
  panePids: collectPanePids,
  uptime: () => os.uptime(),
};

// tmux 각 pane의 세션 이름과 최상위 프로세스 pid를 한 번에 조회한다.
function collectPanePids(): Map<string, number> {
  const result = spawnSync("tmux", ["list-panes", "-a", "-F", "#{session_name} #{pane_pid}"], { encoding: "utf8" });
  const map = new Map<string, number>();
  if (result.status !== 0) return map;
  for (const line of result.stdout.split("\n")) {
    const [name, pidText] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    if (name && Number.isInteger(pid)) map.set(name, pid);
  }
  return map;
}

// 지정한 루트 pid들에서 시작해 부모-자식 관계를 따라 자손 pid를 모두 모은다.
function collectDescendants(processes: Array<{ pid: number; parentPid: number }>, roots: number[]): Set<number> {
  const childrenByParent = new Map<number, number[]>();
  for (const process of processes) {
    const siblings = childrenByParent.get(process.parentPid) ?? [];
    siblings.push(process.pid);
    childrenByParent.set(process.parentPid, siblings);
  }
  const found = new Set<number>();
  const queue = [...roots];
  while (queue.length) {
    const pid = queue.shift()!;
    for (const child of childrenByParent.get(pid) ?? []) {
      if (found.has(child)) continue;
      found.add(child);
      queue.push(child);
    }
  }
  return found;
}

// 채팅에 속하지 않은 프로세스 중 web-agent-manager 자신이 띄운 것을 골라낸다.
// 서버 본체와 그 자손(MCP 브리지, 사용량 조회 PTY 등)에 더해, 어느 채팅에도 안 붙지만 앱이 쓰는
// tmux 데몬도 시스템으로 본다 — 사용자가 "채팅 이름 없는 애들"을 구분해서 보려는 목적이기 때문이다.
export function classifySystemProcesses(
  processes: Array<{ pid: number; parentPid: number; name: string }>,
  chatLinkedPids: Set<number>,
  serverPid: number,
): Set<number> {
  const system = new Set<number>();
  const known = new Set(processes.map((process) => process.pid));
  if (known.has(serverPid) && !chatLinkedPids.has(serverPid)) system.add(serverPid);
  for (const pid of collectDescendants(processes, [serverPid])) {
    if (!chatLinkedPids.has(pid)) system.add(pid);
  }
  // 개발 모드의 `tsx watch`처럼 서버를 띄운 부모도 앱 프로세스다. 자손 전파로는 서버의 *위쪽*을 못 잡아
  // pid 35(watch)가 "기타"로 새는 걸 실제로 확인했다 — 화면에 나오는 이름(node 등)인 동안만 조상을
  // 따라 올라가고, 셸처럼 표시 대상이 아닌 조상을 만나면 거기서 멈춰 무관한 프로세스까지 삼키지 않는다.
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  let ancestor = byPid.get(serverPid)?.parentPid;
  for (let depth = 0; depth < 8 && ancestor && ancestor > 1; depth += 1) {
    const process = byPid.get(ancestor);
    if (!process || !/^(codex|claude|node|tmux)/i.test(process.name)) break;
    if (!chatLinkedPids.has(process.pid)) system.add(process.pid);
    ancestor = process.parentPid;
  }
  for (const process of processes) {
    if (chatLinkedPids.has(process.pid) || system.has(process.pid)) continue;
    if (/^tmux/i.test(process.name)) system.add(process.pid);
  }
  return system;
}

// 프로세스 하나가 화면에서 어느 묶음에 들어갈지 정한다.
export function processGroup(chat: ProcessChatLink | null, isSystem: boolean): ProcessGroup {
  if (chat) return { kind: "chat", key: `chat:${chat.chatId}`, label: `${chat.projectName} · ${chat.title}` };
  if (isSystem) return { kind: "system", key: "system", label: "web-agent-manager 시스템" };
  // 터미널에서 직접 띄운 CLI 세션 등 앱이 관리하지 않는 프로세스다. 함부로 종료하면 안 되므로 라벨로 알린다.
  return { kind: "other", key: "other", label: "기타 프로세스 (앱이 띄우지 않음)" };
}

// tmux pane의 최상위 pid에서 시작해 자식 프로세스까지 채팅 정보를 전파한다.
// 실제 codex/claude 프로세스가 pane 바로 그 pid이거나 그 자식(예: 래퍼 스크립트)일 수 있어서다.
export function linkProcessesToChats(
  processes: Array<{ pid: number; parentPid: number }>,
  chats: ChatMeta[],
  panePids: Map<string, number>,
): Map<number, ProcessChatLink> {
  const pidToChat = new Map<number, ProcessChatLink>();
  for (const chat of chats) {
    const rootPid = panePids.get(chat.tmux_name);
    if (rootPid === undefined) continue;
    pidToChat.set(rootPid, { chatId: chat.id, provider: chat.provider, title: chat.title, projectId: chat.project_id, projectName: chat.project_name });
  }
  const childrenByParent = new Map<number, number[]>();
  for (const process of processes) {
    const siblings = childrenByParent.get(process.parentPid) ?? [];
    siblings.push(process.pid);
    childrenByParent.set(process.parentPid, siblings);
  }
  const queue = [...pidToChat.keys()];
  while (queue.length) {
    const pid = queue.shift()!;
    const link = pidToChat.get(pid)!;
    for (const child of childrenByParent.get(pid) ?? []) {
      if (pidToChat.has(child)) continue;
      pidToChat.set(child, link);
      queue.push(child);
    }
  }
  return pidToChat;
}

// Linux 호스트와 에이전트 프로세스의 자원 사용량을 주기적으로 수집한다.
export class SystemMetricsService {
  private timer?: NodeJS.Timeout;
  private collecting = false;
  private latest?: SystemSnapshot;
  private readonly recent: SystemSnapshot[] = [];
  private lastProcessCollectionAt = 0;
  private lastDiskCollectionAt = 0;

  constructor(
    private readonly realtime: RealtimeHub,
    private readonly database: AppDatabase,
    private readonly runtime: SystemMetricsRuntime = DEFAULT_RUNTIME,
    private readonly now: () => number = Date.now,
    // 자기 자신과 자손을 "시스템" 묶음으로 분류하기 위한 서버 프로세스 pid.
    private readonly serverPid: number = process.pid,
  ) {}

  // 빠른 자원 지표는 5초마다 제공하고 비싼 프로세스·디스크 조회는 내부 주기로 제한한다.
  start(): void {
    void this.collect();
    this.timer = setInterval(() => void this.collect(), SYSTEM_METRICS_INTERVAL_MS);
    this.timer.unref();
  }

  // 시스템 지표 수집을 중단한다.
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // 최신 지표와 최근 순환 이력을 반환한다.
  snapshot(): { latest: SystemSnapshot | null; recent: SystemSnapshot[] } {
    return { latest: this.latest ?? null, recent: this.recent };
  }

  // CPU·메모리·네트워크를 갱신하고 만료된 프로세스·디스크 스냅샷만 다시 수집한다.
  private async collect(): Promise<void> {
    if (this.collecting) return;
    this.collecting = true;
    try {
      const collectedAt = this.now();
      const refreshProcesses = !this.latest || collectedAt - this.lastProcessCollectionAt >= PROCESS_METRICS_INTERVAL_MS;
      const refreshDisks = !this.latest || collectedAt - this.lastDiskCollectionAt >= DISK_METRICS_INTERVAL_MS;
      const [load, memory, networks, processResult, diskResult] = await Promise.all([
        this.runtime.currentLoad(),
        this.runtime.mem(),
        this.runtime.networkStats(),
        refreshProcesses ? this.runtime.processes() : Promise.resolve(null),
        refreshDisks ? this.runtime.fsSize() : Promise.resolve(null),
      ]);
      let processSnapshot = this.latest?.processes ?? [];
      if (processResult) {
        const chats = this.database.prepare(`
          SELECT c.id, c.tmux_name, c.provider, c.title, p.id AS project_id, p.name AS project_name
          FROM chats c JOIN projects p ON p.id = c.project_id
          WHERE c.status IN ('starting', 'running', 'resuming', 'stopping')
        `).all() as ChatMeta[];
        const pidToChat = linkProcessesToChats(processResult.list, chats, this.runtime.panePids());
        // 채팅 매핑을 먼저 확정한 뒤 남은 프로세스에서 시스템을 골라야 채팅 소속이 시스템으로 흡수되지 않는다.
        const systemPids = classifySystemProcesses(processResult.list, new Set(pidToChat.keys()), this.serverPid);
        processSnapshot = processResult.list
          .filter((process) => /^(codex|claude|node|tmux)/i.test(process.name))
          // systeminformation의 memRss는 KiB 단위인데 화면은 바이트로 포맷해 실제보다 1024배 작게
          // 보였다(claude 421MB가 0.4MB로 표시됨, 2026-08-06 확인) — 여기서 바이트로 맞춰 내보낸다.
          .map((process) => {
            const chat = pidToChat.get(process.pid) ?? null;
            return {
              pid: process.pid,
              name: process.name,
              cpu: process.cpu,
              memory: process.memRss * 1024,
              chat,
              group: processGroup(chat, systemPids.has(process.pid)),
            };
          });
        this.lastProcessCollectionAt = collectedAt;
      }
      let diskSnapshot = this.latest?.disks ?? [];
      if (diskResult) {
        diskSnapshot = diskResult.map((disk) => ({ mount: disk.mount, size: disk.size, used: disk.used, usePercent: disk.use }));
        this.lastDiskCollectionAt = collectedAt;
      }
      const counts = this.database.prepare(`
        SELECT COUNT(*) AS total,
          SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
          SUM(CASE WHEN status IN ('starting', 'resuming', 'stopping') THEN 1 ELSE 0 END) AS starting,
          SUM(CASE WHEN status = 'stopped' THEN 1 ELSE 0 END) AS stopped,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error
        FROM chats
      `).get() as { total: number; running: number; starting: number; stopped: number; error: number };
      this.latest = {
        timestamp: new Date(collectedAt).toISOString(),
        cpuPercent: load.currentLoad,
        loadAverage: [load.avgLoad, load.currentLoadUser, load.currentLoadSystem],
        memory: { total: memory.total, used: memory.used, available: memory.available, swapTotal: memory.swaptotal, swapUsed: memory.swapused },
        disks: diskSnapshot,
        network: { rxBytes: networks.reduce((sum, item) => sum + item.rx_bytes, 0), txBytes: networks.reduce((sum, item) => sum + item.tx_bytes, 0) },
        processes: processSnapshot,
        uptimeSeconds: this.runtime.uptime(),
        sessions: counts,
      };
      this.recent.push(this.latest);
      if (this.recent.length > 150) this.recent.shift();
      this.realtime.broadcast("system_metrics", this.latest);
    } catch {
      // 일시적인 /proc 조회 실패는 다음 수집 주기에서 복구한다.
    } finally {
      this.collecting = false;
    }
  }
}
