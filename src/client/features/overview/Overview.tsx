import React, { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import { bytes, usageErrorLabel, usageResetCredits, usageWindows } from "../../lib/format";
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

// 관리자 전용 Slack bot token·channel id 설정 카드를 표시한다.
function SlackSettingsCard(): React.ReactElement {
  const [settings, setSettings] = useState<Json | null>(null);
  const [botToken, setBotToken] = useState("");
  const [channelId, setChannelId] = useState("");
  const [status, setStatus] = useState("");
  useEffect(() => { void api("/admin/slack-settings").then((data) => { setSettings(data); setChannelId(data.channelId || ""); }).catch(() => undefined); }, []);
  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setStatus("저장 중…");
    try {
      const data = await api("/admin/slack-settings", { method: "PUT", body: JSON.stringify({ botToken, channelId }) });
      setSettings(data); setBotToken(""); setStatus("저장했습니다.");
    } catch (error: any) {
      setStatus(error?.message || "저장에 실패했습니다.");
    }
  }
  async function test(): Promise<void> {
    setStatus("테스트 메시지 전송 중…");
    try { await api("/slack/test", { method: "POST" }); setStatus("테스트 메시지를 보냈습니다."); } catch (error: any) { setStatus(error?.message || "전송에 실패했습니다."); }
  }
  return <article className="card"><div className="card-top">Slack 설정</div>
    <form className="slack-settings-form" onSubmit={save}>
      <label>Bot Token<input type="password" value={botToken} onChange={(event) => setBotToken(event.target.value)} placeholder={settings?.botTokenConfigured ? "설정됨 (바꾸려면 새로 입력)" : "xoxb-..."} /></label>
      <label>Channel ID<input value={channelId} onChange={(event) => setChannelId(event.target.value)} placeholder="C0123456789" /></label>
      <div className="slack-settings-actions"><button className="primary">저장</button><button type="button" onClick={test}>테스트 전송</button></div>
      {status && <span className="attachment-status">{status}</span>}
    </form>
  </article>;
}

// 관리자 전용 유휴 채팅 자동 종료 정책 카드를 표시한다.
function IdleChatSettingsCard(): React.ReactElement {
  const [enabled, setEnabled] = useState(true);
  const [timeoutHours, setTimeoutHours] = useState(24);
  const [status, setStatus] = useState("");
  useEffect(() => {
    void api("/admin/idle-chat-settings")
      .then((data) => { setEnabled(!!data.enabled); setTimeoutHours(Number(data.timeoutHours) || 24); })
      .catch(() => undefined);
  }, []);
  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setStatus("저장 중…");
    try {
      const data = await api("/admin/idle-chat-settings", { method: "PUT", body: JSON.stringify({ enabled, timeoutHours }) });
      setEnabled(!!data.enabled); setTimeoutHours(Number(data.timeoutHours)); setStatus("저장했습니다.");
    } catch (error: any) {
      setStatus(error?.message || "저장에 실패했습니다.");
    }
  }
  return <article className="card"><div className="card-top">유휴 채팅 자동 종료</div>
    <form className="slack-settings-form" onSubmit={save}>
      <label className="idle-toggle"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />설정한 시간 동안 아무 활동이 없는 터미널을 자동 종료</label>
      <label>기준 시간(시간)<input type="number" min={1} max={720} value={timeoutHours} onChange={(event) => setTimeoutHours(Number(event.target.value))} /></label>
      <p className="muted idle-note">작업 중이거나 리밋 재개를 기다리거나 승인 응답을 기다리는 채팅은 종료하지 않습니다. 10분마다 검사합니다.</p>
      <div className="slack-settings-actions"><button className="primary">저장</button></div>
      {status && <span className="attachment-status">{status}</span>}
    </form>
  </article>;
}

// 관리자 전용 ntfy topic·서버 URL 설정 카드를 표시한다.
function NtfySettingsCard(): React.ReactElement {
  const [settings, setSettings] = useState<Json | null>(null);
  const [topic, setTopic] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [status, setStatus] = useState("");
  useEffect(() => { void api("/admin/ntfy-settings").then((data) => { setSettings(data); setTopic(data.topic || ""); setServerUrl(data.serverUrl || ""); }).catch(() => undefined); }, []);
  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setStatus("저장 중…");
    try {
      const data = await api("/admin/ntfy-settings", { method: "PUT", body: JSON.stringify({ topic, serverUrl }) });
      setSettings(data); setStatus("저장했습니다.");
    } catch (error: any) {
      setStatus(error?.message || "저장에 실패했습니다.");
    }
  }
  async function test(): Promise<void> {
    setStatus("테스트 알림 전송 중…");
    try { await api("/ntfy/test", { method: "POST" }); setStatus("테스트 알림을 보냈습니다."); } catch (error: any) { setStatus(error?.message || "전송에 실패했습니다."); }
  }
  return <article className="card"><div className="card-top">ntfy 설정</div>
    <form className="slack-settings-form" onSubmit={save}>
      <label>Topic<input value={topic} onChange={(event) => setTopic(event.target.value)} placeholder={settings?.topic || "my_web_agent_z6119"} /></label>
      <label>서버 URL<input value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="https://ntfy.sh" /></label>
      <div className="slack-settings-actions"><button className="primary">저장</button><button type="button" onClick={test}>테스트 전송</button></div>
      {status && <span className="attachment-status">{status}</span>}
    </form>
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
    <span>{credits.expiresAt ? `${credits.availableCount > 1 ? "가장 이른 " : ""}기한 ${formatTimestamp(credits.expiresAt)}` : "기한 정보 없음"}</span>
    {canRedeem && credits.availableCount > 0 && <button type="button" className="usage-reset-redeem" disabled={redeeming} onClick={onRedeem}>{redeeming ? "사용 중…" : "사용하기"}</button>}
  </div>;
}

// 사용량과 호스트 자원 요약을 대시보드 카드로 표시한다.
export function Overview({ user, providers, usage, system, runtime, slack, ntfy, refresh }: Json): React.ReactElement {
  // 새로고침 버튼으로 해당 공급자의 사용량을 즉시 다시 조회하도록 요청한다(실제 파싱 결과는
  // usage_updated 브로드캐스트를 통해 usage 목록이 갱신되면서 반영된다).
  async function refreshUsage(provider: string): Promise<void> {
    try {
      await api(`/usage/${provider}/refresh`, { method: "POST" });
    } catch (error: any) {
      window.alert(error?.message || "사용량 새로고침 요청에 실패했습니다.");
    }
  }
  const [redeemingResetCredit, setRedeemingResetCredit] = useState(false);
  // 확인창 뒤 Codex 맨 위 Full reset 초기화권 하나를 사용하고 대시보드 데이터를 다시 읽는다.
  async function redeemResetCredit(record: Json): Promise<void> {
    const credits = usageResetCredits(record);
    if (!credits || credits.availableCount < 1) return;
    const expiry = credits.expiresAt ? `\n기한: ${formatTimestamp(credits.expiresAt)}` : "";
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
    const timer = setInterval(() => { void refreshRef.current(); }, 60_000);
    return () => clearInterval(timer);
  }, []);
  const [sortKey, setSortKey] = useState("cpu");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const providerList = Array.isArray(providers) ? providers : [];
  const providerLabel = (provider: string): string => providerList.find((item: Json) => item.id === provider)?.label || provider;
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
    <div className="section-head"><div><span className="eyebrow">실시간 현황</span><h2>운영 대시보드</h2></div><button onClick={refresh}>새로고침</button></div>
    <div className="cards">
      {usage.map((item: Json) => <article className="card usage-card" key={item.provider}>
        <div className="card-top">
          <span className={`provider ${item.provider}`}>{providerLabel(item.provider)}</span><span className={`dot ${item.data_status}`} />{item.monitor_status}
          <button className="usage-refresh" disabled={item.monitor_status === "refreshing"} onClick={() => void refreshUsage(item.provider)}>
            {item.monitor_status === "refreshing" ? "새로고침 중…" : "새로고침"}
          </button>
          <button className="usage-refresh" onClick={() => void loadSnapshot(item.provider)}>터미널 보기</button>
        </div>
        <p className="usage-parsed-at">파싱 시각 {formatTimestamp(item.last_checked_at)}{item.data_status === "stale" && ` · 마지막 성공 ${formatTimestamp(item.last_success_at)}`}</p>
        {item.keepalive_sent_at && <p className="usage-parsed-at">세션 유지 단답 · 마지막 전송 {formatTimestamp(item.keepalive_sent_at)} · {keepaliveReasonLabel(item.keepalive_reason)}</p>}
        {usageWindows(item).map((window) => <div className="meter-row" key={window.id}>
          <div><strong>{window.label}</strong><span>{window.resetAt ? `초기화 ${window.resetAt}` : ""}</span></div>
          <div className="meter"><i style={{ width: `${window.usedPercent || 0}%` }} /></div><b>{window.usedPercent}%</b>
        </div>)}
        {item.provider === "codex" && <ResetCreditsSummary record={item} canRedeem={user?.role === "admin"} redeeming={redeemingResetCredit} onRedeem={() => void redeemResetCredit(item)} />}
        {!usageWindows(item).length && <p className="muted">{usageErrorLabel(item.error_code)}</p>}
        {item.provider in snapshots && (snapshots[item.provider]
          ? <div className="usage-snapshot">
              <div className="git-box-head"><h4>터미널 스냅샷</h4><span>{formatTimestamp(snapshots[item.provider]!.capturedAt)}</span><button onClick={() => closeSnapshot(item.provider)}>닫기</button></div>
              <pre className="usage-snapshot-text">{snapshots[item.provider]!.text}</pre>
            </div>
          : <p className="muted">아직 조회된 스냅샷이 없습니다(서버가 최근에 시작됐을 수 있음). <button onClick={() => closeSnapshot(item.provider)}>닫기</button></p>)}
      </article>)}
      <article className="card"><div className="card-top">호스트 자원</div>
        <div className="stat-pair"><span>CPU<b>{latest ? `${latest.cpuPercent.toFixed(1)}%` : "-"}</b></span><span>메모리<b>{latest ? `${((latest.memory.total - latest.memory.available) / latest.memory.total * 100).toFixed(1)}%` : "-"}</b></span></div>
        <div className="small-list">{latest?.disks?.slice(0, 3).map((disk: Json) => <span key={disk.mount}>{disk.mount} · {disk.usePercent.toFixed(0)}% · {bytes(disk.used)}</span>)}</div>
      </article>
      <article className="card"><div className="card-top">런타임</div><div className="small-list">
        {Object.entries(runtime || {}).map(([name, value]) => <span key={name}><b>{name}</b> {String(value || "없음")}</span>)}
        <span><b>Slack</b> {slack?.enabled ? "연결됨" : "미설정"}</span>
        <span><b>ntfy</b> {ntfy?.enabled ? "연결됨" : "미설정"}</span>
      </div></article>
      {user?.role === "admin" && <SlackSettingsCard />}
      {user?.role === "admin" && <NtfySettingsCard />}
      {user?.role === "admin" && <IdleChatSettingsCard />}
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
