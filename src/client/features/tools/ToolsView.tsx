import React, { useEffect, useMemo, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { api } from "../../api";
import { LoadingState } from "../../components/LoadingState";
import type { Json } from "../../types";

type ToolKind = "commands" | "skills" | "marketplace" | "mcp";
type ProviderFilter = "codex" | "claude" | "grok";

const KINDS: Array<{ id: ToolKind; label: string }> = [
  { id: "commands", label: "Commands" },
  { id: "skills", label: "Skills" },
  { id: "marketplace", label: "Marketplace" },
  { id: "mcp", label: "MCP" },
];

const PROVIDERS: Array<{ id: ProviderFilter; label: string }> = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "grok", label: "Grok" },
];

const STATUS_LABELS: Record<string, string> = {
  active: "활성",
  disabled: "비활성",
  needs_auth: "인증 필요",
  error: "오류",
  incompatible: "호환 안 됨",
  not_installed: "미설치",
};

function detailRows(item: Json): React.ReactElement {
  const details = item.details || {};
  return <dl className="tool-detail-list">
    <dt>Provider</dt><dd><span className={`provider ${item.provider}`}>{item.provider}</span></dd>
    <dt>상태</dt><dd><span className={`tool-status ${item.status}`}>{STATUS_LABELS[item.status] || item.status}</span></dd>
    <dt>Scope</dt><dd>{item.scope}</dd>
    <dt>출처</dt><dd>{item.source || "-"}</dd>
    {item.command && <><dt>명령</dt><dd><code>{item.command}</code></dd></>}
    {item.template && <><dt>입력 템플릿</dt><dd><code>{item.template}</code></dd></>}
    {Object.keys(details).map((key) => <React.Fragment key={key}><dt>{key}</dt><dd>{Array.isArray(details[key]) ? details[key].join(", ") || "-" : String(details[key] ?? "-")}</dd></React.Fragment>)}
  </dl>;
}

// MCP env/header 입력을 문자열 key/value JSON 객체로 검증한다.
function parseJsonField(value: string, label: string): Record<string, string> | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label}는 JSON 객체여야 합니다.`);
  for (const [key, entry] of Object.entries(parsed)) {
    if (!key || typeof entry !== "string") throw new Error(`${label}는 문자열 key/value만 지원합니다.`);
  }
  return parsed as Record<string, string>;
}

// MCP 서버 추가·수정·삭제·활성화 조작을 담당하는 편집 폼이다.
function McpEditor({ provider, project, selected, creating, reload, cancelCreate }: { provider: ProviderFilter; project: Json | null; selected: Json | null; creating: boolean; reload: () => Promise<void>; cancelCreate: () => void }): React.ReactElement {
  const config = selected?.details?.config || {};
  const [name, setName] = useState("");
  const [transport, setTransport] = useState("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [cwd, setCwd] = useState("");
  const [url, setUrl] = useState("");
  const [env, setEnv] = useState("");
  const [headers, setHeaders] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [status, setStatus] = useState("");

  useEffect(() => {
    setName(creating ? "" : selected?.name || "");
    setTransport(String(config.type || config.transport || (config.url ? "http" : "stdio")));
    setCommand(String(config.command || ""));
    setArgs(Array.isArray(config.args) ? config.args.join(" ") : "");
    setCwd(String(config.cwd || ""));
    setUrl(String(config.url || ""));
    setEnv("");
    setHeaders("");
    setEnabled(config.enabled !== false && selected?.status !== "disabled");
    setStatus("");
  }, [selected?.id, creating]);

  async function save(): Promise<void> {
    setStatus("저장 중...");
    try {
      const body = {
        provider,
        projectId: project?.id,
        name,
        transport,
        command,
        args: args.split(/\s+/).map((item) => item.trim()).filter(Boolean),
        cwd,
        url,
        enabled,
        env: parseJsonField(env, "env"),
        headers: parseJsonField(headers, "headers"),
      };
      if (creating || !selected) await api("/tools/mcp", { method: "POST", body: JSON.stringify(body) });
      else await api(`/tools/mcp/${selected.provider}/${selected.scope}/${encodeURIComponent(selected.name)}`, { method: "PUT", body: JSON.stringify(body) });
      await reload();
      cancelCreate();
      setStatus("저장했습니다.");
    } catch (error: any) {
      setStatus(error?.message || "저장에 실패했습니다.");
    }
  }

  async function toggle(): Promise<void> {
    if (!selected) return;
    setStatus("변경 중...");
    try {
      await api(`/tools/mcp/${selected.provider}/${selected.scope}/${encodeURIComponent(selected.name)}/toggle`, { method: "POST", body: JSON.stringify({ projectId: project?.id, enabled: !enabled }) });
      setEnabled(!enabled);
      await reload();
      setStatus("변경했습니다.");
    } catch (error: any) {
      setStatus(error?.message || "변경에 실패했습니다.");
    }
  }

  async function remove(): Promise<void> {
    if (!selected || !window.confirm(`${selected.name} MCP 서버를 삭제할까요?`)) return;
    setStatus("삭제 중...");
    try {
      const query = project?.id ? `?projectId=${project.id}` : "";
      await api(`/tools/mcp/${selected.provider}/${selected.scope}/${encodeURIComponent(selected.name)}${query}`, { method: "DELETE" });
      await reload();
      cancelCreate();
    } catch (error: any) {
      setStatus(error?.message || "삭제에 실패했습니다.");
    }
  }

  const envHint = selected?.details?.envKeys?.length ? `기존 env keys: ${selected.details.envKeys.join(", ")}. 비워두면 보존됩니다.` : "예: {\"TOKEN\":\"...\"}";
  const headerHint = selected?.details?.headerKeys?.length ? `기존 header keys: ${selected.details.headerKeys.join(", ")}. 비워두면 보존됩니다.` : "예: {\"Authorization\":\"Bearer ...\"}";

  // URL이나 command를 먼저 누르는 흐름에 맞춰 transport를 자동 보정한다.
  function activateTransport(nextTransport: "stdio" | "http"): void {
    if (transport !== nextTransport) setTransport(nextTransport);
  }

  return <form className="mcp-editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <div className="mcp-editor-grid">
      <label>이름<input value={name} disabled={!creating && !!selected} onChange={(event) => setName(event.target.value)} placeholder="github" /></label>
      <label>Transport<select value={transport} onChange={(event) => setTransport(event.target.value)}><option value="stdio">stdio</option><option value="http">http</option><option value="sse">sse</option><option value="ws">ws</option></select></label>
      <label className="span-2">Command<input value={command} onFocus={() => activateTransport("stdio")} onChange={(event) => { activateTransport("stdio"); setCommand(event.target.value); }} placeholder="npx" /></label>
      <label className="span-2">Args<input value={args} onFocus={() => activateTransport("stdio")} onChange={(event) => { activateTransport("stdio"); setArgs(event.target.value); }} placeholder="-y @modelcontextprotocol/server-github" /></label>
      <label className="span-2">URL<input value={url} onFocus={() => activateTransport("http")} onChange={(event) => { activateTransport("http"); setUrl(event.target.value); }} placeholder="https://example.com/mcp" /></label>
      <label className="span-2">CWD<input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="/path/to/project" /></label>
      <label className="span-2">Env JSON<textarea value={env} onChange={(event) => setEnv(event.target.value)} placeholder={envHint} rows={3} /></label>
      <label className="span-2">Headers JSON<textarea value={headers} onFocus={() => activateTransport("http")} onChange={(event) => { activateTransport("http"); setHeaders(event.target.value); }} placeholder={headerHint} rows={3} /></label>
      {provider === "codex" ? <label className="mcp-enabled"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />활성화</label> : <span className="inline-status">Claude MCP는 공식 설정상 비활성 토글 대신 삭제/재추가로 관리합니다.</span>}
    </div>
    <div className="tool-actions">
      <button className="primary" type="submit">{creating ? "추가" : "저장"}</button>
      {!creating && selected && provider === "codex" && <button type="button" onClick={() => void toggle()}>{enabled ? "비활성화" : "활성화"}</button>}
      {!creating && selected && <button className="danger" type="button" onClick={() => void remove()}>삭제</button>}
      {creating && <button type="button" onClick={cancelCreate}>취소</button>}
      {status && <span className="inline-status">{status}</span>}
    </div>
  </form>;
}

export function ToolsView({ project }: { project: Json | null }): React.ReactElement {
  const [provider, setProvider] = useState<ProviderFilter>("claude");
  const [kind, setKind] = useState<ToolKind>("commands");
  const [items, setItems] = useState<Json[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [creatingMcp, setCreatingMcp] = useState(false);

  // 현재 프로젝트 기준 도구 카탈로그를 읽고 최초 응답 전 상태를 실제 빈 결과와 구분한다.
  async function load(): Promise<void> {
    setLoading(true);
    setError("");
    try {
      const params = project?.id ? `?projectId=${project.id}` : "";
      const data = await api(`/tools/catalog${params}`);
      setItems(data.items || []);
      setLoaded(true);
    } catch (caught: any) {
      setError(caught?.message || "도구 목록을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setItems([]);
    setLoaded(false);
    void load();
  }, [project?.id]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((item) => item.provider === provider && item.kind === kind)
      .filter((item) => !needle || `${item.name} ${item.description} ${item.source}`.toLowerCase().includes(needle));
  }, [items, provider, kind, query]);
  const selected = filtered.find((item) => item.id === selectedId) || filtered[0] || null;
  const selectedMcpReadOnly = !creatingMcp && selected?.kind === "mcp" && selected?.details?.readOnly === true;
  useEffect(() => { setSelectedId(""); setCreatingMcp(false); }, [provider, kind, query, project?.id]);

  return <section className="tools-shell">
    <div className="section-head"><div><span className="eyebrow">Provider tools</span><h2>Commands · Skills · Marketplace · MCP</h2></div><div className="action-row">{kind === "mcp" && <button type="button" className="primary" onClick={() => setCreatingMcp(true)}>새 MCP</button>}<button type="button" disabled={loading} onClick={() => void load()}>{loading && <LoaderCircle className="spin" size={14} aria-hidden="true" />}{loading ? "불러오는 중" : "새로고침"}</button></div></div>
    <div className="tools-toolbar">
      <div className="segmented">{PROVIDERS.map((item) => <button key={item.id} type="button" className={provider === item.id ? "active" : ""} onClick={() => setProvider(item.id)}>{item.label}</button>)}</div>
      <div className="segmented">{KINDS.map((item) => <button key={item.id} type="button" className={kind === item.id ? "active" : ""} onClick={() => setKind(item.id)}>{item.label}</button>)}</div>
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="검색" />
    </div>
    {error && <p className="global-error">{error}</p>}
    <div className="tools-grid">
      {loading && !loaded ? <LoadingState label="도구 목록 불러오는 중" /> : !loaded
        ? <div className="resource-empty">도구 목록을 불러오지 못했습니다.</div>
        : <><aside className="tool-list">
        {!filtered.length && <p className="muted">이 provider에서 표시할 항목이 없습니다.</p>}
        {filtered.map((item) => <button key={item.id} type="button" className={`tool-row ${!creatingMcp && selected?.id === item.id ? "active" : ""}`} onClick={() => { setCreatingMcp(false); setSelectedId(item.id); }}>
          <span className={`provider ${item.provider}`}>{item.provider}</span>
          <strong>{item.label}</strong>
          <small>{item.description}</small>
          <span className={`tool-status ${item.status}`}>{STATUS_LABELS[item.status] || item.status}</span>
        </button>)}
      </aside>
      <section className="tool-detail">
        {creatingMcp || selected ? <>
          <div className="tool-detail-head"><div><span className="eyebrow">{creatingMcp ? "mcp" : selected.kind}</span><h3>{creatingMcp ? `새 ${provider} MCP` : selected.label}</h3></div>{!creatingMcp && selected && <span className={`tool-status ${selected.status}`}>{STATUS_LABELS[selected.status] || selected.status}</span>}</div>
          {!creatingMcp && selected && <p>{selected.description}</p>}
          {!creatingMcp && selected && detailRows(selected)}
          {kind === "mcp" && !selectedMcpReadOnly && <McpEditor provider={provider} project={project} selected={creatingMcp ? null : selected} creating={creatingMcp} reload={load} cancelCreate={() => setCreatingMcp(false)} />}
          <div className="tool-actions">
            {!creatingMcp && selected?.kind === "commands" && selected.template && <button type="button" onClick={() => navigator.clipboard?.writeText(selected.template)}>템플릿 복사</button>}
            {kind === "mcp" && selectedMcpReadOnly && <span className="inline-status">이 항목은 provider CLI가 보고한 연결 상태입니다. 설정 편집은 아직 CLI/공급자 쪽에서 처리하세요.</span>}
            {kind === "mcp" && !selectedMcpReadOnly && <span className="inline-status">기존 env/header 값은 웹에 표시하지 않습니다. 값을 바꾸려면 JSON으로 새로 입력하세요.</span>}
            {!creatingMcp && selected?.kind === "marketplace" && <span className="inline-status">설치·제거는 다음 단계에서 provider CLI 위임 작업으로 연결합니다.</span>}
          </div>
        </> : <p className="muted">항목을 선택하세요.</p>}
      </section>
      </>}
    </div>
  </section>;
}
