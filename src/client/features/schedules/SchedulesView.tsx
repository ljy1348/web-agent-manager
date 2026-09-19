import React, { useEffect, useMemo, useState } from "react";
import { CalendarClock, MessageSquarePlus, Play, RotateCcw, Save, Trash2 } from "lucide-react";
import { api } from "../../api";
import type { Json } from "../../types";
import { scheduleTimingLabel } from "../../lib/schedules";

type ScheduleMode = "new_chat" | "existing_chat";

function browserTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

function statusLabel(schedule: Json): string {
  if (schedule.last_status === "running") return "실행 중";
  if (schedule.last_status === "success") return "최근 실행 성공";
  if (schedule.last_status === "error") return "최근 실행 실패";
  return "실행 기록 없음";
}

// WAM 서버가 영구 보관하는 일일 프롬프트 일정을 생성·수정·실행·중지한다.
export function SchedulesView({ user, project, projects, providers, accounts, onOpenChat }: Json): React.ReactElement {
  const [schedules, setSchedules] = useState<Json[]>([]);
  const [chats, setChats] = useState<Json[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState<number>(Number(project?.id || projects?.[0]?.id || 0));
  const [mode, setMode] = useState<ScheduleMode>("new_chat");
  const [provider, setProvider] = useState(String(providers?.[0]?.id || "codex"));
  const [accountId, setAccountId] = useState("");
  const [chatId, setChatId] = useState("");
  const [dailyTime, setDailyTime] = useState("09:00");
  const [timezone, setTimezone] = useState(browserTimezone);
  // 비우면 매일 반복, 날짜를 넣으면 그날 한 번만 실행한다(#99).
  const [runDate, setRunDate] = useState("");
  const [prompt, setPrompt] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const providerAccounts = useMemo(() => (accounts || []).filter((account: Json) => account.provider === provider), [accounts, provider]);

  async function load(): Promise<void> {
    if (user?.role !== "admin") return;
    const data = await api("/prompt-schedules");
    setSchedules(data.schedules || []);
  }

  useEffect(() => { void load().catch((caught) => setError(caught instanceof Error ? caught.message : "일정을 불러오지 못했습니다.")); }, [user?.role]);
  useEffect(() => {
    if (!editingId && project?.id) setProjectId(Number(project.id));
  }, [project?.id, editingId]);
  useEffect(() => {
    if (mode !== "existing_chat" || !projectId) { setChats([]); return; }
    void api(`/chats?projectId=${projectId}`).then((data) => {
      setChats(data.chats || []);
      setChatId((current) => current && (data.chats || []).some((chat: Json) => String(chat.id) === current) ? current : String(data.chats?.[0]?.id || ""));
    }).catch((caught) => setError(caught instanceof Error ? caught.message : "채팅 목록을 불러오지 못했습니다."));
  }, [mode, projectId]);

  function resetForm(): void {
    setEditingId(null);
    setName("");
    setProjectId(Number(project?.id || projects?.[0]?.id || 0));
    setMode("new_chat");
    setProvider(String(providers?.[0]?.id || "codex"));
    setAccountId("");
    setChatId("");
    setDailyTime("09:00");
    setTimezone(browserTimezone());
    setRunDate("");
    setPrompt("");
    setEnabled(true);
    setError("");
  }

  function edit(schedule: Json): void {
    setEditingId(Number(schedule.id));
    setName(schedule.name || "");
    setProjectId(Number(schedule.project_id));
    setMode(schedule.mode);
    setProvider(schedule.provider || "codex");
    setAccountId(schedule.account_id ? String(schedule.account_id) : "");
    setChatId(schedule.chat_id ? String(schedule.chat_id) : "");
    setDailyTime(schedule.daily_time || "09:00");
    setTimezone(schedule.timezone || browserTimezone());
    setRunDate(schedule.run_date || "");
    setPrompt(schedule.prompt || "");
    setEnabled(schedule.enabled === 1 || schedule.enabled === true);
    setError("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy("save");
    setError("");
    try {
      const body = {
        name, projectId, mode, provider: mode === "new_chat" ? provider : null,
        accountId: mode === "new_chat" && accountId ? Number(accountId) : null,
        chatId: mode === "existing_chat" && chatId ? Number(chatId) : null,
        dailyTime, timezone, runDate: runDate || null, prompt, enabled,
      };
      await api(editingId ? `/prompt-schedules/${editingId}` : "/prompt-schedules", {
        method: editingId ? "PUT" : "POST",
        body: JSON.stringify(body),
      });
      resetForm();
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "일정을 저장하지 못했습니다.");
    } finally { setBusy(""); }
  }

  async function mutate(id: number, action: "run" | "toggle" | "delete", value?: boolean): Promise<void> {
    setBusy(`${action}:${id}`);
    setError("");
    try {
      if (action === "delete") {
        if (!window.confirm("이 일정을 삭제할까요? 생성된 채팅은 삭제되지 않습니다.")) return;
        await api(`/prompt-schedules/${id}`, { method: "DELETE" });
        if (editingId === id) resetForm();
      } else if (action === "toggle") {
        await api(`/prompt-schedules/${id}/enabled`, { method: "POST", body: JSON.stringify({ enabled: value }) });
      } else {
        await api(`/prompt-schedules/${id}/run`, { method: "POST" });
      }
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "일정 작업에 실패했습니다.");
    } finally { setBusy(""); }
  }

  if (user?.role !== "admin") return <section className="panel schedule-panel"><h2>예약 입력</h2><p className="muted">관리자만 예약 입력을 관리할 수 있습니다.</p></section>;

  return <div className="schedule-layout">
    <section className="panel schedule-editor">
      <div className="panel-title"><div><span className="eyebrow">WAM Scheduler</span><h2>{editingId ? "일정 수정" : "예약 입력"}</h2></div><CalendarClock size={22} /></div>
      <form onSubmit={submit}>
        <label>일정 이름<input value={name} onChange={(event) => setName(event.target.value)} placeholder="매일 아침 스터디" required maxLength={120} /></label>
        <div className="schedule-form-grid">
          <label>프로젝트<select value={projectId || ""} onChange={(event) => setProjectId(Number(event.target.value))} required><option value="">선택</option>{(projects || []).map((item: Json) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>실행 방식<select value={mode} onChange={(event) => setMode(event.target.value as ScheduleMode)}><option value="new_chat">매번 새 채팅 생성</option><option value="existing_chat">지정 채팅에서 계속</option></select></label>
          {mode === "new_chat" ? <>
            <label>공급자<select value={provider} onChange={(event) => { setProvider(event.target.value); setAccountId(""); }}>{(providers || []).map((item: Json) => <option key={item.id} value={item.id}>{item.label || item.displayLabel || item.id}</option>)}</select></label>
            <label>계정<select value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="">기본 계정</option>{providerAccounts.filter((account: Json) => !account.is_default).map((account: Json) => <option key={account.id} value={account.id}>{account.label}</option>)}</select></label>
          </> : <label className="full">대상 채팅<select value={chatId} onChange={(event) => setChatId(event.target.value)} required><option value="">채팅 선택</option>{chats.map((item) => <option key={item.id} value={item.id}>#{item.id} {item.title}</option>)}</select></label>}
          <label>실행 날짜(비우면 매일)<input type="date" value={runDate} onChange={(event) => setRunDate(event.target.value)} /></label>
          <label>{runDate ? "실행 시각" : "매일 시각"}<input type="time" value={dailyTime} onChange={(event) => setDailyTime(event.target.value)} required /></label>
          <label>시간대<input value={timezone} onChange={(event) => setTimezone(event.target.value)} required /></label>
        </div>
        <label>입력할 문구<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="매일 이 프로젝트의 진행 상황을 확인하고 다음 학습 계획을 정리해줘." required maxLength={100000} /></label>
        <label className="check-row"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span>저장 후 일정 활성화</span></label>
        <p className="schedule-note">{runDate
          ? "지정한 날짜·시각에 한 번만 실행하고 자동으로 꺼집니다. 서버가 그때 꺼져 있었다면 다시 켜진 뒤 한 번 실행합니다."
          : "WAM 서버가 켜져 있으면 지정 시간대의 시각에 실행됩니다. 서버가 그 시각에 꺼져 있었다면 같은 날 다시 켜졌을 때 한 번 실행합니다."}</p>
        {error && <div className="error">{error}</div>}
        <div className="dialog-actions">{editingId && <button type="button" onClick={resetForm}><RotateCcw size={15} />새 일정</button>}<button className="primary" disabled={!!busy || !projectId}><Save size={15} />{busy === "save" ? "저장 중…" : editingId ? "수정 저장" : "일정 추가"}</button></div>
      </form>
    </section>

    <section className="panel schedule-list-panel">
      <div className="panel-title"><div><span className="eyebrow">Daily jobs</span><h2>등록된 일정</h2></div><span>{schedules.length}개</span></div>
      <div className="schedule-list">{schedules.length ? schedules.map((schedule) => {
        const active = schedule.enabled === 1 || schedule.enabled === true;
        return <article className={`schedule-card${active ? "" : " disabled"}`} key={schedule.id}>
          <div className="schedule-card-head"><div><strong>{schedule.name}</strong><span>{schedule.project_name} · {scheduleTimingLabel(schedule)} · {schedule.timezone}</span></div><span className={`schedule-status ${schedule.last_status || "idle"}`}>{statusLabel(schedule)}</span></div>
          <p>{schedule.prompt}</p>
          <small>{schedule.mode === "new_chat" ? `매번 새 ${schedule.provider} 채팅${schedule.account_label ? ` · ${schedule.account_label}` : ""}` : `기존 채팅 #${schedule.chat_id} ${schedule.chat_title || "(삭제됨)"}`}</small>
          {schedule.last_error && <div className="error compact">{schedule.last_error}</div>}
          <div className="schedule-actions">
            <button type="button" onClick={() => edit(schedule)}>수정</button>
            <button type="button" onClick={() => void mutate(schedule.id, "toggle", !active)} disabled={!!busy}>{active ? "일시정지" : "다시 시작"}</button>
            <button type="button" onClick={() => void mutate(schedule.id, "run")} disabled={!!busy}><Play size={14} />지금 실행</button>
            {schedule.last_chat_id && <button type="button" onClick={() => onOpenChat(Number(schedule.last_chat_id))}><MessageSquarePlus size={14} />최근 채팅</button>}
            <button type="button" className="danger" onClick={() => void mutate(schedule.id, "delete")} disabled={!!busy}><Trash2 size={14} />삭제</button>
          </div>
        </article>;
      }) : <p className="resource-empty">등록된 예약 입력이 없습니다.</p>}</div>
    </section>
  </div>;
}
