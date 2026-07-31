import React, { useEffect, useState } from "react";
import { api } from "../../api";
import type { Json } from "../../types";

// 프로젝트·전역 지침 파일을 허용 목록 안에서 편집한다.
export function InstructionsView({ project }: { project: Json | null }): React.ReactElement {
  const [scope, setScope] = useState("project");
  const [catalog, setCatalog] = useState<Json>({ project: [], global: [] });
  const [name, setName] = useState("AGENTS.md");
  const [content, setContent] = useState("");
  const [status, setStatus] = useState("");
  useEffect(() => { void api("/instructions/catalog").then(setCatalog); }, []);
  useEffect(() => { if (scope === "project" && !project) return; const query = new URLSearchParams({ scope, name, ...(project ? { projectId: String(project.id) } : {}) }); void api(`/instructions?${query}`).then((data) => { setContent(data.content); setStatus(""); }); }, [scope, name, project?.id]);
  async function save(): Promise<void> {
    await api("/instructions", { method: "PUT", body: JSON.stringify({ scope, name, projectId: project?.id, content }) });
    setStatus("저장했습니다.");
  }
  // CLAUDE.md가 공통 AGENTS.md를 읽도록 import 구문을 생성한다.
  async function unifyInstructions(): Promise<void> {
    const data = await api("/instructions/unify", { method: "POST", body: JSON.stringify({ scope, projectId: project?.id }) });
    setName(data.name);
    setContent(data.content);
    setStatus(data.saved ? "CLAUDE.md에 AGENTS.md import를 추가했습니다." : "이미 AGENTS.md import가 설정되어 있습니다.");
  }
  return <section className="panel editor-panel"><div className="section-head"><div><span className="eyebrow">컨텍스트 관리</span><h2>AGENTS.md · CLAUDE.md</h2></div><div className="action-row"><button type="button" onClick={unifyInstructions} disabled={scope === "project" && !project}>AGENTS.md 공통화</button><button className="primary" onClick={save}>저장</button></div></div><div className="editor-toolbar"><select value={scope} onChange={(event) => { setScope(event.target.value); setName(event.target.value === "global" ? "codex/AGENTS.md" : "AGENTS.md"); }}><option value="project">프로젝트</option><option value="global">전역</option></select><select value={name} onChange={(event) => setName(event.target.value)}>{(catalog[scope] || []).map((item: string) => <option key={item}>{item}</option>)}</select>{status && <span className="inline-status">{status}</span>}</div><textarea className="code-editor" value={content} onChange={(event) => setContent(event.target.value)} spellCheck={false} /></section>;
}
