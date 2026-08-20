import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { codexAppServerClientVersion, consumeCodexResetCredit, isCodexResetCreditsScreenReady, parseCodexResetCreditConsumeOutcome, parseCodexResetCredits, parseCodexResetCreditsScreen, selectCodexResetCredit } from "../src/server/providers/codex-rate-limits";

describe("Codex app-server 초기화", () => {
  it("clientInfo 버전이 현재 package 버전과 일치한다", () => {
    const packageVersion = (JSON.parse(fs.readFileSync("package.json", "utf8")) as { version: string }).version;
    expect(codexAppServerClientVersion()).toBe(packageVersion);
  });
});

describe("Codex 초기화권 응답 파싱", () => {
  it("잔여 개수와 사용 가능한 초기화권 중 가장 이른 기한을 반환한다", () => {
    const parsed = parseCodexResetCredits({
      id: 1,
      result: {
        rateLimitResetCredits: {
          availableCount: 3,
          credits: [
            { status: "available", expiresAt: 1786555698 },
            { status: "redeemed", expiresAt: 1786000000 },
            { status: "available", expiresAt: 1786469298 },
          ],
        },
      },
    });

    expect(parsed).toEqual({ availableCount: 3, expiresAt: "2026-08-11T17:28:18.000Z" });
  });

  it("상세 목록 없이 개수만 온 응답도 표시할 수 있게 보존한다", () => {
    expect(parseCodexResetCredits({ result: { rateLimitResetCredits: { availableCount: 1, credits: null } } }))
      .toEqual({ availableCount: 1, expiresAt: null });
  });

  it("초기화권 필드가 없거나 개수가 잘못된 응답은 무시한다", () => {
    expect(parseCodexResetCredits({ result: {} })).toBeNull();
    expect(parseCodexResetCredits({ result: { rateLimitResetCredits: { availableCount: -1 } } })).toBeNull();
  });
});

describe("Codex 초기화권 TUI 파싱", () => {
  it("Full reset 상세의 로컬 기한을 ISO 시각으로 변환한다", () => {
    const parsed = parseCodexResetCreditsScreen(`Usage limit resets
1 usage limit reset available.
1. Full reset  Expires 02:28 on 13 Aug 2026.`);

    expect(parsed?.availableCount).toBe(1);
    const expiresAt = new Date(parsed!.expiresAt!);
    expect([expiresAt.getFullYear(), expiresAt.getMonth(), expiresAt.getDate(), expiresAt.getHours(), expiresAt.getMinutes()])
      .toEqual([2026, 7, 13, 2, 28]);
  });

  it("기한 행이 아직 없으면 개수만 보존한다", () => {
    expect(parseCodexResetCreditsScreen("2 usage limit resets available."))
      .toEqual({ availableCount: 2, expiresAt: null });
  });

  it("로딩 중·기한 미표시 화면은 기다리고 Full reset 기한이 그려지면 완료로 본다", () => {
    expect(isCodexResetCreditsScreenReady("Usage limit resets\nChecking your available resets...\nLoading..."))
      .toBe(false);
    expect(isCodexResetCreditsScreenReady("1 usage limit reset available."))
      .toBe(false);
    expect(isCodexResetCreditsScreenReady("1 usage limit reset available.\n1. Full reset Expires 02:28 on 13 Aug 2026."))
      .toBe(true);
    expect(isCodexResetCreditsScreenReady("0 usage limit resets available."))
      .toBe(true);
  });
});

describe("Codex 초기화권 사용", () => {
  it("응답 목록에서 맨 위의 available 초기화권 ID를 선택한다", () => {
    const selected = selectCodexResetCredit({ result: { rateLimitResetCredits: {
      availableCount: 2,
      credits: [
        { id: "redeemed", status: "redeemed", expiresAt: 1 },
        { id: "first", status: "available", expiresAt: 3 },
        { id: "second", status: "available", expiresAt: 2 },
      ],
    } } });

    expect(selected).toEqual({
      credits: { availableCount: 2, expiresAt: "1970-01-01T00:00:02.000Z" },
      creditId: "first",
    });
  });

  it("상세 목록이 없으면 backend의 다음 사용 가능 권리 선택을 사용한다", () => {
    expect(selectCodexResetCredit({ result: { rateLimitResetCredits: { availableCount: 1, credits: null } } }))
      .toEqual({ credits: { availableCount: 1, expiresAt: null }, creditId: null });
  });

  it("허용된 사용 결과만 파싱한다", () => {
    expect(parseCodexResetCreditConsumeOutcome({ result: { outcome: "reset" } })).toBe("reset");
    expect(parseCodexResetCreditConsumeOutcome({ result: { outcome: "unknown" } })).toBeNull();
  });

  it("맨 위 ID와 멱등성 키로 사용한 뒤 잔여량을 다시 읽는다", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const responses = [
      { result: { rateLimitResetCredits: { availableCount: 2, credits: [{ id: "first", status: "available", expiresAt: 100 }, { id: "second", status: "available", expiresAt: 200 }] } } },
      { result: { outcome: "reset" } },
      { result: { rateLimitResetCredits: { availableCount: 1, credits: [{ id: "second", status: "available", expiresAt: 200 }] } } },
    ];
    const result = await consumeCodexResetCredit({}, async (method, params) => {
      calls.push({ method, params });
      return responses.shift() ?? null;
    });

    expect(calls.map((call) => call.method)).toEqual([
      "account/rateLimits/read",
      "account/rateLimitResetCredit/consume",
      "account/rateLimits/read",
    ]);
    expect(calls[1].params.creditId).toBe("first");
    expect(calls[1].params.idempotencyKey).toEqual(expect.any(String));
    expect(result).toEqual({
      outcome: "reset",
      before: { availableCount: 2, expiresAt: "1970-01-01T00:01:40.000Z" },
      after: { availableCount: 1, expiresAt: "1970-01-01T00:03:20.000Z" },
    });
  });

  it("사용 응답이 유실돼도 잔여량 감소로 성공을 복구한다", async () => {
    const responses = [
      { result: { rateLimitResetCredits: { availableCount: 1, credits: null } } },
      null,
      { result: { rateLimitResetCredits: { availableCount: 0, credits: [] } } },
    ];
    const result = await consumeCodexResetCredit({}, async () => responses.shift() ?? null);

    expect(result.outcome).toBe("reset");
    expect(result.after?.availableCount).toBe(0);
  });
});
