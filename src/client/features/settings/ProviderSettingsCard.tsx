import React, { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import type { ConnectedComputer } from "../federation/FederationSettingsCard";
import "./provider-settings-card.css";

type Provider = "claude" | "codex" | "grok";
interface ProviderSummary { provider: Provider; instructions: string[]; skills: string[]; hooks: string[] }
interface BackupMeta { id: string; createdAt: string; reason: "manual" | "before-restore" | "before-sync"; providers: Provider[]; fileCount: number; bytes: number }

const LOCAL = "local";
const VISIBLE_BACKUPS = 5;
const PROVIDERS: Array<{ id: Provider; label: string }> = [{ id: "claude", label: "Claude" }, { id: "codex", label: "Codex" }, { id: "grok", label: "Grok" }];
const REASON_LABEL: Record<BackupMeta["reason"], string> = { manual: "직접 백업", "before-restore": "복원 직전 자동", "before-sync": "동기화 받기 직전 자동" };

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes}B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// 공급자 설정(전역 지침·스킬·훅)을 이 WAM 또는 연결 컴퓨터에서 백업·복원하고, 메인 설정을 연결 컴퓨터에 보내는 카드.
export function ProviderSettingsCard({ nodes, refresh }: { nodes: ConnectedComputer[]; refresh(): Promise<void> }): React.ReactElement {
  const [target, setTarget] = useState(LOCAL);
  const [providers, setProviders] = useState<Provider[]>(["claude", "codex", "grok"]);
  const [summary, setSummary] = useState<ProviderSummary[] | null>(null);
  const [backups, setBackups] = useState<BackupMeta[]>([]);
  const [showAllBackups, setShowAllBackups] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const prefix = target === LOCAL ? "" : `/federation/nodes/${encodeURIComponent(target)}/api`;
  const targetName = target === LOCAL ? "이 WAM" : nodes.find((node) => node.id === target)?.name ?? "연결 컴퓨터";

  const load = useCallback(async (): Promise<void> => {
    try {
      const [summaryData, backupData] = await Promise.all([api(`${prefix}/provider-settings/summary`), api(`${prefix}/provider-settings/backups`)]);
      // 옛 버전 WAM은 이 API가 없어 형태가 다른 응답을 준다. 카드만 안내하고 설정 화면은 깨지지 않게 한다.
      if (!Array.isArray(summaryData?.providers) || !Array.isArray(backupData?.backups)) throw new Error("공급자 설정 백업을 지원하지 않는 WAM 버전입니다.");
      setSummary(summaryData.providers); setBackups(backupData.backups); setStatus("");
    } catch (error: any) {
      setSummary(null); setBackups([]);
      setStatus(error?.message || "설정을 불러오지 못했습니다. 연결 컴퓨터라면 WAM 버전을 확인하세요.");
    }
  }, [prefix]);
  useEffect(() => { void load(); }, [load]);

  async function run(action: () => Promise<string>): Promise<void> {
    setBusy(true); setStatus("");
    try { setStatus(await action()); } catch (error: any) { setStatus(error?.message || "작업에 실패했습니다."); } finally { setBusy(false); }
  }

  const backupNow = () => run(async () => {
    const data = await api(`${prefix}/provider-settings/backups`, { method: "POST", body: JSON.stringify({ providers }) });
    await load();
    return `${targetName}의 설정을 백업했습니다 (파일 ${data.backup.fileCount}개).`;
  });

  const restore = (backup: BackupMeta) => {
    if (!window.confirm(`${targetName}의 ${backup.providers.join("·")} 설정을 ${new Date(backup.createdAt).toLocaleString()} 시점으로 되돌릴까요?\n지금 상태는 복원 직전에 자동 백업됩니다. 실행 중인 채팅은 새 세션부터 바뀐 설정을 읽습니다.`)) return;
    void run(async () => {
      const data = await api(`${prefix}/provider-settings/backups/${encodeURIComponent(backup.id)}/restore`, { method: "POST" });
      await load();
      return `복원했습니다 (쓴 파일 ${data.written}개, 정리 ${data.removed}개).${data.skipped?.length ? ` 유지: ${data.skipped.join(", ")}` : ""}`;
    });
  };

  const remove = (backup: BackupMeta) => {
    if (!window.confirm("이 백업을 삭제할까요?")) return;
    void run(async () => { await api(`${prefix}/provider-settings/backups/${encodeURIComponent(backup.id)}`, { method: "DELETE" }); await load(); return "백업을 삭제했습니다."; });
  };

  const setMode = (node: ConnectedComputer, settingsMode: "follow" | "independent") => run(async () => {
    await api(`/federation/nodes/${encodeURIComponent(node.id)}`, { method: "PATCH", body: JSON.stringify({ settingsMode }) });
    await refresh();
    return settingsMode === "follow" ? `${node.name}: 메인 설정을 따릅니다. '지금 동기화'로 보내세요.` : `${node.name}: 따로 구성합니다. 메인 설정을 보내지 않습니다.`;
  });

  const sync = (node: ConnectedComputer) => {
    if (!window.confirm(`이 WAM의 ${providers.join("·")} 전역 지침·스킬·훅을 ${node.name}에 보낼까요?\n${node.name}에만 있는 스킬·훅은 제거되고, 적용 직전 상태는 ${node.name}에 자동 백업됩니다. 자격증명과 모델·권한 설정은 보내지 않습니다.`)) return;
    void run(async () => {
      const data = await api(`/federation/nodes/${encodeURIComponent(node.id)}/provider-settings/sync`, { method: "POST", body: JSON.stringify({ providers }) });
      if (target === node.id) await load();
      // Windows 노드는 Linux 전용 훅·셸 스크립트를 적용은 하되 동작하지 않을 수 있어 경고를 함께 보여준다(#140).
      const warnings: string[] = Array.isArray(data.warnings) ? data.warnings : [];
      return `${node.name}에 파일 ${data.sentFiles}개를 보냈습니다. 되돌리려면 대상을 ${node.name}으로 바꿔 '동기화 받기 직전 자동' 백업을 복원하세요.${warnings.length ? ` ⚠ Windows에서 동작하지 않을 수 있는 항목 ${warnings.length}개: ${warnings.slice(0, 3).join(" / ")}${warnings.length > 3 ? " …" : ""}` : ""}`;
    });
  };

  const toggleProvider = (provider: Provider) => setProviders((current) => current.includes(provider) ? current.filter((item) => item !== provider) : PROVIDERS.map((item) => item.id).filter((id) => id === provider || current.includes(id)));

  return <article className="card provider-settings-card">
    <div className="card-top"><span>공급자 설정 백업·동기화</span></div>
    <p className="muted">Claude·Codex·Grok의 전역 지침, 사용자 스킬, 사용자 훅을 백업·복원합니다. 자격증명, WAM이 자동 설치하는 훅·스킬, 모델·권한·신뢰 폴더·MCP 설정은 포함하지 않습니다.</p>
    <div className="server-log-filters">
      <label>컴퓨터<select value={target} onChange={(event) => setTarget(event.target.value)}>
        <option value={LOCAL}>이 WAM</option>
        {nodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}
      </select></label>
      <fieldset className="provider-settings-providers"><legend>공급자</legend>
        {PROVIDERS.map((item) => <label key={item.id}><input type="checkbox" checked={providers.includes(item.id)} onChange={() => toggleProvider(item.id)} />{item.label}</label>)}
      </fieldset>
      <div className="slack-settings-actions"><button type="button" className="primary" disabled={busy || !providers.length || !summary} onClick={() => void backupNow()}>지금 백업</button></div>
    </div>
    {summary && <div className="provider-settings-summary">
      {summary.filter((item) => providers.includes(item.provider)).map((item) => <div key={item.provider} className="provider-settings-summary-item">
        <strong>{PROVIDERS.find((p) => p.id === item.provider)?.label}</strong>
        <small>지침 {item.instructions.length ? item.instructions.map((file) => file.split("/").pop()).join(", ") : "없음"}</small>
        <small title={item.skills.join(", ")}>스킬 {item.skills.length ? `${item.skills.length}개 · ${item.skills.join(", ")}` : "없음"}</small>
        <small title={item.hooks.join(", ")}>훅 {item.hooks.length ? item.hooks.join(", ") : "없음"}</small>
      </div>)}
    </div>}
    {target === LOCAL && nodes.length > 0 && <div className="provider-settings-nodes">
      <strong>연결 컴퓨터로 보내기</strong>
      <p className="muted">'메인 따르기' 컴퓨터에만 이 WAM의 설정을 보낼 수 있습니다. '따로 구성'은 그 컴퓨터의 설정을 그대로 둡니다. 대상 컴퓨터도 이 기능이 있는 버전이어야 합니다.</p>
      {nodes.map((node) => <div className="session-security-row" key={node.id}>
        <span><strong>{node.name}</strong><small>{node.base_url}</small></span>
        <span className="provider-settings-row-actions">
          <select aria-label={`${node.name} 설정 모드`} value={node.settings_mode ?? "independent"} disabled={busy} onChange={(event) => void setMode(node, event.target.value as "follow" | "independent")}>
            <option value="follow">메인 따르기</option><option value="independent">따로 구성</option>
          </select>
          <button type="button" disabled={busy || node.settings_mode !== "follow" || !providers.length} onClick={() => sync(node)}>지금 동기화</button>
        </span>
      </div>)}
    </div>}
    {summary && <div className="provider-settings-backups">
      <strong>{targetName}의 백업</strong>
      {!backups.length && <p className="muted">아직 백업이 없습니다.</p>}
      {(showAllBackups ? backups : backups.slice(0, VISIBLE_BACKUPS)).map((backup) => <div className="session-security-row" key={backup.id}>
        <span><strong>{new Date(backup.createdAt).toLocaleString()} · {REASON_LABEL[backup.reason]}</strong><small>{backup.providers.join("·")} · 파일 {backup.fileCount}개 · {formatBytes(backup.bytes)}</small></span>
        <span className="provider-settings-row-actions"><button type="button" disabled={busy} onClick={() => restore(backup)}>복원</button><button type="button" disabled={busy} onClick={() => remove(backup)}>삭제</button></span>
      </div>)}
      {backups.length > VISIBLE_BACKUPS && <button type="button" className="provider-settings-more" onClick={() => setShowAllBackups((value) => !value)}>{showAllBackups ? "최근 5개만 보기" : `백업 ${backups.length}개 모두 보기`}</button>}
    </div>}
    {status && <p className="attachment-status provider-settings-status" aria-live="polite">{status}</p>}
  </article>;
}
