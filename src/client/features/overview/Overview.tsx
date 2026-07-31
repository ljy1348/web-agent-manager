import React, { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import { bytes, usageWindows } from "../../lib/format";
import type { Json } from "../../types";

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

// ISO 문자열 타임스탬프를 사람이 읽기 쉬운 로컬 시각으로 바꾼다.
function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
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
  const sortedProcesses = useMemo(() => {
    const list = [...(latest?.processes ?? [])];
    const dir = sortDir === "asc" ? 1 : -1;
    list.sort((a, b) => {
      const av = processSortValue(a, sortKey); const bv = processSortValue(b, sortKey);
      if (typeof av === "string" || typeof bv === "string") return dir * String(av).localeCompare(String(bv));
      return dir * (av - bv);
    });
    return list;
  }, [latest?.processes, sortKey, sortDir]);
  const [killingPid, setKillingPid] = useState<number | null>(null);
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
        {usageWindows(item).map((window) => <div className="meter-row" key={window.id}>
          <div><strong>{window.label}</strong><span>{window.resetAt ? `초기화 ${window.resetAt}` : ""}</span></div>
          <div className="meter"><i style={{ width: `${window.usedPercent || 0}%` }} /></div><b>{window.usedPercent}%</b>
        </div>)}
        {!usageWindows(item).length && <p className="muted">{item.error_code || "조회 중"}</p>}
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
    </div>
    <article className="card process-card"><h3>에이전트 프로세스</h3><div className="table-wrap"><table><thead><tr>
      <th className="sortable" onClick={() => toggleSort("pid")}>PID{sortIndicator("pid")}</th>
      <th className="sortable" onClick={() => toggleSort("name")}>프로세스{sortIndicator("name")}</th>
      <th className="sortable" onClick={() => toggleSort("cpu")}>CPU{sortIndicator("cpu")}</th>
      <th className="sortable" onClick={() => toggleSort("memory")}>메모리{sortIndicator("memory")}</th>
      <th className="sortable" onClick={() => toggleSort("chat")}>프로젝트/세션{sortIndicator("chat")}</th>
      {user?.role === "admin" && <th>작업</th>}
    </tr></thead><tbody>
      {sortedProcesses.map((process: Json) => <tr key={process.pid}>
        <td>{process.pid}</td><td>{process.name}</td><td>{process.cpu.toFixed(1)}%</td><td>{bytes(process.memory)}</td>
        <td>{process.chat ? `${process.chat.projectName} · ${process.chat.title}` : "-"}</td>
        {user?.role === "admin" && <td className="process-actions">
          <button disabled={killingPid === process.pid} onClick={() => void killProcess(process.pid, false)}>종료</button>
          <button className="danger" disabled={killingPid === process.pid} onClick={() => void killProcess(process.pid, true)}>강제종료</button>
        </td>}
      </tr>)}
    </tbody></table></div></article>
  </section>;
}
