import React, { useEffect, useState } from "react";
import { api } from "../../api";
import type { ConnectedComputer } from "../federation/FederationSettingsCard";
import "./provider-settings-card.css";

interface ProjectItem { id: number; name: string; path: string }
interface EnvironmentStep { kind: "node" | "python"; dir: string; venvName?: string; pythonVersion?: string }
interface Preview { fileCount: number; bytes: number; steps: EnvironmentStep[]; warnings: string[]; busyChats: number[] }
interface JobStep { label: string; command: string; status: "pending" | "running" | "succeeded" | "failed" | "skipped"; output: string }
interface Job { id: string; projectPath: string; status: "running" | "succeeded" | "failed"; steps: JobStep[] }
interface Transfer { id: string; nodeId: string; state: "uploading" | "extracting" | "done" | "failed"; destination: string; sentBytes: number; sourceBytes: number; error?: string; remoteJob?: Job }

const STEP_LABEL: Record<JobStep["status"], string> = { pending: "대기", running: "진행 중", succeeded: "완료", failed: "실패", skipped: "건너뜀" };

function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)}KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${(bytes / 1024 ** 3).toFixed(2)}GB`;
}

function describeStep(step: EnvironmentStep): string {
  const where = step.dir || "루트";
  return step.kind === "node" ? `Node 의존성 (${where}/node_modules)` : `Python 가상환경 (${where}/${step.venvName}${step.pythonVersion ? `, ${step.pythonVersion}` : ""})`;
}

// 프로젝트 전체를 연결 컴퓨터로 복사하고, 대상에서 다시 만드는 실행 환경의 진행 상황을 보여주는 카드(#137).
export function ProjectTransferCard({ nodes }: { nodes: ConnectedComputer[] }): React.ReactElement {
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [projectId, setProjectId] = useState("");
  const [nodeId, setNodeId] = useState(nodes[0]?.id ?? "");
  const [name, setName] = useState("");
  const [destinationPath, setDestinationPath] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [transfer, setTransfer] = useState<Transfer | null>(null);
  const [job, setJob] = useState<{ nodeId: string; job: Job } | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => { if (!nodes.some((node) => node.id === nodeId)) setNodeId(nodes[0]?.id ?? ""); }, [nodes, nodeId]);
  useEffect(() => { void api("/projects").then((data) => setProjects(Array.isArray(data?.projects) ? data.projects : [])).catch(() => undefined); }, []);
  useEffect(() => {
    setPreview(null);
    if (!projectId) return;
    setName(projects.find((item) => String(item.id) === projectId)?.name ?? "");
    void api(`/projects/${projectId}/transfer-preview`).then(setPreview).catch((error: any) => setStatus(error?.message || "프로젝트를 확인하지 못했습니다."));
  }, [projectId, projects]);
  // 이 WAM이 조각을 보내고 대상이 압축을 풀 때까지 1초마다 송신 상태를 읽는다.
  useEffect(() => {
    if (!transfer || !["uploading", "extracting"].includes(transfer.state)) return;
    const timer = window.setTimeout(() => {
      void api(`/project-transfers/${transfer.id}`).then((data) => {
        const next: Transfer | undefined = data?.transfer;
        if (!next) return;
        setTransfer(next);
        if (next.state === "done" && next.remoteJob) {
          setJob({ nodeId: next.nodeId, job: next.remoteJob });
          setStatus(`${nodes.find((node) => node.id === next.nodeId)?.name ?? "대상"}의 ${next.remoteJob.projectPath}에 복사하고 프로젝트로 등록했습니다.`);
        }
        if (next.state === "failed") setStatus(next.error || "프로젝트를 보내지 못했습니다.");
      }).catch(() => setTransfer({ ...transfer }));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [transfer, nodes]);
  // 대상 컴퓨터의 환경 재구성 작업이 끝날 때까지 2초마다 상태를 읽는다.
  useEffect(() => {
    if (!job || job.job.status !== "running") return;
    const timer = window.setTimeout(() => {
      void api(`/federation/nodes/${encodeURIComponent(job.nodeId)}/api/project-transfer/jobs/${job.job.id}`)
        .then((data) => data?.job && setJob({ nodeId: job.nodeId, job: data.job }))
        .catch(() => setJob({ ...job }));
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [job]);

  async function send(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const node = nodes.find((item) => item.id === nodeId);
    const project = projects.find((item) => String(item.id) === projectId);
    if (!node || !project || !preview) return;
    if (!window.confirm(`${project.name}을(를) ${node.name}에 복사할까요?\n파일 ${preview.fileCount.toLocaleString()}개(${formatBytes(preview.bytes)})를 보내고, 대상에서 실행 환경 ${preview.steps.length}개를 다시 설치합니다. 이 컴퓨터의 원본은 그대로 남습니다.`)) return;
    setBusy(true); setStatus(""); setJob(null); setTransfer(null);
    try {
      const data = await api(`/projects/${projectId}/transfer`, { method: "POST", body: JSON.stringify({ nodeId, name, destinationPath: destinationPath.trim() || undefined }) });
      setTransfer(data.transfer);
    } catch (error: any) { setStatus(error?.message || "프로젝트를 보내지 못했습니다."); }
    finally { setBusy(false); }
  }

  const sending = transfer?.state === "uploading" || transfer?.state === "extracting";
  const blocked = !preview || preview.busyChats.length > 0 || !nodeId || sending;
  return <article className="card provider-settings-card project-transfer-card">
    <div className="card-top"><span>프로젝트 이동</span></div>
    <p className="muted">프로젝트 폴더 전체(.git, .env 같은 Git 밖 파일, 커밋하지 않은 변경 포함)를 연결 컴퓨터에 복사해 등록합니다. 복사만으로는 깨지는 node_modules·Python 가상환경은 빼고 보낸 뒤 대상에서 lockfile 기준으로 다시 설치합니다. 채팅 기록과 채팅 전용 worktree의 미커밋 변경은 옮기지 않습니다.</p>
    <form className="slack-settings-form" onSubmit={(event) => void send(event)}>
      <div className="server-log-filters">
        <label>프로젝트<select value={projectId} onChange={(event) => setProjectId(event.target.value)} required>
          <option value="">선택하세요</option>
          {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        <label>보낼 컴퓨터<select value={nodeId} onChange={(event) => setNodeId(event.target.value)} required>
          {nodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}
        </select></label>
      </div>
      <label>대상에서 쓸 이름<input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} placeholder="프로젝트 이름" /></label>
      <label>대상 경로(선택)<input value={destinationPath} onChange={(event) => setDestinationPath(event.target.value)} placeholder="비우면 대상 컴퓨터의 프로젝트 폴더/이름" /></label>
      {preview && <div className="provider-settings-summary-item project-transfer-preview">
        <strong>파일 {preview.fileCount.toLocaleString()}개 · {formatBytes(preview.bytes)}</strong>
        {preview.steps.length ? preview.steps.map((step) => <small key={`${step.kind}:${step.dir}:${step.venvName ?? ""}`}>대상에서 다시 설치: {describeStep(step)}</small>) : <small>다시 설치할 실행 환경 없음</small>}
        {preview.warnings.map((warning) => <small key={warning} className="project-transfer-warning">⚠ {warning}</small>)}
        {preview.busyChats.length > 0 && <small className="project-transfer-warning">작업 중인 채팅({preview.busyChats.map((id) => `#${id}`).join(", ")})이 끝난 뒤에 옮길 수 있습니다.</small>}
      </div>}
      <div className="slack-settings-actions"><button className="primary" disabled={busy || blocked}>{busy ? "보내는 중…" : "복사해서 보내기"}</button></div>
    </form>
    {sending && transfer && <div className="provider-settings-backups" role="status">
      <strong>{transfer.state === "uploading" ? `보내는 중 · ${formatBytes(transfer.sentBytes)} 보냄 (압축 전 원본 ${formatBytes(transfer.sourceBytes)})` : "대상 컴퓨터에서 압축을 푸는 중…"}</strong>
      <small className="muted">대상 경로: {transfer.destination}</small>
    </div>}
    {job && <div className="provider-settings-backups">
      <strong>{nodes.find((node) => node.id === job.nodeId)?.name}: 실행 환경 재구성 {job.job.status === "running" ? "진행 중" : job.job.status === "succeeded" ? "완료" : "일부 실패"}</strong>
      {job.job.steps.length === 0 && <p className="muted">다시 설치할 환경이 없습니다.</p>}
      {job.job.steps.map((step, index) => <details key={index} className={`project-transfer-step status-${step.status}`} open={step.status === "failed"}>
        <summary><span>{step.label}</span><i>{STEP_LABEL[step.status]}</i></summary>
        <code>{step.command}</code>
        {step.output && <pre>{step.output}</pre>}
      </details>)}
    </div>}
    {status && <p className="attachment-status provider-settings-status" aria-live="polite">{status}</p>}
  </article>;
}
