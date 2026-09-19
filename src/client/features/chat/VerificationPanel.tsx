import React, { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import type { Json } from "../../types";

const STATE_LABELS: Record<string, string> = {
  created: "생성됨", running: "실행 중", needs_input: "확인 필요", verifying: "검증 중", completed: "완료", failed: "실패",
  cancelled: "취소", budget_exceeded: "예산 초과", pending: "대기", passed: "통과", blocked: "차단", timed_out: "시간 초과",
};

const REASON_LABELS: Record<string, string> = {
  verification_passed: "로컬 검증 통과",
  verification_failed: "필수 로컬 검증 실패",
  verification_artifact_redaction_blocked: "민감정보가 감지된 결과물",
  verification_recipe_missing: "검증 recipe 없음",
  verification_no_steps_selected: "변경 범위에 선택된 단계 없음",
  workspace_snapshot_failed: "작업공간 증거 생성 실패",
  workspace_snapshot_failed_after_verification: "검증 후 작업공간 증거 생성 실패",
  workspace_changed_during_verification: "검증 도중 작업공간 변경",
  explicit_approval_required: "live/human 검증 승인 필요",
  explicit_approval_declined: "live/human 검증 거부",
  pull_request_number_required: "PR 번호 필요",
  pull_request_workspace_not_clean: "커밋되지 않은 변경이 있어 PR 체크 연결 불가",
  pull_request_head_mismatch: "PR head와 로컬 commit 불일치",
  pull_request_checks_passed: "PR 체크 통과",
  pull_request_checks_failed: "PR 체크 실패",
  pull_request_checks_pending: "PR 체크 진행 중",
  pull_request_checks_unavailable: "PR 체크 조회 불가",
};

function parseSummary(value: unknown): Json {
  try { return typeof value === "string" ? JSON.parse(value) : value && typeof value === "object" ? value as Json : {}; }
  catch { return {}; }
}

function shortHash(value: unknown): string {
  const text = String(value ?? "");
  return text ? text.slice(0, 10) : "없음";
}

function idempotencyKey(prefix: string): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${suffix}`;
}

function stateLabel(value: unknown): string {
  const state = String(value ?? "");
  return STATE_LABELS[state] ?? state;
}

function reasonLabel(value: unknown): string {
  const reason = String(value ?? "");
  return REASON_LABELS[reason] ?? reason;
}

export function VerificationPanel({ chatId, isAdmin, canRunTests, refreshKey }: { chatId: number; isAdmin: boolean; canRunTests: boolean; refreshKey?: unknown }): React.ReactElement | null {
  const [data, setData] = useState<Json | null>(null);
  const [error, setError] = useState("");
  const [acting, setActing] = useState("");
  const [pullRequestNumber, setPullRequestNumber] = useState("");
  const [expanded, setExpanded] = useState(false);

  const load = async (): Promise<void> => {
    try {
      const next = await api(`/chats/${chatId}/current-task`);
      setData(next?.task ? next : { task: null, verifications: [] });
      setError("");
    } catch (cause: any) {
      setError(cause?.message || "검증 정보를 불러오지 못했습니다.");
    }
  };

  useEffect(() => {
    let active = true;
    void api(`/chats/${chatId}/current-task`).then((next) => {
      if (active) { setData(next?.task ? next : { task: null, verifications: [] }); setError(""); }
    }).catch((cause: any) => { if (active) setError(cause?.message || "검증 정보를 불러오지 못했습니다."); });
    return () => { active = false; };
  }, [chatId, refreshKey]);

  useEffect(() => { setExpanded(false); }, [chatId]);

  const task = data?.task as Json | null | undefined;
  const runs = useMemo(() => (Array.isArray(data?.verifications) ? data!.verifications as Json[] : []), [data]);
  const latest = runs[0];

  useEffect(() => {
    if (task?.state === "needs_input" || task?.state === "failed") setExpanded(true);
  }, [task?.state]);

  if (data === null && !error) return <div className="verification-panel loading" role="status">검증 정보 불러오는 중…</div>;
  if (!task && !error) return null;

  const act = async (name: string, request: () => Promise<unknown>): Promise<void> => {
    setActing(name);
    setError("");
    try { await request(); await load(); }
    catch (cause: any) { setError(cause?.message || "검증 작업에 실패했습니다."); }
    finally { setActing(""); }
  };

  const runVerification = (): Promise<unknown> => {
    const number = pullRequestNumber.trim() ? Number(pullRequestNumber) : undefined;
    return api(`/tasks/${task!.id}/verifications`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey("verification") },
      body: JSON.stringify(number ? { pullRequestNumber: number } : {}),
    });
  };

  return <details className={`verification-panel state-${task?.state ?? "error"}`} open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary>
      <span>검증</span>
      {task && <b className={`verification-state state-${task.state}`}>{stateLabel(task.state)}</b>}
      {latest?.run?.pull_request_number && <span>PR #{latest.run.pull_request_number}</span>}
      {latest && <span>{latest.steps?.length ?? 0}단계 · {shortHash(latest.run?.diff_hash)}</span>}
    </summary>
    <div className="verification-panel-body">
      {error && <p className="verification-error" role="alert">{error}</p>}
      {task && <div className="verification-task-meta">
        <span>Task <code>{shortHash(task.id)}</code></span>
        <span>Profile <b>{task.profile_name || "미지정"}</b>{task.profile_version ? ` v${task.profile_version}` : ""}</span>
        {task.state_reason && <span>게이트 <b>{reasonLabel(task.state_reason)}</b></span>}
      </div>}
      {canRunTests && task && !latest && <div className="verification-actions">
        <label>PR 번호(선택)<input aria-label="검증에 연결할 PR 번호" type="number" min="1" inputMode="numeric" value={pullRequestNumber} onChange={(event) => setPullRequestNumber(event.target.value)} /></label>
        <button type="button" className="primary" disabled={!!acting || (!!pullRequestNumber && Number(pullRequestNumber) < 1)} onClick={() => void act("run", runVerification)}>{acting === "run" ? "검증 중…" : "검증 실행"}</button>
      </div>}
      {!!runs.length && <div className="verification-timeline" aria-label="검증 실행 기록">{runs.map((verification: Json, index: number) => {
        const run = verification.run ?? {};
        const summary = parseSummary(run.summary_json);
        const selection = summary.selection ?? {};
        const pullRequest = summary.pullRequest ?? parseSummary(run.pull_request_checks_json);
        const canDecide = isAdmin && run.state === "blocked" && summary.reason === "explicit_approval_required";
        const canRerun = canRunTests && ["passed", "failed", "blocked"].includes(run.state);
        return <article className={`verification-run state-${run.state}`} key={run.id}>
          <header><b>{index === 0 ? "최신 실행" : "이전 실행"} · {stateLabel(run.state)}</b><span>{run.trigger === "reverification" ? "재검증" : "수동"}</span></header>
          <div className="verification-run-evidence">
            <span>commit <code>{shortHash(run.commit_hash)}</code></span><span>diff <code>{shortHash(run.diff_hash)}</code></span>
            {run.source_run_id && <span>원본 <code>{shortHash(run.source_run_id)}</code></span>}
          </div>
          {summary.reason && <p className="verification-reason">{reasonLabel(summary.reason)}</p>}
          {pullRequest?.number && <div className={`verification-pr state-${pullRequest.state}`}>
            <b>PR #{pullRequest.number} · {stateLabel(pullRequest.state)}</b>
            <span>통과 {pullRequest.passedCount ?? 0} · 실패 {pullRequest.failedCount ?? 0} · 대기 {pullRequest.pendingCount ?? 0} · 확인불가 {pullRequest.unavailableCount ?? 0}</span>
            {pullRequest.headSha && <span>head <code>{shortHash(pullRequest.headSha)}</code></span>}
          </div>}
          {!!selection.selected?.length && <div className="verification-selection"><b>선택</b>{selection.selected.map((item: Json) => <span key={`selected-${item.ordinal}`}>#{item.ordinal} {item.kind}</span>)}</div>}
          {!!selection.skipped?.length && <div className="verification-selection skipped"><b>생략</b>{selection.skipped.map((item: Json) => <span key={`skipped-${item.ordinal}`}>#{item.ordinal} {item.kind} · {item.reason}</span>)}</div>}
          {!!verification.steps?.length && <ol className="verification-steps">{verification.steps.map((step: Json) => <li key={step.id} className={`state-${step.state}`}><span>#{step.ordinal} {step.kind}</span><b>{stateLabel(step.state)}</b><small>{step.duration_ms ?? 0}ms</small></li>)}</ol>}
          {!!verification.artifacts?.length && <div className="verification-artifacts">{verification.artifacts.map((artifact: Json) => <span key={artifact.id}>
            결과물 <code>{shortHash(artifact.sha256)}</code> · {artifact.redaction_status === "safe" ? "안전" : "격리"}
            {isAdmin && artifact.redaction_status === "safe" && <> · <a href={`/api/verification-artifacts/${artifact.id}`} download>로그 받기</a></>}
          </span>)}</div>}
          {(canDecide || canRerun) && <div className="verification-run-actions">
            {canDecide && <><button type="button" className="primary" disabled={!!acting} onClick={() => void act(`approve-${run.id}`, () => api(`/verifications/${run.id}/decision`, { method: "POST", headers: { "Idempotency-Key": idempotencyKey("verification-approve") }, body: JSON.stringify({ decision: "approve" }) }))}>승인 후 실행</button><button type="button" className="danger" disabled={!!acting} onClick={() => void act(`decline-${run.id}`, () => api(`/verifications/${run.id}/decision`, { method: "POST", headers: { "Idempotency-Key": idempotencyKey("verification-decline") }, body: JSON.stringify({ decision: "decline" }) }))}>거부</button></>}
            {canRerun && !canDecide && <button type="button" disabled={!!acting} onClick={() => void act(`rerun-${run.id}`, () => api(`/verifications/${run.id}/rerun`, { method: "POST", headers: { "Idempotency-Key": idempotencyKey("verification-rerun") } }))}>{acting === `rerun-${run.id}` ? "재검증 중…" : "같은 변경 재검증"}</button>}
          </div>}
        </article>;
      })}</div>}
      {data?.hasMore && <p className="verification-more-note">최근 20회만 표시합니다. 전체 조회 API에서 이전 기록을 확인할 수 있습니다.</p>}
    </div>
  </details>;
}
