import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

function source(relative: string): string {
  return fs.readFileSync(path.resolve(relative), "utf8");
}

// MainActivity가 주입하는 복귀 스크립트를 소스에서 그대로 꺼내 실행한다.
function androidResumeScript(): string {
  const java = source("android/app/src/main/java/com/webagentmanager/android/MainActivity.java");
  const match = java.match(/FOREGROUND_RESUME_SCRIPT\s*=\s*"((?:\\.|[^"\\])*)"/);
  if (!match) throw new Error("FOREGROUND_RESUME_SCRIPT 상수가 없습니다.");
  return JSON.parse(`"${match[1]}"`);
}

type ResumeSocket = { readyState: number; close: () => void };
type ForegroundResume = {
  resume: () => void;
  handleVisibility: () => void;
  dispose: () => void;
};

// main.tsx의 createForegroundResume를 타입 제거 후 같은 구현으로 로드한다.
function loadCreateForegroundResume(globals: { window: object; document: { visibilityState: string } }) {
  const text = source("src/client/main.tsx");
  const start = text.indexOf("function createForegroundResume(");
  const end = text.indexOf("// end createForegroundResume");
  if (start < 0 || end < 0) throw new Error("createForegroundResume 함수를 찾지 못했습니다.");
  const js = stripTypeScriptTypes(text.slice(start, end));
  const sandbox = {
    window: globals.window,
    document: globals.document,
    Date,
    WebSocket: { CONNECTING: 0 },
    createForegroundResume: undefined as undefined | ((options: {
      refresh: () => void;
      getSocket: () => ResumeSocket | null;
      connect: () => void;
      markIntentionalClose: () => void;
      clearReconnectTimer: () => void;
    }) => ForegroundResume),
  };
  vm.runInNewContext(`${js}\nthis.createForegroundResume = createForegroundResume;`, sandbox);
  if (!sandbox.createForegroundResume) throw new Error("createForegroundResume를 실행하지 못했습니다.");
  return sandbox.createForegroundResume;
}

describe("Android 복귀 스크립트", () => {
  it("훅이 없으면 예외 없이 넘어간다", () => {
    expect(() => vm.runInNewContext(androidResumeScript(), { window: {} })).not.toThrow();
  });

  it("훅이 함수가 아니어도 예외 없이 넘어간다", () => {
    expect(() => vm.runInNewContext(androidResumeScript(), { window: { __webAgentManagerResume__: 1 } })).not.toThrow();
  });

  it("훅이 있으면 호출한다", () => {
    const resume = vi.fn();
    vm.runInNewContext(androidResumeScript(), { window: { __webAgentManagerResume__: resume } });
    expect(resume).toHaveBeenCalledTimes(1);
  });
});

describe("웹 복귀 훅", () => {
  function boot(visibilityState: "visible" | "hidden" = "visible") {
    const windowObj: { __webAgentManagerResume__?: () => void } = {};
    const documentObj = { visibilityState };
    const createForegroundResume = loadCreateForegroundResume({ window: windowObj, document: documentObj });
    const refresh = vi.fn();
    const connect = vi.fn();
    const markIntentionalClose = vi.fn();
    const clearReconnectTimer = vi.fn();
    let socket: ResumeSocket | null = { readyState: 1, close: vi.fn() };
    const ctl = createForegroundResume({
      refresh,
      getSocket: () => socket,
      connect: () => {
        connect();
        socket = { readyState: 0, close: vi.fn() };
      },
      markIntentionalClose,
      clearReconnectTimer,
    });
    return { windowObj, documentObj, refresh, connect, markIntentionalClose, clearReconnectTimer, getSocket: () => socket, setSocket: (next: ResumeSocket | null) => { socket = next; }, ctl };
  }

  it("훅 호출 시 재조회와 소켓 재연결을 한다", () => {
    const ctx = boot();
    ctx.windowObj.__webAgentManagerResume__?.();
    expect(ctx.refresh).toHaveBeenCalledTimes(1);
    expect(ctx.markIntentionalClose).toHaveBeenCalledTimes(1);
    expect(ctx.connect).toHaveBeenCalledTimes(1);
    expect(ctx.clearReconnectTimer).toHaveBeenCalledTimes(1);
  });

  it("visibilitychange와 훅이 연달아 와도 소켓은 한 번만 교체한다", () => {
    const ctx = boot("visible");
    ctx.ctl.handleVisibility();
    ctx.windowObj.__webAgentManagerResume__?.();
    expect(ctx.refresh).toHaveBeenCalledTimes(2);
    expect(ctx.connect).toHaveBeenCalledTimes(1);
    expect(ctx.markIntentionalClose).toHaveBeenCalledTimes(1);
  });

  it("숨김 상태의 visibilitychange는 재조회하지 않지만 훅은 숨김이어도 재조회한다", () => {
    const hidden = boot("hidden");
    hidden.ctl.handleVisibility();
    expect(hidden.refresh).not.toHaveBeenCalled();
    hidden.windowObj.__webAgentManagerResume__?.();
    expect(hidden.refresh).toHaveBeenCalledTimes(1);
  });

  it("연결 중인 소켓은 닫지 않고 교체를 건너뛴다", () => {
    const ctx = boot();
    ctx.setSocket({ readyState: 0, close: vi.fn() });
    ctx.ctl.resume();
    expect(ctx.connect).not.toHaveBeenCalled();
    expect(ctx.markIntentionalClose).not.toHaveBeenCalled();
    expect(ctx.refresh).toHaveBeenCalledTimes(1);
  });

  it("정리하면 훅이 사라져 Android 스크립트가 안전하다", () => {
    const ctx = boot();
    ctx.ctl.dispose();
    expect(ctx.windowObj.__webAgentManagerResume__).toBeUndefined();
    expect(() => vm.runInNewContext(androidResumeScript(), { window: ctx.windowObj })).not.toThrow();
  });
});

describe("복귀 경로 배선", () => {
  it("웹 클라이언트가 훅과 visibilitychange를 같은 함수에 연결한다", () => {
    const text = source("src/client/main.tsx");
    expect(text).toContain("window.__webAgentManagerResume__ = resume");
    expect(text).toContain("createForegroundResume");
    expect(text).toContain("foregroundResume.handleVisibility");
    expect(text).toContain("foregroundResume.dispose");
    expect(text).not.toMatch(/function handleVisibility\(\): void \{\n      if \(document\.visibilityState !== "visible"\) return;\n      void loadCore\(\)/);
  });

  it("MainActivity가 WebView 생명주기와 복귀 훅을 전달한다", () => {
    const java = source("android/app/src/main/java/com/webagentmanager/android/MainActivity.java");
    expect(java).toContain("webView.onPause()");
    expect(java).toContain("webView.pauseTimers()");
    expect(java).toContain("webView.onResume()");
    expect(java).toContain("webView.resumeTimers()");
    expect(java).toContain("evaluateJavascript(FOREGROUND_RESUME_SCRIPT");
    expect(java).toContain("if (webView == null) return");
    expect(java).toContain("webView = null");
    expect(java).toContain("__webAgentManagerResume__");
  });
});
