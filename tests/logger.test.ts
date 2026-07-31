import { describe, expect, it } from "vitest";
import { defaultLogLevel } from "../src/server/core/logger";

describe("로그 기본 레벨", () => {
  it("production은 info이고 개발·테스트는 debug다", () => {
    expect(defaultLogLevel("production")).toBe("info");
    expect(defaultLogLevel("development")).toBe("debug");
    expect(defaultLogLevel("test")).toBe("debug");
  });
});
