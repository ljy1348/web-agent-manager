import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { createClientUuid } from "../../lib/client-uuid";
import { formatUsageResetAt } from "../../lib/format";
import type { Json } from "../../types";

const COLUMNS = [
  ["working", "Working"], ["needs_input", "Needs input"], ["verifying", "Verifying"],
  ["failed", "Failed"], ["completed", "Completed"], ["scheduled", "Scheduled"],
] as const;
const ACTIVITY: Record<string, string> = { active: "실행 중", idle: "idle", rate_limit_wait: "한도 대기", queued: "queue 대기", ready: "시작 대기" };

function shortId(value: unknown): string { return String(value ?? "").slice(0, 8); }

function taskTime(value: unknown): string {
  if (typeof value !== "string" || !value) return "시각 미상";
  const normalized = /Z$|[+-]\d\d:\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function TaskPreviewPanel({ task, admin }: { task: Json; admin: boolean }): React.ReactElement {
  const [url, setUrl] = useState(task.preview_url || "");
  const [width, setWidth] = useState(Number(task.preview_viewport_width) || 390);
  const [height, setHeight] = useState(Number(task.preview_viewport_height) || 844);
  const [target, setTarget] = useState(task.preview_url || "");
  const [candidates, setCandidates] = useState<Json[]>([]);
  const [candidatesLoaded, setCandidatesLoaded] = useState(false);
  const [editingTarget, setEditingTarget] = useState(!task.preview_url);
  const [manualTarget, setManualTarget] = useState(false);
  const [artifact, setArtifact] = useState<Json | null>(null);
  const [baselineId, setBaselineId] = useState(task.visual_baseline_artifact_id || "");
  const [visual, setVisual] = useState<Json | null>(null);
  const [busy, setBusy] = useState("");
  const [status, setStatus] = useState("");
  async function loadCandidates(): Promise<void> {
    if (!admin || candidatesLoaded || busy === "candidates") return;
    setBusy("candidates");
    try {
      const result = await api(`/projects/${task.project_id}/preview-candidates`);
      setCandidates(result.candidates || []); setCandidatesLoaded(true);
    } catch (error: any) { setStatus(error?.message || "실행 중인 웹 화면을 찾지 못했습니다."); setCandidatesLoaded(true); }
    finally { setBusy(""); }
  }
  async function saveTarget(nextUrl = url): Promise<void> {
    setBusy("target"); setStatus("주소를 저장하는 중…");
    try {
      const result = await api(`/projects/${task.project_id}/preview-target`, { method: "PUT", body: JSON.stringify({ url: nextUrl, viewportWidth: width, viewportHeight: height }) });
      setTarget(result.target.url); setUrl(result.target.url); setEditingTarget(false); setManualTarget(false); setStatus("웹 화면 주소를 저장했습니다.");
    } catch (error: any) { setStatus(error?.message || "주소 저장에 실패했습니다."); }
    finally { setBusy(""); }
  }
  async function capture(): Promise<void> {
    setBusy("capture"); setStatus("브라우저 증거를 수집하는 중…");
    try {
      const result = await api(`/tasks/${task.id}/preview-captures`, { method: "POST" });
      setArtifact(result.artifact); setStatus("screenshot·console·network 증거를 task에 연결했습니다.");
    } catch (error: any) { setStatus(error?.message || "preview 수집에 실패했습니다."); }
    finally { setBusy(""); }
  }
  async function setBaseline(): Promise<void> {
    if (!artifact) return;
    setBusy("baseline"); setStatus("현재 screenshot을 시각 기준선으로 지정하는 중…");
    try {
      const result = await api(`/tasks/${task.id}/visual-baseline`, { method: "PUT", body: JSON.stringify({ artifactId: artifact.id }) });
      setBaselineId(result.baseline.artifactId); setStatus("현재 screenshot을 시각 기준선으로 지정했습니다.");
    } catch (error: any) { setStatus(error?.message || "시각 기준선 지정에 실패했습니다."); }
    finally { setBusy(""); }
  }
  async function visualCheck(): Promise<void> {
    setBusy("visual"); setStatus("새 화면의 시각 회귀·접근성을 검사하는 중…");
    try {
      const result = await api(`/tasks/${task.id}/visual-checks`, { method: "POST" });
      setVisual(result.result); setArtifact(result.result.current || artifact); setStatus(result.result.comparable ? "시각 회귀·접근성 검사를 task에 연결했습니다." : "viewport가 달라 시각 비교를 만들지 못했습니다.");
    } catch (error: any) { setStatus(error?.message || "시각 회귀 검사에 실패했습니다."); }
    finally { setBusy(""); }
  }
  return <details className="task-preview-panel" onToggle={(event) => { if ((event.currentTarget as HTMLDetailsElement).open && !target) void loadCandidates(); }}><summary>웹 화면 확인</summary>
    {admin && target && !editingTarget && <div className="task-preview-current"><code>{target}</code><button type="button" onClick={() => { setEditingTarget(true); void loadCandidates(); }}>주소 변경</button></div>}
    {admin && editingTarget && <div className="task-preview-picker">
      {busy === "candidates" && <span className="muted">실행 중인 웹 화면을 찾는 중…</span>}
      {candidatesLoaded && candidates.length > 0 && <><span className="muted">실행 중인 화면을 선택하세요.</span><div className="task-preview-candidates">{candidates.map((candidate) => <button type="button" key={candidate.url} disabled={!!busy} onClick={() => void saveTarget(candidate.url)}>{candidate.label}</button>)}</div></>}
      {candidatesLoaded && candidates.length > 0 && !manualTarget && <button type="button" className="text-button" onClick={() => setManualTarget(true)}>직접 입력</button>}
      {candidatesLoaded && (!candidates.length || manualTarget) && <div className="task-preview-target"><p className="muted">개발 서버를 실행한 뒤 로컬 웹 주소를 입력하세요.</p><label>로컬 웹 주소<input value={url} placeholder="http://127.0.0.1:3000/" onChange={(event) => setUrl(event.target.value)} /></label><button type="button" disabled={!!busy || !url.trim()} onClick={() => void saveTarget()}>{busy === "target" ? "저장 중…" : "이 주소 사용"}</button></div>}
      {target && <button type="button" className="text-button" onClick={() => { setEditingTarget(false); setManualTarget(false); }}>취소</button>}
    </div>}
    {admin && <details className="task-preview-viewport"><summary>화면 크기</summary><div><label>폭<input type="number" min={320} max={1920} value={width} onChange={(event) => setWidth(Number(event.target.value))} /></label><label>높이<input type="number" min={240} max={1080} value={height} onChange={(event) => setHeight(Number(event.target.value))} /></label>{target && <button type="button" disabled={!!busy} onClick={() => void saveTarget(target)}>저장</button>}</div></details>}
    {target && <><iframe className="task-live-preview" src={target} sandbox="allow-scripts allow-forms" title={`${task.project_name} live preview`} /><div className="slack-settings-actions">{admin && <button type="button" disabled={!!busy} onClick={() => void capture()}>{busy === "capture" ? "수집 중…" : "증거 캡처"}</button>}{admin && artifact && <button type="button" disabled={!!busy} onClick={() => void setBaseline()}>{busy === "baseline" ? "지정 중…" : "현재 화면을 기준선으로"}</button>}{admin && baselineId && <button type="button" disabled={!!busy} onClick={() => void visualCheck()}>{busy === "visual" ? "검사 중…" : "시각·접근성 검사"}</button>}<a href={target} target="_blank" rel="noreferrer">새 창</a></div></>}
    {artifact && <div className="task-preview-evidence"><img src={`/api/workbench-artifacts/${encodeURIComponent(artifact.id)}`} alt="수집된 preview screenshot" /><small>{artifact.metadata.viewport.width}×{artifact.metadata.viewport.height} · {artifact.metadata.elapsedMs}ms · console {artifact.metadata.console.length} · network {artifact.metadata.network.length} · 접근성 위반 {artifact.metadata.accessibility?.violationCount ?? 0}</small>{artifact.metadata.console.slice(0, 5).map((event: Json, index: number) => <code key={`console-${index}`}>{event.level}: {event.text}</code>)}</div>}
    {visual && <div className="task-preview-evidence visual-regression-result">{visual.diffArtifact && <img src={`/api/workbench-artifacts/${encodeURIComponent(visual.diffArtifact.id)}`} alt="시각 회귀 diff" />}<strong>{visual.comparable ? `변경 픽셀 ${visual.changedPixels}/${visual.totalPixels} · ${(visual.changedRatio * 100).toFixed(3)}%` : "viewport 크기 불일치"}</strong><small>접근성 위반 {visual.accessibility?.violationCount ?? 0} · 규칙 {visual.accessibility?.ruleCount ?? 0}</small></div>}
    {status && <span className="attachment-status" aria-live="polite">{status}</span>}
  </details>;
}

const REMOTE_CAPABILITY_LABELS: Record<string, string> = { build: "Build", test: "Test", verify: "Verify", preview: "Preview" };

// 원격 실행은 task의 기존 mapping과 worker가 probe로 선언한 고정 capability만 선택한다.
function RemoteDispatchPanel({ task, admin }: { task: Json; admin: boolean }): React.ReactElement {
  const [loaded, setLoaded] = useState(false);
  const [mapping, setMapping] = useState<Json | null>(null);
  const [dispatches, setDispatches] = useState<Json[]>([]);
  const [capability, setCapability] = useState("verify");
  const [requestKey, setRequestKey] = useState("");
  const [busy, setBusy] = useState("");
  const [status, setStatus] = useState("");
  async function load(): Promise<void> {
    setBusy("load");
    try {
      const data = await api(`/tasks/${task.id}/remote-dispatches`);
      setMapping(data.mapping || null); setDispatches(data.dispatches || []); setLoaded(true);
      const capabilities = (data.mapping?.capabilities || []).filter((item: string) => item in REMOTE_CAPABILITY_LABELS);
      if (capabilities.length && !capabilities.includes(capability)) setCapability(capabilities[0]);
    } catch (error: any) { setStatus(error?.message || "remote dispatch 상태를 불러오지 못했습니다."); }
    finally { setBusy(""); }
  }
  async function dispatch(): Promise<void> {
    if (!mapping || !window.confirm(`${mapping.hostName}의 ${mapping.remotePath}에서 ${REMOTE_CAPABILITY_LABELS[capability] || capability} 작업을 시작할까요?`)) return;
    const key = requestKey || createClientUuid(); setRequestKey(key); setBusy("dispatch"); setStatus("원격 worker에 고정 task 요청을 전달하는 중…");
    try {
      const result = await api(`/tasks/${task.id}/remote-dispatches`, { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify({ capability }) });
      setDispatches((current) => [result.dispatch, ...current.filter((item) => item.id !== result.dispatch.id)]); setRequestKey("");
      setStatus(result.dispatch.state === "unknown" ? "수락 여부를 확인할 수 없습니다. 자동 재전송하지 않습니다." : `원격 작업이 ${result.dispatch.state} 상태로 접수됐습니다.`);
    } catch (error: any) { setStatus(`${error?.message || "remote dispatch에 실패했습니다."} 같은 요청 재시도에는 기존 멱등 키를 유지합니다.`); }
    finally { setBusy(""); }
  }
  async function refresh(item: Json): Promise<void> {
    setBusy(item.id); setStatus("원격 작업 상태를 확인하는 중…");
    try {
      const result = await api(`/tasks/${task.id}/remote-dispatches/${item.id}/refresh`, { method: "POST" });
      setDispatches((current) => current.map((entry) => entry.id === item.id ? result.dispatch : entry)); setStatus(`원격 작업 상태: ${result.dispatch.state}`);
    } catch (error: any) { setStatus(error?.message || "원격 상태 확인에 실패했습니다."); }
    finally { setBusy(""); }
  }
  const capabilities = (mapping?.capabilities || []).filter((item: string) => item in REMOTE_CAPABILITY_LABELS);
  return <details className="remote-dispatch-panel" onToggle={(event) => { if ((event.currentTarget as HTMLDetailsElement).open && !loaded && !busy) void load(); }}><summary>Remote worker dispatch</summary>
    {busy === "load" && <span className="muted">mapping과 실행 기록을 확인하는 중…</span>}
    {loaded && !mapping && <p className="muted">설정에서 이 프로젝트의 remote mapping을 먼저 등록하세요.</p>}
    {mapping && <div className="remote-dispatch-target"><strong>{mapping.hostName} · {mapping.remotePath}</strong><small>{mapping.hostStatus} · {capabilities.join(", ") || "실행 capability 없음"}</small></div>}
    {admin && mapping && <div className="remote-dispatch-actions"><select aria-label="Remote capability" value={capability} onChange={(event) => { setCapability(event.target.value); setRequestKey(""); }}>{capabilities.map((item: string) => <option value={item} key={item}>{REMOTE_CAPABILITY_LABELS[item]}</option>)}</select><button type="button" className="primary" disabled={!!busy || !capabilities.length} onClick={() => void dispatch()}>{busy === "dispatch" ? "전달 중…" : "확인 후 원격 실행"}</button></div>}
    <div className="remote-dispatch-list">{dispatches.map((item) => <div className="remote-dispatch-row" key={item.id}><span><strong>{REMOTE_CAPABILITY_LABELS[item.capability] || item.capability} · {item.state}</strong><small>{item.summary || item.lastError || `${item.lastLatencyMs ?? "-"}ms`}</small></span>{item.remoteDispatchId && !["completed", "failed"].includes(item.state) && <button type="button" disabled={!!busy} onClick={() => void refresh(item)}>{busy === item.id ? "확인 중…" : "상태 확인"}</button>}</div>)}</div>
    {status && <span className="attachment-status" aria-live="polite">{status}</span>}
  </details>;
}

export function TaskBoardView({ user, onOpenChat }: { user: Json; onOpenChat: (id: number) => void }): React.ReactElement {
  const [data, setData] = useState<Json | null>(null);
  const [busy, setBusy] = useState("");
  const [status, setStatus] = useState("작업 보드를 불러오는 중…");
  const load = useCallback(async () => {
    try { setData(await api("/task-board")); setStatus(""); }
    catch (error: any) { setStatus(error?.message || "작업 보드를 불러오지 못했습니다."); }
  }, []);
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 15_000); return () => window.clearInterval(timer); }, [load]);
  const total = useMemo(() => data ? Object.values(data.columns || {}).reduce((sum: number, items: any) => sum + (Array.isArray(items) ? items.length : 0), 0) : 0, [data]);

  async function recommend(task: Json): Promise<void> {
    setBusy(task.id); setStatus("사용량·capability·동시 실행 근거를 계산하는 중…");
    try {
      await api(`/tasks/${task.id}/routing/recommend`, { method: "POST", headers: { "Idempotency-Key": createClientUuid() } });
      await load(); setStatus("추천을 만들었습니다. 적용 전에는 공급자나 계정이 바뀌지 않습니다.");
    } catch (error: any) { setStatus(error?.message || "라우팅 추천에 실패했습니다."); }
    finally { setBusy(""); }
  }
  async function apply(task: Json, candidate: Json): Promise<void> {
    if (!window.confirm(`${candidate.provider} · ${candidate.accountLabel} 추천을 이 작업에 적용할까요?`)) return;
    setBusy(task.id); setStatus("승인한 라우팅을 적용하는 중…");
    try {
      await api(`/tasks/${task.id}/routing/apply`, { method: "POST", body: JSON.stringify({ recommendationId: task.recommendation.id, provider: candidate.provider, accountId: candidate.accountId }) });
      await load(); setStatus("승인한 라우팅을 적용했습니다.");
    } catch (error: any) { setStatus(error?.message || "라우팅 적용에 실패했습니다."); }
    finally { setBusy(""); }
  }

  return <section className="content-grid task-board-page">
    <div className="section-head"><div><span className="eyebrow">영속 작업 원장</span><h2>작업 보드</h2><p>{data ? `${total}개 카드 · 카드 1개는 채팅 전체가 아니라 웹에서 보낸 입력 1건` : "목표와 검증 상태를 불러옵니다."}</p></div><button type="button" onClick={() => void load()}>새로고침</button></div>
    <p className="task-board-guide">같은 채팅이 여러 번 보일 수 있습니다. 각 입력의 전달·검증 상태를 따로 추적하기 위한 기록이며, 현재 응답은 Working에 하나만 남고 지난 입력은 Completed로 이동합니다.</p>
    {status && <div className="attachment-status" aria-live="polite">{status}</div>}
    <div className="task-board-columns">
      {COLUMNS.map(([key, label]) => <section className="task-board-column" key={key} aria-label={label}>
        <header><strong>{label}</strong><span>{data?.columns?.[key]?.length ?? 0}</span></header>
        <div className="task-board-stack">{(data?.columns?.[key] || []).map((task: Json) => {
          const candidate = task.recommendation?.candidates?.[0];
          return <article className="task-board-card" key={`${key}-${task.id}`}>
            <div className="task-board-card-head"><b>{task.goal || task.name || `입력 요청 · ${taskTime(task.created_at)}`}</b>{task.activityKind && <span className={`task-activity ${task.activityKind}`}>{ACTIVITY[task.activityKind] || task.activityKind}</span>}</div>
            <small>{task.project_name}{task.chat_title ? ` · ${task.chat_title}` : ""}</small>
            {task.state_reason && <p className="task-reason">{task.state_reason}</p>}
            {task.resume_after && <p className="task-reason">재개 예정 {task.resume_after}</p>}
            {task.acceptanceCriteria?.length > 0 && <p>완료 조건 {task.acceptanceCriteria.length}개</p>}
            {task.checkpoints?.length > 0 && <p>체크포인트 {task.checkpoints.filter((item: Json) => item.status === "completed").length}/{task.checkpoints.length}</p>}
            {task.next_action && <p>다음: {task.next_action}</p>}
            {task.lastVerifiedCheckpoint?.runId && <p>검증 checkpoint <code>{shortId(task.lastVerifiedCheckpoint.runId)}</code></p>}
            {candidate && <div className="task-routing-evidence"><strong>추천 {candidate.provider} · {candidate.accountLabel}</strong><small>잔여 {candidate.remainingPercent == null ? "확인 불가" : `${candidate.remainingPercent}%`} · 실행 {candidate.active.account}/{candidate.limits.account} · 비용 확인 불가</small><small>초기화 {candidate.resetAt ? formatUsageResetAt(candidate.resetAt) : "확인 불가"} · {candidate.capability ? "capability 관측됨" : "capability 확인 불가"}</small></div>}
            {key !== "scheduled" && <TaskPreviewPanel task={task} admin={user.role === "admin"} />}
            {key !== "scheduled" && user.role === "admin" && <RemoteDispatchPanel task={task} admin />}
            {key !== "scheduled" && <div className="slack-settings-actions"><button type="button" onClick={() => onOpenChat(Number(task.chat_id))}>채팅 열기</button>{user.role === "admin" && <button type="button" disabled={busy === task.id} onClick={() => void recommend(task)}>{busy === task.id ? "계산 중…" : "라우팅 추천"}</button>}{user.role === "admin" && candidate && task.recommendation.status === "pending" && <button type="button" className="primary" disabled={busy === task.id} onClick={() => void apply(task, candidate)}>추천 적용</button>}</div>}
          </article>;
        })}{!(data?.columns?.[key]?.length) && <span className="muted">항목 없음</span>}</div>
      </section>)}
    </div>
  </section>;
}
