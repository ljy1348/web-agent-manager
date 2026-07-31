import { describe, expect, it } from "vitest";
import { splitMessageContent, mergeMessages, reconcileOptimisticMessages } from "../src/client/message-display";

describe("채팅 메시지 표시", () => {
  it("응답에 섞인 도구 내용을 접을 상세로 분리한다", () => {
    const display = splitMessageContent({ role: "assistant", kind: "text", content: "최종 응답입니다.\n[도구: Bash]\n{\"command\":\"git diff\"}" });
    expect(display.primary).toBe("최종 응답입니다.");
    expect(display.details[0]).toContain("git diff");
    expect(display.detailLabel).toBe("변경사항 보기");
  });

  it("diff 코드 블록은 본문에서 숨긴다", () => {
    const display = splitMessageContent({ role: "assistant", content: "수정했습니다.\n```diff\n-old\n+new\n```" });
    expect(display.primary).toBe("수정했습니다.");
    expect(display.details[0]).toContain("-old");
    expect(display.detailLabel).toBe("변경사항 보기");
  });

  it("도구 역할 메시지는 전체를 접는다", () => {
    const display = splitMessageContent({ role: "tool", kind: "function_call_output", content: "긴 실행 결과" });
    expect(display.primary).toBe("");
    expect(display.details).toEqual(["긴 실행 결과"]);
    expect(display.detailLabel).toBe("도구 실행 내용 보기");
  });
});

describe("메시지 병합", () => {
  it("겹치는 페이지를 id로 중복 제거하고 시간순 정렬한다", () => {
    const older = [{ id: "a", createdAt: "2026-07-07T00:00:00.000Z" }, { id: "b", createdAt: "2026-07-07T00:00:01.000Z" }];
    const latest = [{ id: "b", createdAt: "2026-07-07T00:00:01.000Z" }, { id: "c", createdAt: "2026-07-07T00:00:02.000Z" }];
    expect(mergeMessages(older, latest).map((message) => message.id)).toEqual(["a", "b", "c"]);
  });

  it("실제 기록이 생긴 입력만 확정하고 나머지 작업 중 큐 메시지를 보존한다", () => {
    const current = [
      { id: "known", role: "assistant", content: "진행 중", createdAt: "2026-07-07T00:00:00.000Z" },
      { id: "optimistic-1", role: "user", content: "같은 후속 명령", createdAt: "2026-07-07T00:00:01.000Z", optimistic: true },
      { id: "optimistic-2", role: "user", content: "같은 후속 명령", createdAt: "2026-07-07T00:00:02.000Z", optimistic: true },
    ];
    const assistantOnly = [
      { id: "known", role: "assistant", content: "진행 중", createdAt: "2026-07-07T00:00:00.000Z" },
      { id: "progress", role: "assistant", content: "계속 진행", createdAt: "2026-07-07T00:00:03.000Z" },
    ];
    const preserved = reconcileOptimisticMessages(current, assistantOnly);
    expect(preserved.filter((item) => item.optimistic).map((item) => item.id)).toEqual(["optimistic-1", "optimistic-2"]);

    const oneRecorded = reconcileOptimisticMessages(preserved, [...assistantOnly, {
      id: "actual-user-1",
      role: "user",
      content: "같은 후속 명령",
      createdAt: "2026-07-07T00:00:04.000Z",
    }]);
    expect(oneRecorded.filter((item) => item.optimistic).map((item) => item.id)).toEqual(["optimistic-2"]);
  });
});
