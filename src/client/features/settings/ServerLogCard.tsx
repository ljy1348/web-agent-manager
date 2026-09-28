import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import type { ConnectedComputer } from "../federation/FederationSettingsCard";

interface LogReadResult {
  date: string;
  dates: string[];
  lines: string[];
  matched: number;
  truncated: boolean;
}

const LOCAL = "local";
const LEVEL_CLASS = /^\S+ (DEBUG|INFO|WARN|ERROR)\b/;

// 이 WAM 또는 연결 컴퓨터의 서버·클라이언트 로그를 날짜·레벨·검색어로 조회하는 관리자 카드.
// 연결 컴퓨터는 federation 중계(/federation/nodes/:id/api)로 같은 조회 API를 호출한다.
export function ServerLogCard({ nodes }: { nodes: ConnectedComputer[] }): React.ReactElement {
  const [target, setTarget] = useState(LOCAL);
  const [kind, setKind] = useState<"server" | "client">("server");
  const [date, setDate] = useState("");
  const [level, setLevel] = useState("info");
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [result, setResult] = useState<LogReadResult | null>(null);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const linesRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true); setStatus("");
    const params = new URLSearchParams({ kind, level, limit: "500" });
    if (date) params.set("date", date);
    if (appliedSearch) params.set("q", appliedSearch);
    const prefix = target === LOCAL ? "" : `/federation/nodes/${encodeURIComponent(target)}/api`;
    try {
      const data = await api(`${prefix}/logs/server?${params}`);
      // 옛 버전 WAM 등 형식이 다른 응답에서 카드가 아니라 설정 화면 전체가 깨지지 않도록 형태를 확인한다.
      if (!Array.isArray(data?.lines) || !Array.isArray(data?.dates)) throw new Error("로그 조회를 지원하지 않는 WAM 버전입니다.");
      setResult(data);
    } catch (error: any) {
      setResult(null);
      setStatus(error?.message || "로그를 불러오지 못했습니다. 연결 컴퓨터라면 WAM 버전이 로그 조회를 지원하는지 확인하세요.");
    } finally { setLoading(false); }
  }, [target, kind, date, level, appliedSearch]);

  useEffect(() => { void load(); }, [load]);
  // 최신 줄이 맨 아래에 있으므로 새로 불러올 때마다 끝으로 스크롤한다.
  useEffect(() => { if (linesRef.current) linesRef.current.scrollTop = linesRef.current.scrollHeight; }, [result]);

  // 대상 컴퓨터나 로그 종류가 바뀌면 그쪽의 최신 날짜부터 다시 본다.
  function resetDate<T>(setter: (value: T) => void) { return (value: T): void => { setDate(""); setter(value); }; }

  return <article className="card server-log-card"><div className="card-top">서버 로그</div>
    <form className="server-log-filters" onSubmit={(event) => { event.preventDefault(); setAppliedSearch(search.trim()); }}>
      <label>컴퓨터<select value={target} onChange={(event) => resetDate(setTarget)(event.target.value)}>
        <option value={LOCAL}>이 WAM</option>
        {nodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}
      </select></label>
      <label>종류<select value={kind} onChange={(event) => resetDate(setKind)(event.target.value as "server" | "client")}><option value="server">서버</option><option value="client">클라이언트</option></select></label>
      <label>날짜<select value={date || result?.date || ""} onChange={(event) => setDate(event.target.value)}>
        {(result?.dates.length ? result.dates : [result?.date || ""]).map((item) => <option key={item} value={item}>{item || "오늘"}</option>)}
      </select></label>
      <label>레벨<select value={level} onChange={(event) => setLevel(event.target.value)}><option value="debug">전체</option><option value="info">INFO 이상</option><option value="warn">WARN 이상</option><option value="error">ERROR</option></select></label>
      <label className="server-log-search">검색<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="경로, IP, 메시지…" /></label>
      <div className="slack-settings-actions"><button type="submit" className="primary" disabled={loading}>검색</button><button type="button" disabled={loading} onClick={() => void load()}>새로고침</button></div>
    </form>
    {status && <p className="server-log-status" role="alert">{status}</p>}
    {result && <p className="server-log-summary">{result.truncated ? `조건에 맞는 ${result.matched.toLocaleString()}줄 중 마지막 ${result.lines.length.toLocaleString()}줄` : `${result.lines.length.toLocaleString()}줄`}</p>}
    <div ref={linesRef} className="server-log-lines" role="log" aria-label="로그 내용" aria-busy={loading}>
      {result && result.lines.length === 0 && !loading && <p className="server-log-empty">표시할 로그가 없습니다.</p>}
      {result?.lines.map((line, index) => <div key={index} className={`server-log-line level-${(line.match(LEVEL_CLASS)?.[1] ?? "").toLowerCase()}`}>{line}</div>)}
    </div>
  </article>;
}
