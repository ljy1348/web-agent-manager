import { spawnSync } from "node:child_process";
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
  processes: Array<{ pid: number; name: string; cpu: number; memory: number; chat: ProcessChatLink | null }>;
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

const SYSTEM_METRICS_INTERVAL_MS = 5_000;

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

  constructor(private readonly realtime: RealtimeHub, private readonly database: AppDatabase) {}

  // 전체 프로세스 조회 비용을 제한하면서 화면에는 5초 간격으로 시스템 지표를 제공한다.
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

  // CPU·메모리·디스크·네트워크·에이전트 프로세스를 한 번 수집한다.
  private async collect(): Promise<void> {
    if (this.collecting) return;
    this.collecting = true;
    try {
      const [load, memory, disks, networks, processes, time] = await Promise.all([
        si.currentLoad(), si.mem(), si.fsSize(), si.networkStats(), si.processes(), si.time(),
      ]);
      const chats = this.database.prepare(`
        SELECT c.id, c.tmux_name, c.provider, c.title, p.id AS project_id, p.name AS project_name
        FROM chats c JOIN projects p ON p.id = c.project_id
        WHERE c.status IN ('starting', 'running', 'resuming', 'stopping')
      `).all() as ChatMeta[];
      const pidToChat = linkProcessesToChats(processes.list, chats, collectPanePids());
      const interesting = processes.list
        .filter((process) => /^(codex|claude|node|tmux)/i.test(process.name))
        .map((process) => ({ pid: process.pid, name: process.name, cpu: process.cpu, memory: process.memRss, chat: pidToChat.get(process.pid) ?? null }));
      const counts = this.database.prepare(`
        SELECT COUNT(*) AS total,
          SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
          SUM(CASE WHEN status IN ('starting', 'resuming', 'stopping') THEN 1 ELSE 0 END) AS starting,
          SUM(CASE WHEN status = 'stopped' THEN 1 ELSE 0 END) AS stopped,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error
        FROM chats
      `).get() as { total: number; running: number; starting: number; stopped: number; error: number };
      this.latest = {
        timestamp: new Date().toISOString(),
        cpuPercent: load.currentLoad,
        loadAverage: [load.avgLoad, load.currentLoadUser, load.currentLoadSystem],
        memory: { total: memory.total, used: memory.used, available: memory.available, swapTotal: memory.swaptotal, swapUsed: memory.swapused },
        disks: disks.map((disk) => ({ mount: disk.mount, size: disk.size, used: disk.used, usePercent: disk.use })),
        network: { rxBytes: networks.reduce((sum, item) => sum + item.rx_bytes, 0), txBytes: networks.reduce((sum, item) => sum + item.tx_bytes, 0) },
        processes: interesting,
        uptimeSeconds: time.uptime,
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
