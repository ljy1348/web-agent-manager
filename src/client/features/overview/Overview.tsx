import React, { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import { createClientUuid } from "../../lib/client-uuid";
import { bytes, formatUsageResetAt, usageErrorLabel, usageResetCredits, usageWindows } from "../../lib/format";
import { compactTokenCount } from "../../lib/token-usage";
import type { Json } from "../../types";

const TOKEN_USAGE_GROUPS = [
  ["project", "프로젝트별"], ["chat", "채팅별"], ["day", "일자별"],
  ["provider", "공급자별"], ["account", "계정별"], ["model", "모델별"],
] as const;
const TOKEN_USAGE_PERIODS = [["7", "최근 7일"], ["30", "최근 30일"], ["90", "최근 90일"], ["365", "최근 1년"], ["all", "전체"]] as const;

// API 숫자 필드를 토큰 표시에서 안전하게 쓸 수 있는 0 이상의 수로 바꾼다.
function usageNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

// 축약 토큰 수에 마우스를 올리면 정확한 정수도 확인할 수 있게 표시한다.
function TokenMetric({ value }: { value: unknown }): React.ReactElement {
  const count = usageNumber(value);
  return <span title={Math.round(count).toLocaleString("ko-KR")}>{compactTokenCount(count)}</span>;
}

// 삭제된 채팅까지 영구 원장에서 합산한 기간·분류별 토큰 사용량을 표시한다.
function TokenUsageAnalytics(): React.ReactElement {
  const [groupBy, setGroupBy] = useState("project");
  const [period, setPeriod] = useState("30");
  const [data, setData] = useState<Json | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    const params = new URLSearchParams({
      groupBy,
      period,
      timezoneOffsetMinutes: String(-new Date().getTimezoneOffset()),
    });
    void api(`/token-usage?${params}`)
      .then((result) => { if (active) setData(result); })
      .catch((reason: any) => { if (active) setError(reason?.message || "토큰 사용량을 불러오지 못했습니다."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [groupBy, period]);
  const summary = data?.summary ?? {};
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const cacheTotal = usageNumber(summary.cachedInputTokens) + usageNumber(summary.cacheCreationInputTokens) + usageNumber(summary.cacheReadInputTokens);
  return <article className="card token-usage-card">
    <div className="token-usage-head">
      <div><h3>토큰 사용량 기록</h3><p>삭제된 채팅도 포함합니다. 백업 없이 원장 도입 전에 이미 삭제된 기록은 집계할 수 없습니다.</p></div>
      <div className="token-usage-filters">
        <label>기간<select value={period} onChange={(event) => setPeriod(event.target.value)}>{TOKEN_USAGE_PERIODS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>분류<select value={groupBy} onChange={(event) => setGroupBy(event.target.value)}>{TOKEN_USAGE_GROUPS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      </div>
    </div>
    <div className="token-usage-summary">
      <span>전체<strong><TokenMetric value={summary.totalTokens} /></strong></span>
      <span>입력<strong><TokenMetric value={summary.inputTokens} /></strong></span>
      <span>캐시<strong><TokenMetric value={cacheTotal} /></strong></span>
      <span>출력<strong><TokenMetric value={summary.outputTokens} /></strong></span>
      <span>추론<strong><TokenMetric value={summary.reasoningOutputTokens} /></strong></span>
    </div>
    <p className="token-usage-counts">응답 {usageNumber(summary.messageCount).toLocaleString("ko-KR")}개 · 채팅 {usageNumber(summary.chatCount).toLocaleString("ko-KR")}개 · 프로젝트 {usageNumber(summary.projectCount).toLocaleString("ko-KR")}개</p>
    {error && <p className="error-text">{error}</p>}
    <div className="table-wrap token-usage-table-wrap"><table className="token-usage-table"><thead><tr>
      <th>{TOKEN_USAGE_GROUPS.find(([value]) => value === groupBy)?.[1] ?? "분류"}</th><th>전체</th><th>입력</th><th>캐시</th><th>출력</th><th>응답</th>
    </tr></thead><tbody>
      {rows.map((row: Json) => {
        const rowCache = usageNumber(row.cachedInputTokens) + usageNumber(row.cacheCreationInputTokens) + usageNumber(row.cacheReadInputTokens);
        return <tr key={String(row.key)}><td><strong>{row.label || "-"}</strong>{row.deleted && groupBy === "chat" && <i className="token-usage-deleted">삭제됨</i>}{row.detail && <small>{row.detail}</small>}</td>
          <td><TokenMetric value={row.totalTokens} /></td><td><TokenMetric value={row.inputTokens} /></td><td><TokenMetric value={rowCache} /></td><td><TokenMetric value={row.outputTokens} /></td><td>{usageNumber(row.messageCount).toLocaleString("ko-KR")}</td></tr>;
      })}
      {!loading && !error && !rows.length && <tr><td colSpan={6} className="muted">이 기간에 기록된 토큰 사용량이 없습니다.</td></tr>}
      {loading && <tr><td colSpan={6} className="muted">토큰 사용량을 불러오는 중…</td></tr>}
    </tbody></table></div>
  </article>;
}

// 프로세스 표 정렬 키에 맞춰 비교값을 뽑아낸다.
function processSortValue(process: Json, key: string): string | number {
  if (key === "chat") return process.chat ? `${process.chat.projectName} ${process.chat.title}` : "";
  if (key === "name") return process.name;
  return process[key] ?? 0;
}

interface ProcessGroupRow {
  key: string;
  kind: string;
  label: string;
  processes: Json[];
  cpu: number;
  memory: number;
  chatId: number | null;
}

const GROUP_KIND_ORDER: Record<string, number> = { chat: 0, system: 1, other: 2 };
const GROUP_KIND_LABEL: Record<string, string> = { chat: "채팅", system: "시스템", other: "기타" };

// 같은 채팅에 딸린 tmux·node·claude를 한 줄로 묶고 시스템·기타 묶음도 따로 만든다.
function groupProcesses(processes: Json[], sortKey: string, sortDir: "asc" | "desc"): ProcessGroupRow[] {
  const groups = new Map<string, ProcessGroupRow>();
  for (const process of processes) {
    const group = process.group ?? { kind: "other", key: "other", label: "기타 프로세스" };
    const row: ProcessGroupRow = groups.get(group.key) ?? { key: group.key, kind: group.kind, label: group.label, processes: [], cpu: 0, memory: 0, chatId: process.chat?.chatId ?? null };
    row.processes.push(process);
    row.cpu += process.cpu ?? 0;
    row.memory += process.memory ?? 0;
    groups.set(group.key, row);
  }
  const dir = sortDir === "asc" ? 1 : -1;
  const rows = [...groups.values()];
  for (const row of rows) {
    row.processes.sort((a, b) => {
      const av = processSortValue(a, sortKey); const bv = processSortValue(b, sortKey);
      if (typeof av === "string" || typeof bv === "string") return dir * String(av).localeCompare(String(bv));
      return dir * (av - bv);
    });
  }
  // 묶음 자체는 종류(채팅 → 시스템 → 기타) 순으로 두고, 그 안에서만 선택한 정렬 기준을 쓴다.
  rows.sort((a, b) => {
    const kindDiff = (GROUP_KIND_ORDER[a.kind] ?? 9) - (GROUP_KIND_ORDER[b.kind] ?? 9);
    if (kindDiff) return kindDiff;
    if (sortKey === "memory" || sortKey === "cpu") return dir * ((a[sortKey] as number) - (b[sortKey] as number));
    return a.label.localeCompare(b.label);
  });
  return rows;
}

// ISO 문자열 타임스탬프를 사람이 읽기 쉬운 로컬 시각으로 바꾼다.
function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

// 최소 단답을 보낸 원인을 대시보드용 짧은 한국어로 바꾼다.
function keepaliveReasonLabel(reason: string | null | undefined): string {
  if (reason === "claude_session_missing") return "Claude 세션 창 없음";
  if (reason === "claude_session_zero") return "Claude 세션 0%";
  if (reason === "codex_reset_zero") return "Codex 사용량 0% 전환";
  return "사용량 초기화 감지";
}

// Codex 사용량 카드에 초기화권 잔여량·기한과 관리자용 사용 버튼을 표시한다.
function ResetCreditsSummary({ record, canRedeem, redeeming, onRedeem }: { record: Json; canRedeem: boolean; redeeming: boolean; onRedeem(): void }): React.ReactElement | null {
  const credits = usageResetCredits(record);
  if (!credits) return null;
  return <div className="usage-reset-credits">
    <strong>초기화권</strong>
    <b>{credits.availableCount}개</b>
    <span>{credits.expiresAt ? `${credits.availableCount > 1 ? "가장 이른 " : ""}기한 ${formatUsageResetAt(credits.expiresAt)}` : "기한 정보 없음"}</span>
    {canRedeem && credits.availableCount > 0 && <button type="button" className="usage-reset-redeem" disabled={redeeming} onClick={onRedeem}>{redeeming ? "사용 중…" : "사용하기"}</button>}
  </div>;
}

// 사용량과 호스트 자원 요약을 대시보드 카드로 표시한다.
export function Overview({ user, deploymentSecurity, providers, providerCapabilities, providerCanaries, providerUpdates, providerRollouts, providerRolloutConfigured, usage, system, runtime, refresh }: Json): React.ReactElement {
  const canRunTests = user?.role === "admin" || user?.access_scope === "test_only";
  // 새로고침 버튼으로 해당 공급자의 사용량을 즉시 다시 조회하도록 요청한다(실제 파싱 결과는
  // usage_updated 브로드캐스트를 통해 usage 목록이 갱신되면서 반영된다).
  async function refreshUsage(provider: string): Promise<void> {
    try {
      await api(`/usage/${provider}/refresh`, { method: "POST" });
    } catch (error: any) {
      window.alert(error?.message || "사용량 새로고침 요청에 실패했습니다.");
    }
  }
  const [restartingUsageMonitor, setRestartingUsageMonitor] = useState<string | null>(null);
  // 공급자 모델 캐시와 실패 폴백 PTY를 비운 뒤 direct 수집을 다시 시작한다. API 경로 이름은
  // 이전 클라이언트 호환을 위해 restart를 유지한다(실행 중인 채팅에는 영향이 없다).
  async function restartUsageMonitor(provider: string): Promise<void> {
    setRestartingUsageMonitor(provider);
    try {
      await api(`/usage/${provider}/restart`, { method: "POST" });
    } catch (error: any) {
      window.alert(error?.message || "사용량 수집기 재시작에 실패했습니다.");
    } finally {
      setRestartingUsageMonitor(null);
    }
  }
  const [redeemingResetCredit, setRedeemingResetCredit] = useState(false);
  const [updatingProvider, setUpdatingProvider] = useState<string | null>(null);
  const [rollingBackProvider, setRollingBackProvider] = useState<string | null>(null);
  const [changingRolloutProvider, setChangingRolloutProvider] = useState<string | null>(null);
  const [runningCanary, setRunningCanary] = useState<string | null>(null);
  const [candidateVersions, setCandidateVersions] = useState<Record<string, string>>({});
  async function runProviderCanary(provider: string): Promise<void> {
    const candidateVersion = candidateVersions[provider]?.trim();
    if (!candidateVersion) {
      window.alert("테스트할 후보 CLI 버전을 입력하세요.");
      return;
    }
    setRunningCanary(provider);
    try {
      await api(`/providers/${provider}/canaries`, {
        method: "POST",
        headers: { "Idempotency-Key": createClientUuid() },
        body: JSON.stringify({ candidateVersion }),
      });
      await refresh();
    } catch (error: any) {
      window.alert(error?.message || `${providerLabel(provider)} CLI canary 실행에 실패했습니다.`);
    } finally {
      setRunningCanary(null);
    }
  }
  // 확인창 뒤 Codex 맨 위 Full reset 초기화권 하나를 사용하고 대시보드 데이터를 다시 읽는다.
  async function redeemResetCredit(record: Json): Promise<void> {
    const credits = usageResetCredits(record);
    if (!credits || credits.availableCount < 1) return;
    const expiry = credits.expiresAt ? `\n기한: ${formatUsageResetAt(credits.expiresAt)}` : "";
    if (!window.confirm(`맨 위 Full reset 초기화권 1개를 사용해 현재 Codex 사용량을 초기화할까요?${expiry}\n\n사용한 초기화권은 되돌릴 수 없습니다.`)) return;
    setRedeemingResetCredit(true);
    try {
      await api("/usage/codex/reset-credit/redeem", { method: "POST", body: JSON.stringify({ accountId: record.account_id }) });
      await refresh();
      window.alert("Codex 초기화권을 사용했습니다.");
    } catch (error: any) {
      window.alert(error?.message || "Codex 초기화권 사용에 실패했습니다.");
    } finally {
      setRedeemingResetCredit(false);
    }
  }
  // 설치 업데이트는 해당 공급자의 실행 중 작업까지 재시작하므로 명시적으로 확인한 뒤 한 번만 보낸다.
  async function updateProviderCli(provider: string, canaryRunId: string, rolloutRunId?: string): Promise<void> {
    const label = providerLabel(provider);
    if (!window.confirm(`${label} CLI를 최신 버전으로 업데이트할까요?\n\n업데이트가 끝나면 ${label}의 실행 중인 모든 채팅과 모델·사용량 조회 터미널이 재시작됩니다. 진행 중인 응답은 중단될 수 있습니다.`)) return;
    setUpdatingProvider(provider);
    try {
      const result = await api(`/providers/${provider}/update`, { method: "POST", headers: { "Idempotency-Key": createClientUuid() }, body: JSON.stringify({ canaryRunId, ...(rolloutRunId ? { rolloutRunId } : {}) }) });
      await refresh();
      if (result.failures?.length || result.warnings?.length) {
        const details = [
          ...(result.warnings || []),
          ...(result.failures || []).map((item: Json) => `#${item.chatId}: ${item.error}`),
        ].join("\n");
        window.alert(`${label} CLI 업데이트는 완료됐지만 확인할 항목이 있습니다.\n\n${details}`);
      } else {
        window.alert(`${label} CLI 업데이트와 터미널 재시작이 완료되었습니다.\n${result.previousVersion || "이전 버전 미상"} → ${result.currentVersion}`);
      }
    } catch (error: any) {
      window.alert(error?.message || `${label} CLI 업데이트에 실패했습니다.`);
    } finally {
      setUpdatingProvider(null);
    }
  }
  async function startProviderRollout(provider: string, canaryRunId: string): Promise<void> {
    setChangingRolloutProvider(provider);
    try {
      await api(`/providers/${provider}/rollouts`, { method: "POST", headers: { "Idempotency-Key": createClientUuid() }, body: JSON.stringify({ canaryRunId, maxNewChats: 1 }) });
      await refresh();
      window.alert("단계 rollout을 시작했습니다. 다음 신규 채팅 1개가 후보 CLI로 실행됩니다.");
    } catch (error: any) {
      window.alert(error?.message || "단계 rollout 시작에 실패했습니다.");
    } finally { setChangingRolloutProvider(null); }
  }
  async function haltProviderRollout(provider: string, runId: string): Promise<void> {
    if (!window.confirm("단계 rollout을 중단할까요? 후보 채팅을 다시 시작하면 기존 CLI로 돌아갑니다.")) return;
    setChangingRolloutProvider(provider);
    try {
      await api(`/providers/${provider}/rollouts/${runId}/halt`, { method: "POST" });
      await refresh();
    } catch (error: any) {
      window.alert(error?.message || "단계 rollout 중단에 실패했습니다.");
    } finally { setChangingRolloutProvider(null); }
  }
  async function rollbackProviderCli(provider: string, runId: string): Promise<void> {
    const label = providerLabel(provider);
    if (!window.confirm(`${label} CLI를 업데이트 전 버전으로 롤백할까요?\n\n검증된 백업만 복원하며 ${label}의 실행 중 채팅과 조회 터미널이 재시작됩니다.`)) return;
    setRollingBackProvider(provider);
    try {
      const result = await api(`/providers/${provider}/updates/${runId}/rollback`, { method: "POST", headers: { "Idempotency-Key": createClientUuid() } });
      await refresh();
      window.alert(`${label} CLI 롤백이 완료되었습니다.\n복원 버전: ${result.restoredVersion || "확인 필요"}`);
    } catch (error: any) {
      await refresh();
      window.alert(error?.message || `${label} CLI 롤백에 실패했습니다.`);
    } finally {
      setRollingBackProvider(null);
    }
  }
  // 사용량 파싱이 이상하거나 실패했을 때 숫자만으로는 원인을 알기 어려워, 파서에 실제로 넘어간
  // 원본 터미널 화면을 그대로 웹에서 볼 수 있게 한다(실사용 요청으로 추가).
  const [snapshots, setSnapshots] = useState<Record<string, { text: string; capturedAt: string } | null>>({});
  async function loadSnapshot(provider: string): Promise<void> {
    try {
      const data = await api(`/usage/${provider}/snapshot`);
      setSnapshots((current) => ({ ...current, [provider]: data.snapshot }));
    } catch (error: any) {
      window.alert(error?.message || "터미널 스냅샷 조회에 실패했습니다.");
    }
  }
  function closeSnapshot(provider: string): void {
    setSnapshots((current) => { const next = { ...current }; delete next[provider]; return next; });
  }
  const latest = system?.latest;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  // 웹소켓 실시간 갱신과 별개로 1분마다 자원·사용량을 안전하게 다시 불러온다.
  useEffect(() => {
    const timer = setInterval(() => { void Promise.resolve(refreshRef.current()).catch(() => undefined); }, 60_000);
    return () => clearInterval(timer);
  }, []);
  const [sortKey, setSortKey] = useState("cpu");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const providerList = Array.isArray(providers) ? providers : [];
  const providerLabel = (provider: string): string => providerList.find((item: Json) => item.id === provider)?.label || provider;
  const usageWindowLabel = (provider: string, window: Json): string => {
    const metadata = providerList.find((item: Json) => item.id === provider);
    return metadata?.usageWindowLabels?.[window.id] || window.label || "사용량";
  };
  // 같은 컬럼을 다시 누르면 방향만 뒤집고, 다른 컬럼이면 그 컬럼의 내림차순부터 시작한다.
  function toggleSort(key: string): void {
    if (key === sortKey) setSortDir((current) => current === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("desc"); }
  }
  function sortIndicator(key: string): string {
    return sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : "";
  }
  const processGroups = useMemo(() => groupProcesses(latest?.processes ?? [], sortKey, sortDir), [latest?.processes, sortKey, sortDir]);
  // 묶음은 기본적으로 접어두고 필요한 것만 펼쳐 본다(채팅 하나에 프로세스가 3개씩 붙어 표가 길어지던 문제).
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  function toggleGroup(key: string): void {
    setExpandedGroups((current) => ({ ...current, [key]: !current[key] }));
  }
  const [killingPid, setKillingPid] = useState<number | null>(null);
  const [killingGroup, setKillingGroup] = useState<string | null>(null);
  // 종료·강제 종료 모두 되돌릴 수 없는 조작이라 실행 전 확인을 받는다.
  async function killProcess(pid: number, force: boolean): Promise<void> {
    const label = force ? "강제 종료(SIGKILL)" : "종료(SIGTERM)";
    if (!window.confirm(`PID ${pid} 프로세스를 ${label}할까요?`)) return;
    setKillingPid(pid);
    try {
      await api(`/system/processes/${pid}/kill`, { method: "POST", body: JSON.stringify({ force }) });
    } catch (error: any) {
      window.alert(error?.message || "프로세스 종료에 실패했습니다.");
    } finally {
      setKillingPid(null);
    }
  }
  // 묶음에 속한 프로세스를 한 번에 종료한다. 부모를 죽여도 자식은 고아로 살아남는 것을 실측해서(2026-08-06)
  // 부모만 보내지 않고 전부 보낸다. 자식(나중에 생긴 pid)부터 보내 부모가 되살리는 경우를 줄인다.
  async function killGroup(group: ProcessGroupRow, force: boolean): Promise<void> {
    const label = force ? "강제 종료(SIGKILL)" : "종료(SIGTERM)";
    const preview = group.processes.map((process: Json) => `${process.name}(${process.pid})`).join(", ");
    if (!window.confirm(`"${group.label}" 묶음의 프로세스 ${group.processes.length}개를 ${label}할까요?\n\n${preview}\n\n되돌릴 수 없습니다.`)) return;
    setKillingGroup(group.key);
    const failures: string[] = [];
    for (const process of [...group.processes].sort((a: Json, b: Json) => b.pid - a.pid)) {
      try {
        await api(`/system/processes/${process.pid}/kill`, { method: "POST", body: JSON.stringify({ force }) });
      } catch (error: any) {
        failures.push(`${process.name}(${process.pid}): ${error?.message || "실패"}`);
      }
    }
    setKillingGroup(null);
    if (failures.length) window.alert(`일부 프로세스를 종료하지 못했습니다.\n\n${failures.join("\n")}`);
  }
  // 채팅 묶음은 PID별 신호 대신 세션 관리자의 정상 터미널 종료 경로를 사용한다.
  async function stopChatTerminal(group: ProcessGroupRow): Promise<void> {
    if (!group.chatId) return;
    if (!window.confirm(`"${group.label}" 채팅 터미널을 종료할까요?\n\n진행 중인 작업과 리밋 재개 대기도 함께 종료됩니다.`)) return;
    setKillingGroup(group.key);
    try {
      await api(`/chats/${group.chatId}/stop`, { method: "POST" });
    } catch (error: any) {
      window.alert(error?.message || "터미널 종료에 실패했습니다.");
    } finally {
      setKillingGroup(null);
    }
  }
  return <section className="content-grid">
    <div className="section-head"><div><span className="eyebrow">실시간 현황</span><h2>운영 대시보드</h2></div><button onClick={() => void Promise.resolve(refresh()).catch(() => undefined)}>새로고침</button></div>
    {user.role === "admin" && deploymentSecurity?.issues?.length > 0 && <article className="deployment-security-warning" role="alert"><strong>외부 접속 보안 설정을 확인하세요</strong>{deploymentSecurity.issues.map((issue: Json) => <span key={issue.code}><b>{issue.message}</b><small>{issue.remediation}</small></span>)}</article>}
    <div className="cards">
      {usage.map((item: Json) => <article className="card usage-card" key={item.provider}>
        <div className="card-top">
          <span className={`provider ${item.provider}`}>{providerLabel(item.provider)}</span><span className={`dot ${item.data_status}`} />{item.monitor_status}
          <button className="usage-refresh" disabled={item.monitor_status === "refreshing"} onClick={() => void refreshUsage(item.provider)}>
            {item.monitor_status === "refreshing" ? "새로고침 중…" : "새로고침"}
          </button>
          <button
            className="usage-refresh"
            disabled={restartingUsageMonitor === item.provider}
            title="사용량·모델 캐시와 실패 폴백을 초기화하고 direct 조회를 다시 시작합니다(실행 중인 채팅에는 영향 없음)."
            onClick={() => void restartUsageMonitor(item.provider)}
          >
            {restartingUsageMonitor === item.provider ? "재시작 중…" : "수집기 재시작"}
          </button>
          <button className="usage-refresh" onClick={() => void loadSnapshot(item.provider)}>조회 원본</button>
        </div>
        <p className="usage-parsed-at">마지막 조회 {formatTimestamp(item.last_checked_at)}{item.data_status === "stale" && ` · 마지막 직접 확인 ${formatTimestamp(item.last_success_at)}`}</p>
        {item.error_code && <p className="usage-parsed-at">{usageErrorLabel(item.error_code)}</p>}
        {item.keepalive_sent_at && <p className="usage-parsed-at">세션 유지 단답 · 마지막 전송 {formatTimestamp(item.keepalive_sent_at)} · {keepaliveReasonLabel(item.keepalive_reason)}</p>}
        {usageWindows(item).map((window) => <div className="meter-row" key={window.id}>
          <div><strong title={window.label || undefined}>{usageWindowLabel(item.provider, window)}</strong><span>{window.resetAt ? `초기화 ${formatUsageResetAt(window.resetAt)}` : ""}</span></div>
          <div className="meter"><i style={{ width: `${window.usedPercent || 0}%` }} /></div><b>{window.usedPercent}%</b>
        </div>)}
        {item.provider === "codex" && <ResetCreditsSummary record={item} canRedeem={user?.role === "admin"} redeeming={redeemingResetCredit} onRedeem={() => void redeemResetCredit(item)} />}
        {!usageWindows(item).length && !item.error_code && <p className="muted">조회 중</p>}
        {item.provider in snapshots && (snapshots[item.provider]
          ? <div className="usage-snapshot">
              <div className="git-box-head"><h4>사용량 조회 원본</h4><span>{formatTimestamp(snapshots[item.provider]!.capturedAt)}</span><button onClick={() => closeSnapshot(item.provider)}>닫기</button></div>
              <pre className="usage-snapshot-text">{snapshots[item.provider]!.text}</pre>
            </div>
          : <p className="muted">아직 저장된 조회 원본이 없습니다(서버가 최근에 시작됐을 수 있음). <button onClick={() => closeSnapshot(item.provider)}>닫기</button></p>)}
      </article>)}
      <article className="card"><div className="card-top">호스트 자원</div>
        <div className="stat-pair"><span>CPU<b>{latest ? `${latest.cpuPercent.toFixed(1)}%` : "-"}</b></span><span>메모리<b>{latest ? `${((latest.memory.total - latest.memory.available) / latest.memory.total * 100).toFixed(1)}%` : "-"}</b></span></div>
        <div className="small-list">{latest?.disks?.slice(0, 3).map((disk: Json) => <span key={disk.mount}>{disk.mount} · {disk.usePercent.toFixed(0)}% · {bytes(disk.used)}</span>)}</div>
      </article>
      <article className="card"><div className="card-top">런타임</div><div className="small-list runtime-list">
        {Object.entries(runtime || {}).map(([name, value]) => {
          const provider = providerList.find((item: Json) => item.id === name);
          const latestCanary = (providerCanaries || []).find((item: Json) => item.run?.provider === name);
          const latestUpdate = (providerUpdates || []).find((item: Json) => item.provider === name);
          const latestRollout = (providerRollouts || []).find((item: Json) => item.provider === name);
          const canaryReady = latestCanary?.run?.state === "passed" && latestCanary?.run?.currentVersion === value;
          const rolloutReady = !providerRolloutConfigured || (latestRollout?.state === "active" && latestRollout.assignedCount >= latestRollout.maxNewChats && latestRollout.errorCount === 0);
          const canUpdate = canaryReady && rolloutReady;
          const canRollback = ["applied", "rollback_required", "rollback_failed"].includes(String(latestUpdate?.state || ""));
          return <span key={name}><span><b>{name}</b> {String(value || "없음")}{latestUpdate && <small> · update {latestUpdate.state}</small>}{latestRollout && <small> · rollout {latestRollout.state} {latestRollout.assignedCount}/{latestRollout.maxNewChats} · 오류 {latestRollout.errorCount}</small>}</span>{user?.role === "admin" && provider?.supportsCliUpdate && <span className="runtime-actions">
            {providerRolloutConfigured && canaryReady && latestRollout?.state !== "active" && <button type="button" disabled={changingRolloutProvider !== null} onClick={() => void startProviderRollout(name, latestCanary.run.id)}>{changingRolloutProvider === name ? "준비 중…" : "단계 시작"}</button>}
            {providerRolloutConfigured && latestRollout?.state === "active" && <button type="button" disabled={changingRolloutProvider !== null} onClick={() => void haltProviderRollout(name, latestRollout.id)}>단계 중단</button>}
            <button type="button" disabled={updatingProvider !== null || rollingBackProvider !== null || !canUpdate} title={canUpdate ? "통과한 canary 후보를 적용합니다." : "현재 버전 canary와 오류 없는 단계 rollout이 필요합니다."} onClick={() => void updateProviderCli(name, latestCanary.run.id, providerRolloutConfigured ? latestRollout?.id : undefined)}>{updatingProvider === name ? "업데이트 중…" : providerRolloutConfigured ? "전체 적용" : "업데이트"}</button>
            {canRollback && <button type="button" className="danger" disabled={updatingProvider !== null || rollingBackProvider !== null} onClick={() => void rollbackProviderCli(name, latestUpdate.id)}>{rollingBackProvider === name ? "롤백 중…" : "롤백"}</button>}
          </span>}</span>;
        })}
        {(providerCapabilities || []).map((capability: Json) => <span key={`capability:${capability.provider}`} title={(capability.fallbackReasons || []).join(", ")}>
          <span><b>{capability.provider} 경로</b> {capability.structuredSession ? "구조화 세션" : "Hook·JSONL + TUI 폴백"}</span>
        </span>)}
        {canRunTests && providerList.filter((provider: Json) => provider.supportsCliUpdate).map((provider: Json) => {
          const latestCanary = (providerCanaries || []).find((item: Json) => item.run?.provider === provider.id);
          const state = latestCanary?.run?.state;
          const stateLabel = state === "passed" ? "통과" : state === "failed" ? "실패" : state === "blocked" ? "확인 필요" : "미실행";
          const diffCount = Array.isArray(latestCanary?.run?.capabilityDiff) ? latestCanary.run.capabilityDiff.length : 0;
          const canarySteps = Array.isArray(latestCanary?.steps) ? latestCanary.steps as Json[] : [];
          const passedSteps = canarySteps.filter((step: Json) => step.state === "passed").length;
          const maxStepDuration = canarySteps.reduce((maximum: number, step: Json) => Math.max(maximum, Number(step.durationMs) || 0), 0);
          return <div className="runtime-canary" key={`canary:${provider.id}`}>
            <div className="runtime-canary-head"><span><b>{provider.label} canary</b> <i className={`canary-state ${state || "none"}`}>{stateLabel}</i></span>
              {latestCanary?.run && <small>{latestCanary.run.currentVersion || "현재 미상"} → {latestCanary.run.candidateVersion} · capability 변경 {diffCount}개</small>}
            </div>
            <div className="runtime-canary-controls">
              <input aria-label={`${provider.label} 후보 CLI 버전`} value={candidateVersions[provider.id] || ""} placeholder="후보 버전" onChange={(event) => setCandidateVersions((current) => ({ ...current, [provider.id]: event.target.value }))} />
              <button type="button" disabled={runningCanary !== null} onClick={() => void runProviderCanary(provider.id)}>{runningCanary === provider.id ? "canary 실행 중…" : "canary 실행"}</button>
            </div>
            {!!canarySteps.length && <details className="canary-evidence"><summary>단계 증거 {passedSteps}/{canarySteps.length} · 최대 {maxStepDuration}ms</summary><div>
              {canarySteps.map((step: Json) => <span key={`${provider.id}:${step.ordinal}`}><b>{step.name}</b> {step.state} · {Number(step.durationMs) || 0}ms{step.evidence?.code ? ` · ${step.evidence.code}` : ""}</span>)}
            </div></details>}
          </div>;
        })}
      </div></article>
    </div>
    <TokenUsageAnalytics />
    <article className="card process-card"><h3>에이전트 프로세스</h3><div className="table-wrap"><table><thead><tr>
      <th className="sortable" onClick={() => toggleSort("name")}>묶음 / 프로세스{sortIndicator("name")}</th>
      <th className="sortable" onClick={() => toggleSort("pid")}>PID{sortIndicator("pid")}</th>
      <th className="sortable" onClick={() => toggleSort("cpu")}>CPU{sortIndicator("cpu")}</th>
      <th className="sortable" onClick={() => toggleSort("memory")}>메모리{sortIndicator("memory")}</th>
      {user?.role === "admin" && <th>작업</th>}
    </tr></thead><tbody>
      {processGroups.map((group) => <React.Fragment key={group.key}>
        <tr className={`process-group-row process-group-${group.kind}`}>
          <td>
            <button type="button" className="process-group-toggle" aria-expanded={!!expandedGroups[group.key]} onClick={() => toggleGroup(group.key)}>
              <span className="process-group-caret">{expandedGroups[group.key] ? "▾" : "▸"}</span>
              <span className={`process-group-badge kind-${group.kind}`}>{GROUP_KIND_LABEL[group.kind] ?? group.kind}</span>
              <b>{group.label}</b>
              <span className="process-group-count">{group.processes.length}개</span>
            </button>
          </td>
          <td className="muted" data-label="PID">-</td>
          <td data-label="CPU">{group.cpu.toFixed(1)}%</td>
          <td data-label="메모리">{bytes(group.memory)}</td>
          {user?.role === "admin" && <td className="process-actions">
            {/* 시스템 묶음에는 서버 본체와 이를 띄운 watch 프로세스가 들어 있어 종료하면 앱이 내려간다. */}
            {group.kind === "system" ? <span className="muted process-protected">앱 구동에 필요</span> : group.kind === "chat" ?
              <button disabled={killingGroup === group.key} onClick={() => void stopChatTerminal(group)}>{killingGroup === group.key ? "종료 중…" : "터미널 종료"}</button> : <>
              <button disabled={killingGroup === group.key} onClick={() => void killGroup(group, false)}>{killingGroup === group.key ? "종료 중…" : "묶음 종료"}</button>
              <button className="danger" disabled={killingGroup === group.key} onClick={() => void killGroup(group, true)}>강제</button>
            </>}
          </td>}
        </tr>
        {expandedGroups[group.key] && group.processes.map((process: Json) => <tr key={process.pid} className="process-child-row">
          <td className="process-child-name">{process.name}</td>
          <td data-label="PID">{process.pid}</td><td data-label="CPU">{process.cpu.toFixed(1)}%</td><td data-label="메모리">{bytes(process.memory)}</td>
          {user?.role === "admin" && <td className="process-actions">
            {group.kind === "system" ? <span className="muted process-protected">앱 구동에 필요</span> : <>
              <button disabled={killingPid === process.pid} onClick={() => void killProcess(process.pid, false)}>종료</button>
              <button className="danger" disabled={killingPid === process.pid} onClick={() => void killProcess(process.pid, true)}>강제종료</button>
            </>}
          </td>}
        </tr>)}
      </React.Fragment>)}
      {!processGroups.length && <tr><td colSpan={user?.role === "admin" ? 5 : 4} className="muted">표시할 프로세스가 없습니다.</td></tr>}
    </tbody></table></div></article>
  </section>;
}
