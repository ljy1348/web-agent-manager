import { describe, expect, it } from "vitest";
import { issueBranchName } from "../src/server/routes/git-routes";

describe("이슈 브랜치명 생성", () => {
  it("영문 제목을 소문자 슬러그로 바꾼다", () => {
    expect(issueBranchName(12, "Fix login redirect")).toBe("issue-12-fix-login-redirect");
  });

  it("git 브랜치명에 쓸 수 없는 문자를 하이픈으로 합친다", () => {
    expect(issueBranchName(3, "Add  ~caret~ and :colon: support!")).toBe("issue-3-add-caret-and-colon-support");
  });

  it("한글만 있는 제목은 남는 슬러그가 없어 번호만 쓴다", () => {
    // 한글은 브랜치명으로 쓸 수는 있지만 도구·CI에서 깨지는 경우가 많아 슬러그에서 제외한다.
    expect(issueBranchName(45, "로그인 리다이렉트 수정")).toBe("issue-45");
  });

  it("아주 긴 제목은 잘라내되 끝에 하이픈을 남기지 않는다", () => {
    const name = issueBranchName(7, "a".repeat(30) + " " + "b".repeat(30));
    expect(name.length).toBeLessThanOrEqual("issue-7-".length + 40);
    expect(name.endsWith("-")).toBe(false);
  });

  it("제목이 비어 있어도 유효한 이름을 만든다", () => {
    expect(issueBranchName(99, "")).toBe("issue-99");
    expect(issueBranchName(99, "   ")).toBe("issue-99");
  });
});
