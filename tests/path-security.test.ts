import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertAllowedPath, safeBasename } from "../src/server/core/security";
import { assertNonSensitiveRelativePath, resolveNonSensitiveProjectPath, resolveProjectPath } from "../src/server/routes/helpers";

const temporaryRoots: string[] = [];

// 테스트별 임시 프로젝트 루트를 생성한다.
function createRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-path-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("프로젝트 파일 경계", () => {
  it("아직 없는 중첩 지침 경로를 프로젝트 안에서 허용한다", () => {
    const root = createRoot();
    expect(resolveProjectPath(root, ".claude/CLAUDE.md", false)).toBe(path.join(root, ".claude", "CLAUDE.md"));
  });

  it("상위 경로 이동과 외부 symlink를 거부한다", () => {
    const root = createRoot();
    const outside = createRoot();
    fs.symlinkSync(outside, path.join(root, "outside"));
    expect(() => resolveProjectPath(root, "../escape", false)).toThrow("프로젝트 경로");
    expect(() => resolveProjectPath(root, "outside/file.txt", false)).toThrow("프로젝트 경로");
  });

  it("일반 파일 API에서 공급자 설정 디렉터리를 차단한다", () => {
    expect(() => assertNonSensitiveRelativePath(".codex/config.toml")).toThrow();
    expect(() => assertNonSensitiveRelativePath(".claude/settings.json")).toThrow();
    expect(() => assertNonSensitiveRelativePath("AGENTS.md")).toThrow();
    expect(() => assertNonSensitiveRelativePath(".env.local")).toThrow();
    expect(() => assertNonSensitiveRelativePath(".env-production", { allowHidden: true })).toThrow();
    expect(() => assertNonSensitiveRelativePath(".web-agent-manager-uploads/1/file.png", { allowHidden: true })).toThrow();
    expect(() => assertNonSensitiveRelativePath("src/index.ts")).not.toThrow();
  });

  it("점 파일은 내부망에서만 허용하되 민감 경로는 내부망에서도 차단한다", () => {
    expect(() => assertNonSensitiveRelativePath(".vscode/settings.json")).toThrow();
    expect(() => assertNonSensitiveRelativePath(".vscode/settings.json", { allowHidden: true })).not.toThrow();
    expect(() => assertNonSensitiveRelativePath(".env", { allowHidden: true })).toThrow();
    expect(() => assertNonSensitiveRelativePath(".claude/settings.json", { allowHidden: true })).toThrow();
  });

  it("일반 파일 API에서 symlink가 가리키는 실제 민감 경로도 차단한다", () => {
    const root = createRoot();
    fs.writeFileSync(path.join(root, ".env"), "TOKEN=secret", "utf8");
    fs.symlinkSync(path.join(root, ".env"), path.join(root, "public-name"));

    expect(() => resolveNonSensitiveProjectPath(root, "public-name")).toThrow("일반 파일 기능으로 접근할 수 없는 경로입니다.");
  });

  it("허용 루트가 \"/\"면 서로 다른 상위 디렉터리의 경로도 등록을 허용한다", () => {
    // 관리자 전용 프로젝트 등록은 특정 홈 디렉터리로 좁히지 않는 게 기본값이라, 형제 디렉터리(예: /home/test)도
    // WEB_AGENT_MANAGER_ALLOWED_ROOTS를 별도로 설정하지 않고 바로 추가할 수 있어야 한다.
    const siblingA = createRoot();
    const siblingB = createRoot();
    expect(assertAllowedPath(siblingA, ["/"])).toBe(fs.realpathSync(siblingA));
    expect(assertAllowedPath(siblingB, ["/"])).toBe(fs.realpathSync(siblingB));
  });

  it("허용 루트를 명시적으로 좁히면 그 밖의 경로는 여전히 거부한다", () => {
    const inside = createRoot();
    const outside = createRoot();
    expect(() => assertAllowedPath(outside, [inside])).toThrow("허용된 프로젝트 경로를 벗어났습니다.");
  });

  it("업로드 파일명에서 제어문자와 운영체제 예약명을 거부한다", () => {
    expect(safeBasename("ok.txt")).toBe("ok.txt");
    expect(() => safeBasename("../ok.txt")).toThrow("유효하지 않은 파일명입니다.");
    expect(() => safeBasename("dir\\ok.txt")).toThrow("유효하지 않은 파일명입니다.");
    expect(() => safeBasename("bad\u0001.txt")).toThrow("유효하지 않은 파일명입니다.");
    expect(() => safeBasename("CON")).toThrow("유효하지 않은 파일명입니다.");
    expect(() => safeBasename("name.")).toThrow("유효하지 않은 파일명입니다.");
  });
});
