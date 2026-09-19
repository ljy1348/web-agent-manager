import fs from "node:fs";
import path from "node:path";
import type { ProviderLaunchProfile } from "../providers/provider";

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function optionalText(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 200 || /[\0\r\n]/.test(value)) throw new Error(`프로젝트 profile ${label}이 올바르지 않습니다.`);
  return value;
}

function textList(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new Error(`프로젝트 profile ${label}이 올바르지 않습니다.`);
  const result = value.map((item) => optionalText(item, label)).filter((item): item is string => item !== null);
  if (new Set(result).size !== result.length) throw new Error(`프로젝트 profile ${label}에 중복 값이 있습니다.`);
  return result;
}

function writablePaths(value: unknown, workspacePath: string): string[] {
  const requested = textList(value, "추가 쓰기 경로");
  if (requested.length > 10) throw new Error("프로젝트 profile 추가 쓰기 경로는 10개 이하여야 합니다.");
  const resolved = requested.map((entry) => {
    const target = path.resolve(workspacePath, entry);
    let real: string;
    try { real = fs.realpathSync(target); } catch { throw new Error("프로젝트 profile 추가 쓰기 경로를 찾을 수 없습니다."); }
    if (!fs.statSync(real).isDirectory()) throw new Error("프로젝트 profile 추가 쓰기 경로는 폴더여야 합니다.");
    return real;
  });
  return [...new Set(resolved)];
}

// 저장된 불변 snapshot을 실행 직전에 다시 검증한다. 활성화 API가 관리자 전용이어도 손상된 DB나
// 오래된 snapshot이 위험한 조합을 만들 수 있으므로 analysis/danger-full-access 경계는 여기서도 막는다.
export function projectProfileLaunch(snapshotJson: string | null | undefined, workspacePath: string): ProviderLaunchProfile | undefined {
  if (!snapshotJson) return undefined;
  let snapshot: Record<string, unknown> | null;
  try { snapshot = object(JSON.parse(snapshotJson)); } catch { throw new Error("프로젝트 profile snapshot을 읽을 수 없습니다."); }
  if (!snapshot) throw new Error("프로젝트 profile snapshot이 올바르지 않습니다.");
  // Agent Lab에서 승격한 이전 preset snapshot에는 taskKind가 없을 수 있다. DB의 legacy 기본값과
  // 같은 implementation으로 해석하되 runtime.sandbox도 읽어 기존 실험 제약을 잃지 않는다.
  const taskKind = optionalText(snapshot.taskKind, "작업 종류") ?? "implementation";
  if (!["analysis", "implementation", "high_risk", "operations"].includes(taskKind)) {
    throw new Error("프로젝트 profile 작업 종류가 올바르지 않습니다.");
  }
  const runtime = object(snapshot.runtime) ?? {};
  const permissions = object(snapshot.permissions) ?? {};
  const sandboxValue = optionalText(permissions.sandbox, "sandbox") ?? optionalText(runtime.sandbox, "sandbox")
    ?? (taskKind === "analysis" ? "read-only" : "workspace-write");
  if (!["read-only", "workspace-write", "danger-full-access"].includes(sandboxValue)) throw new Error("프로젝트 profile sandbox가 올바르지 않습니다.");
  if (taskKind === "analysis" && sandboxValue !== "read-only") throw new Error("analysis profile은 read-only sandbox여야 합니다.");
  if (sandboxValue === "danger-full-access" && !["high_risk", "operations"].includes(taskKind)) {
    throw new Error("danger-full-access는 high_risk 또는 operations profile에서만 사용할 수 있습니다.");
  }
  const rawApproval = optionalText(permissions.approvalMode, "승인 모드") ?? "on-request";
  const approvalMode = rawApproval === "untrusted" || rawApproval === "manual" ? "on-request" : rawApproval;
  if (approvalMode !== "on-request" && approvalMode !== "never") throw new Error("프로젝트 profile 승인 모드가 올바르지 않습니다.");
  if (sandboxValue === "danger-full-access" && approvalMode === "never") {
    throw new Error("danger-full-access profile은 승인을 끌 수 없습니다.");
  }
  const additionalWritePaths = writablePaths(permissions.additionalWritePaths, workspacePath);
  if (additionalWritePaths.length && sandboxValue === "read-only") {
    throw new Error("read-only profile에는 추가 쓰기 경로를 지정할 수 없습니다.");
  }
  if (additionalWritePaths.length && approvalMode !== "on-request") {
    throw new Error("추가 쓰기 경로가 있는 profile은 on-request 승인이 필요합니다.");
  }
  return {
    sandbox: sandboxValue as ProviderLaunchProfile["sandbox"],
    approvalMode,
    model: optionalText(runtime.model, "모델"),
    reasoningEffort: optionalText(runtime.reasoningEffort, "추론 강도"),
    additionalWritePaths,
    allowedTools: textList(permissions.allowedTools, "허용 도구"),
    disallowedTools: textList(permissions.disallowedTools, "차단 도구"),
  };
}
