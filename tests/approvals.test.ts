import { describe, expect, it } from "vitest";
import { approvalActions, approvalSummary, chatActivity } from "../src/client/lib/approvals";

describe("승인 요약·버튼 라벨", () => {
  it("Claude PermissionRequest 훅(permission)은 tool_name/tool_input에서 실제 명령을 요약한다", () => {
    const item = {
      request_type: "permission",
      request_payload: JSON.stringify({
        session_id: "s1",
        cwd: "/home/testuser/project",
        tool_name: "Bash",
        tool_input: { command: "curl -s https://example.com", description: "외부 네트워크 요청" },
      }),
    };
    expect(approvalSummary(item)).toBe("Bash: curl -s https://example.com");
  });

  it("permission의 tool_input이 file_path만 있으면 그걸 요약으로 쓴다", () => {
    const item = {
      request_type: "permission",
      request_payload: JSON.stringify({ tool_name: "Write", tool_input: { file_path: "/tmp/out.txt", content: "hello" } }),
    };
    expect(approvalSummary(item)).toBe("Write: /tmp/out.txt");
  });

  it("ExitPlanMode는 plan 전문을 자르지 않고 그대로 요약으로 쓴다", () => {
    // 실제 사용자가 보고한 문제(2026-07-08): plan 필드가 command/file_path/path 중 어디에도
    // 안 걸려 JSON.stringify 후 300자로 잘리면서 계획 앞부분만(그것도 줄바꿈이 이스케이프된 채로)
    // 보였다.
    const longPlan = "# 제목\n\n".padEnd(500, "긴 계획 내용 ");
    const item = {
      request_type: "permission",
      request_payload: JSON.stringify({ tool_name: "ExitPlanMode", tool_input: { plan: longPlan, planFilePath: "/root/.claude/plans/x.md" } }),
    };
    expect(approvalSummary(item)).toBe(`ExitPlanMode: ${longPlan}`);
  });

  it("permission인데 tool_name이 없으면 기존처럼 request_type을 보여준다", () => {
    const item = { request_type: "permission", request_payload: "{}" };
    expect(approvalSummary(item)).toBe("permission");
  });

  it("terminal_approval 등 summary가 담긴 유형은 그대로 사용한다", () => {
    const item = { request_type: "terminal_approval", request_payload: JSON.stringify({ summary: "1. Yes\n2. No" }) };
    expect(approvalSummary(item)).toBe("1. Yes\n2. No");
  });

  it("confirm_yn·trust_directory는 각각 2개의 액션만 반환한다", () => {
    expect(approvalActions({ request_type: "confirm_yn" })).toHaveLength(2);
    expect(approvalActions({ request_type: "trust_directory" })).toHaveLength(2);
  });

  it("resume_session_prompt는 요약 재개를 사용자가 직접 고르는 3개 액션을 반환한다", () => {
    expect(approvalActions({ request_type: "resume_session_prompt" }).map((action) => action.label)).toEqual([
      "요약해서 재개 (권장)",
      "전체 세션 그대로 재개",
      "다시 묻지 않음",
    ]);
  });

  it("browser_permission_prompt는 브라우저 확장 선택지 의미 그대로 3개 액션을 반환한다", () => {
    expect(approvalActions({ request_type: "browser_permission_prompt" }).map((action) => action.label)).toEqual([
      "확장 설치",
      "이번엔 안 함",
      "다시 묻지 않음",
    ]);
  });

  it("리밋 재개 대기 중인 채팅은 별도 상태로 표시한다", () => {
    expect(chatActivity({ id: 1, status: "running", busy: 0, rate_limit_waiting: 1 }, [])).toEqual({
      label: "리밋 대기",
      className: "rate-limited",
    });
  });

  it("종료된 채팅은 옛 busy 값이 남아 있어도 종료로 표시한다", () => {
    expect(chatActivity({ id: 159, status: "stopped", busy: 1, rate_limit_waiting: 0 }, [])).toEqual({
      label: "종료",
      className: "stopped",
    });
  });
});
