import path from "node:path";
import { describe, expect, it } from "vitest";
import { isInsideRoot } from "../src/server/core/security";
import { parseAllowedRoots } from "../src/server/core/config";

describe("Windows 경로 허용 판정 (#142)", () => {
  it("드라이브 루트는 구분자를 덧붙이지 않고 대소문자 없이 비교한다", () => {
    const win = path.win32;
    expect(isInsideRoot("C:\\Users\\me\\proj", "C:\\", win)).toBe(true);
    expect(isInsideRoot("c:\\users\\me", "C:\\", win)).toBe(true);
    expect(isInsideRoot("D:\\work", "C:\\", win)).toBe(false);
    expect(isInsideRoot("C:\\proj\\src", "C:\\proj", win)).toBe(true);
    expect(isInsideRoot("C:\\project2", "C:\\proj", win)).toBe(false);
  });

  it("Linux 루트와 일반 폴더 판정은 기존과 같다", () => {
    expect(isInsideRoot("/home/me/proj", "/")).toBe(true);
    expect(isInsideRoot("/srv/app", "/srv/app")).toBe(true);
    expect(isInsideRoot("/srv/app2", "/srv/app")).toBe(false);
  });

  it("Windows 기본 허용 루트는 존재하는 모든 드라이브다", () => {
    expect(parseAllowedRoots(undefined, "win32", (root) => root === "C:\\" || root === "D:\\")).toEqual(["C:\\", "D:\\"]);
    expect(parseAllowedRoots(undefined, "linux")).toEqual([path.resolve("/")]);
    expect(parseAllowedRoots("/srv/a, /srv/b", "linux")).toEqual(["/srv/a", "/srv/b"]);
  });
});
