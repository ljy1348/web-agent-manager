import { describe, expect, it } from "vitest";
import { parseAllowedHosts, VITE_POLLING_INTERVAL_MS } from "../vite.config";

describe("Vite 추가 허용 호스트", () => {
  it("쉼표 목록의 공백과 중복을 제거한다", () => {
    expect(parseAllowedHosts("dev.example.com, .example.net,dev.example.com"))
      .toEqual(["dev.example.com", ".example.net"]);
  });

  it("설정이 없으면 호스트를 추가하지 않는다", () => {
    expect(parseAllowedHosts(undefined)).toEqual([]);
  });

  it("Docker 개발 HMR 폴링을 1초 간격으로 제한한다", () => {
    expect(VITE_POLLING_INTERVAL_MS).toBe(1_000);
  });
});
