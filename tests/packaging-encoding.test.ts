import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Windows 기본 PowerShell 5.1은 BOM 없는 UTF-8 스크립트를 시스템 코드 페이지로 읽어 한글이 깨진다(#147).
describe("Windows 설치 스크립트 인코딩", () => {
  it("packaging의 모든 .ps1은 UTF-8 BOM으로 시작한다", () => {
    const dir = path.resolve("packaging");
    const scripts = fs.readdirSync(dir).filter((name) => name.endsWith(".ps1"));
    expect(scripts.length).toBeGreaterThan(0);
    for (const name of scripts) expect([...fs.readFileSync(path.join(dir, name)).subarray(0, 3)], name).toEqual([0xef, 0xbb, 0xbf]);
  });

  // 더블클릭 실행 시 결과를 볼 수 있어야 한다(#153): CRLF, 첫 명령에서 UTF-8 전환, 스크립트 존재 확인, 무조건 pause.
  it("Windows 네이티브 .cmd는 항상 결과를 보여주고 멈춘다", () => {
    for (const name of ["setup-windows-native.cmd", "run-windows-native.cmd", "build-desktop-windows.cmd"]) {
      const text = fs.readFileSync(path.resolve("packaging", name), "utf8");
      expect(text.includes("\n") && !/[^\r]\n/.test(text), `${name} CRLF`).toBe(true);
      const lines = text.split("\r\n");
      expect(lines.slice(0, 2)).toEqual(["@echo off", "chcp 65001 >nul"]);
      expect(text).toContain("if not exist \"%SCRIPT%\"");
      expect(lines.filter((line) => line.trim() === "pause").length, name).toBeGreaterThanOrEqual(1);
      expect(text).not.toContain("if errorlevel 1 pause");
    }
  });
});
