import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, setSecurityBlockHandler } from "../src/client/api";

// 상태 코드·본문·헤더를 지정한 가짜 JSON 응답을 만든다.
function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

const reauthBlocked = () => jsonResponse(403, { error: "중요 작업 전에 설정에서 본인 확인을 다시 해주세요.", reauthRequired: true });

describe("api() 403 차단 원인 처리", () => {
  afterEach(() => {
    setSecurityBlockHandler(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("재인증 필요 응답은 안내창에서 확인되면 원래 요청을 1회 재시도한다", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(reauthBlocked()).mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const handler = vi.fn().mockResolvedValue(true);
    setSecurityBlockHandler(handler);

    await expect(api("/projects/1/git/discard", { method: "POST", body: "{}" })).resolves.toEqual({ ok: true });
    expect(handler).toHaveBeenCalledWith("reauth", "중요 작업 전에 설정에서 본인 확인을 다시 해주세요.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("안내창을 취소하면 재시도 없이 원래 오류를 던진다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reauthBlocked());
    vi.stubGlobal("fetch", fetchMock);
    setSecurityBlockHandler(vi.fn().mockResolvedValue(false));

    await expect(api("/x", { method: "DELETE" })).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("재시도도 재인증에 막히면 다시 묻지 않고 오류를 던진다", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => reauthBlocked());
    vi.stubGlobal("fetch", fetchMock);
    const handler = vi.fn().mockResolvedValue(true);
    setSecurityBlockHandler(handler);

    await expect(api("/x", { method: "DELETE" })).rejects.toBeInstanceOf(ApiError);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("동시에 여러 요청이 막혀도 안내창은 한 번만 띄운다", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => (++calls <= 2 ? reauthBlocked() : jsonResponse(200, { ok: true }))));
    let confirm: (value: boolean) => void = () => undefined;
    const handler = vi.fn().mockImplementation(() => new Promise<boolean>((resolve) => { confirm = resolve; }));
    setSecurityBlockHandler(handler);

    const both = Promise.all([api("/a", { method: "DELETE" }), api("/b", { method: "DELETE" })]);
    await vi.waitFor(() => expect(handler).toHaveBeenCalled());
    await vi.waitFor(() => expect(calls).toBe(2));
    confirm(true);
    await expect(both).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("외부망 차단은 원인 안내창을 띄우고 오류를 그대로 던진다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(403, { error: "되돌릴 수 없는 작업은 내부망에서만 할 수 있습니다.", networkRestricted: true })));
    const handler = vi.fn().mockResolvedValue(false);
    setSecurityBlockHandler(handler);

    await expect(api("/system/processes/1/kill", { method: "POST" })).rejects.toMatchObject({ status: 403 });
    expect(handler).toHaveBeenCalledWith("network", "되돌릴 수 없는 작업은 내부망에서만 할 수 있습니다.");
  });

  it("원격 WAM이 중계한 차단 응답과 원인 표시 없는 403은 안내창을 띄우지 않는다", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse(403, { error: "원격", reauthRequired: true }, { "x-wam-federation-upstream": "1" }))
      .mockResolvedValueOnce(jsonResponse(403, { error: "비밀번호 또는 인증 코드가 올바르지 않습니다." })));
    const handler = vi.fn().mockResolvedValue(true);
    setSecurityBlockHandler(handler);

    await expect(api("/federation/nodes/n1/api/x", { method: "DELETE" })).rejects.toMatchObject({ status: 403 });
    await expect(api("/auth/reauth", { method: "POST" })).rejects.toMatchObject({ status: 403 });
    expect(handler).not.toHaveBeenCalled();
  });
});
