import type { ApprovalAction, ChatActivity, Json } from "../types";

// Claude 훅의 tool_input은 도구마다 필드가 달라, 사용자가 뭘 승인하는지 한눈에 알아볼 수 있는
// 대표 필드(명령어·파일 경로)만 뽑는다. 없으면 전체를 짧게 잘라 보여준다.
function summarizeToolInput(toolInput: Json | undefined): string {
  if (!toolInput || typeof toolInput !== "object") return "";
  // ExitPlanMode는 plan 필드에 실제 검토해야 할 계획 전문(수 KB)을 담고 있다. 아래 JSON.stringify
  // 300자 자르기에 걸리면 줄바꿈이 이스케이프된 채 앞부분만 잘려 나와 계획을 제대로 볼 수 없었다
  // (실제 승인 화면에서 재현·확인됨) — 이 필드가 있으면 그대로(자르지 않고) 보여준다.
  if (typeof toolInput.plan === "string") return toolInput.plan;
  if (typeof toolInput.command === "string") return toolInput.command;
  if (typeof toolInput.file_path === "string") return toolInput.file_path;
  if (typeof toolInput.path === "string") return toolInput.path;
  try {
    return JSON.stringify(toolInput).slice(0, 300);
  } catch {
    return "";
  }
}

// 승인 요청 본문을 채팅창과 메뉴에서 표시할 요약으로 변환한다.
export function approvalSummary(item: Json): string {
  try {
    const payload = JSON.parse(item.request_payload || "{}");
    // Claude PermissionRequest 훅은 {summary}가 아니라 tool_name/tool_input을 그대로 담아 보내므로,
    // 그냥 두면 화면에 "permission"이라는 요청유형 이름만 뜨고 정작 뭘 승인하는지 안 보였다.
    if (item.request_type === "permission" && payload.tool_name) {
      const detail = summarizeToolInput(payload.tool_input);
      return detail ? `${payload.tool_name}: ${detail}` : String(payload.tool_name);
    }
    return payload.summary || item.request_type;
  } catch {
    return item.request_type;
  }
}

export interface AskUserQuestionOption { label: string; description?: string }
export interface AskUserQuestionEntry { question: string; header?: string; options: AskUserQuestionOption[]; multiSelect?: boolean }

// permission 요청이 AskUserQuestion 도구 호출이면 실제 질문·선택지 배열을 반환한다(아니면 null).
// 이 도구 호출은 "실행해도 되냐"가 아니라 사용자가 직접 골라야 할 진짜 질문을 담고 있어, 일반
// 허용/거부 버튼이 아니라 질문 폼으로 따로 렌더링해야 한다.
export function askUserQuestionPayload(item: Json): AskUserQuestionEntry[] | null {
  if (item.request_type !== "permission") return null;
  try {
    const payload = JSON.parse(item.request_payload || "{}");
    if (payload.tool_name !== "AskUserQuestion") return null;
    const questions = payload.tool_input?.questions;
    return Array.isArray(questions) && questions.length ? questions : null;
  } catch {
    return null;
  }
}

// 승인 요청 유형에 맞는 버튼 라벨을 반환한다.
export function approvalActions(item: Json): ApprovalAction[] {
  if (item.request_type === "rate_limit_options") return [
    { decision: "accept", label: "재설정까지 대기", className: "primary" },
    { decision: "acceptForSession", label: "플랜 업그레이드" },
    { decision: "decline", label: "취소", className: "danger" },
  ];
  // Codex가 한도 임박 시 띄우는 "경량 모델로 전환할지" 3지선다 화면. 실제 옵션 1/2/3에 그대로 대응한다.
  if (item.request_type === "model_switch_prompt") return [
    { decision: "accept", label: "경량 모델로 전환", className: "primary" },
    { decision: "acceptForSession", label: "현재 모델 유지" },
    { decision: "decline", label: "유지(다시 안 물어봄)", className: "danger" },
  ];
  // Claude가 세션 재개 시(터미널을 껐다 켠 뒤 --resume) 묻는 "요약 재개/전체 재개/다시 안 물어봄" 3지선다.
  if (item.request_type === "resume_session_prompt") return [
    { decision: "accept", label: "요약해서 재개 (권장)", className: "primary" },
    { decision: "acceptForSession", label: "전체 세션 그대로 재개" },
    { decision: "decline", label: "다시 묻지 않음", className: "danger" },
  ];
  if (item.request_type === "browser_permission_prompt") return [
    { decision: "accept", label: "확장 설치", className: "primary" },
    { decision: "decline", label: "이번엔 안 함" },
    { decision: "acceptForSession", label: "다시 묻지 않음", className: "danger" },
  ];
  // Claude가 디렉터리 신뢰 확인 등에서 묻는 단순 y/n 확인 화면. 실제 선택지가 2개뿐이다.
  if (item.request_type === "confirm_yn") return [
    { decision: "accept", label: "예 (y)", className: "primary" },
    { decision: "decline", label: "아니오 (n)", className: "danger" },
  ];
  // Codex가 새 디렉터리에서 처음 묻는 "이 디렉터리를 신뢰합니까?" 화면. 실제 선택지가 2개뿐이다.
  if (item.request_type === "trust_directory") return [
    { decision: "accept", label: "신뢰함 (계속)", className: "primary" },
    { decision: "decline", label: "신뢰 안 함 (종료)", className: "danger" },
  ];
  return [
    { decision: "accept", label: "1회 허용", className: "primary" },
    { decision: "acceptForSession", label: "세션 허용" },
    { decision: "decline", label: "거부", className: "danger" },
  ];
}

// 채팅의 실행 상태와 pending 승인을 합쳐 사용자가 볼 작업 상태를 계산한다. busy는 서버가 채팅별로 DB에
// 영속화해 관리하는 값을 그대로 받되, 종료 상태는 남아 있는 옛 busy 값보다 우선한다.
export function chatActivity(chat: Json, pendingApprovals: Json[]): ChatActivity {
  if (pendingApprovals.some((item) => item.chat_id === chat.id)) return { label: "권한 요청", className: "needs-approval" };
  if (!!chat.rate_limit_waiting) return { label: "리밋 대기", className: "rate-limited" };
  if (chat.status === "stopped") return { label: "종료", className: "stopped" };
  if (!!chat.busy || ["starting", "resuming", "stopping"].includes(chat.status)) return { label: "작업중", className: "working" };
  if (chat.status === "running") return { label: "대기중", className: "idle" };
  if (chat.status === "error") return { label: "오류", className: "error" };
  return { label: chat.status || "대기중", className: "idle" };
}
