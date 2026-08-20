import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCodexExecArgs, normalizeCodexExecEvent } from "../src/server/experiments/codex-exec-runtime";
import type { RuntimeRunInput } from "../src/server/experiments/agent-runtime";
import { JsonlProcessExitError, JsonlProcessRunner } from "../src/server/experiments/jsonl-process";
import { parseExperimentVariantConfig } from "../src/shared/experiments";

// Codex argv 테스트에 필요한 완전한 실행 입력을 만든다.
function runInput(): RuntimeRunInput {
  return {
    runId: "run-1",
    workingDirectory: "/tmp/project",
    prompt: "기능을 구현해",
    config: parseExperimentVariantConfig({
      schemaVersion: 1,
      runtime: { provider: "codex", model: "gpt-test", reasoningEffort: "high", sandbox: "workspace-write", maxTurns: 7 },
      skills: { mode: "selected", enabled: ["review"], disabled: [] },
      harness: { type: "single", maxIterations: 1, maxNoImprovement: 1 },
      budget: { maxSeconds: 600, maxTokens: 10_000 },
    }),
    snapshot: {
      provider: "codex", cliVersion: "codex-cli test", resolvedModel: "gpt-test",
      toolProfile: { transport: "exec-jsonl", outputSchemaPath: null }, permissionProfile: { sandbox: "workspace-write" },
      skillManifest: [
        { id: "review", path: "/skills/review/SKILL.md", sha256: "a".repeat(64) },
        { id: "other", path: "/skills/other/SKILL.md", sha256: "b".repeat(64) },
      ],
      preparedAt: "2026-08-13T00:00:00.000Z",
    },
  };
}

describe("Codex exec 런타임", () => {
  it("새 실행과 resume의 모델·sandbox·reasoning·스킬 argv를 구분한다", () => {
    const fresh = buildCodexExecArgs(runInput());
    expect(fresh.slice(0, 6)).toEqual(["exec", "--strict-config", "--json", "--color", "never", "--model"]);
    expect(fresh).toContain("--sandbox");
    expect(fresh).toContain("--cd");
    expect(fresh.join(" ")).toContain('model_reasoning_effort="high"');
    expect(fresh.join(" ")).toContain('path = "/skills/review", enabled = true');
    expect(fresh.join(" ")).toContain('path = "/skills/other", enabled = false');
    expect(fresh).toContain("--color");
    expect(fresh).not.toContain("기능을 구현해");
    expect(fresh.at(-1)).toBe("-");

    const resumed = buildCodexExecArgs(runInput(), "thread-1");
    expect(resumed.slice(0, 4)).toEqual(["exec", "--strict-config", "resume", "thread-1"]);
    expect(resumed).not.toContain("--sandbox");
    expect(resumed).not.toContain("--color");
    expect(resumed.join(" ")).toContain('sandbox_mode="workspace-write"');
    expect(resumed.at(-1)).toBe("-");
  });

  it("clean baseline에서 사용자 config를 제외하고 pinned 스킬 디렉터리만 활성화한다", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-codex-overlay-"));
    const additionDirectory = path.join(root, "skills", "01-review");
    const input = runInput();
    input.config.skills = {
      mode: "none", enabled: [], disabled: [], profile: "isolated_overlay", baseline: "clean",
      additions: ["lab:review"], comparisonId: "codex-default", activation: "native",
    };
    input.snapshot.skillOverlay = {
      profile: "isolated_overlay", baseline: "clean", comparisonId: "codex-default",
      activation: "native",
      bundleRoot: root, pluginManifest: path.join(root, ".claude-plugin", "plugin.json"),
      baselineSkills: [],
      additions: [{ id: "lab:review", name: "review", source: "project_lab", directory: additionDirectory }],
      files: [], digest: "a".repeat(64),
    };

    const args = buildCodexExecArgs(input);

    expect(args).not.toContain("--ignore-user-config");
    expect(args).toContain("--strict-config");
    expect(args).not.toContain("--add-dir");
    expect(args.join(" ")).toContain('path = "/skills/review", enabled = false');
    expect(args.join(" ")).toContain(`path = "${additionDirectory}", enabled = true`);
    expect(() => buildCodexExecArgs(input, "thread-old")).toThrow("resume");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("thread·메시지·도구·usage·완료 이벤트를 공통 계약으로 바꾼다", () => {
    const at = "2026-08-13T00:00:00.000Z";
    expect(normalizeCodexExecEvent({ type: "thread.started", thread_id: "thread-1" }, at))
      .toEqual([{ type: "started", providerRunId: "thread-1", occurredAt: at }]);
    expect(normalizeCodexExecEvent({ type: "item.completed", item: { type: "agent_message", text: "완료" } }, at))
      .toEqual([{ type: "message", role: "assistant", text: "완료", occurredAt: at }]);
    expect(normalizeCodexExecEvent({ type: "item.started", item: { type: "command_execution", command: "npm test" } }, at)[0])
      .toMatchObject({ type: "tool_started", name: "npm test" });
    expect(normalizeCodexExecEvent({ type: "item.completed", item: { type: "file_change", changes: [{ path: "a.ts" }] } }, at)[0])
      .toMatchObject({ type: "tool_finished", name: "file_change" });
    expect(normalizeCodexExecEvent({
      type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 30, cache_write_input_tokens: 4, output_tokens: 20 },
    }, at)).toEqual([
      { type: "usage", usage: {
        inputTokens: 100, cachedInputTokens: 30, cacheCreationInputTokens: 4, cacheReadInputTokens: null,
        outputTokens: 20, reasoningOutputTokens: null, totalTokens: 120, totalTokensSource: "derived", costUsd: null,
      }, occurredAt: at },
      { type: "completed", result: {
        type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 30, cache_write_input_tokens: 4, output_tokens: 20 },
      }, occurredAt: at },
    ]);
  });

  it("미보고 usage와 알 수 없는 이벤트를 0으로 만들거나 실패로 오판하지 않는다", () => {
    expect(normalizeCodexExecEvent({ type: "turn.completed" })[0]).toMatchObject({ type: "completed" });
    expect(normalizeCodexExecEvent({ type: "future.event", payload: 1 })).toEqual([]);
  });
});

describe("JSONL 자식 프로세스", () => {
  it("shell 없이 argv를 그대로 전달하고 JSONL 순서를 보존한다", async () => {
    const runner = new JsonlProcessRunner();
    const suspicious = "`touch /tmp/절대-실행되면-안됨` $(false)";
    const records: Record<string, unknown>[] = [];
    for await (const record of runner.run({
      runId: "json-lines",
      command: process.execPath,
      args: ["-e", "console.log(JSON.stringify({type:'first',arg:process.argv[1]}));console.log(JSON.stringify({type:'second'}))", suspicious],
      cwd: process.cwd(),
    }, new AbortController().signal)) records.push(record);
    expect(records).toEqual([{ type: "first", arg: suspicious }, { type: "second" }]);
  });

  it("프롬프트 stdin을 변형 없이 자식 프로세스에 전달한다", async () => {
    const runner = new JsonlProcessRunner();
    const prompt = "여러 줄 프롬프트\n$(실행되면 안 됨)";
    const records: Record<string, unknown>[] = [];
    for await (const record of runner.run({
      runId: "stdin-prompt",
      command: process.execPath,
      args: ["-e", "let value='';process.stdin.on('data',c=>value+=c);process.stdin.on('end',()=>console.log(JSON.stringify({value})))"],
      cwd: process.cwd(),
      stdin: prompt,
    }, new AbortController().signal)) records.push(record);
    expect(records).toEqual([{ value: prompt }]);
  });

  it("실험 제한 환경에서는 서버 프로세스의 나머지 환경변수를 상속하지 않는다", async () => {
    const runner = new JsonlProcessRunner();
    const records: Record<string, unknown>[] = [];
    for await (const record of runner.run({
      runId: "restricted-env", command: process.execPath,
      args: ["-e", "console.log(JSON.stringify({allowed:process.env.WAM_ALLOWED,hidden:process.env.PATH??null}))"],
      cwd: process.cwd(), env: { WAM_ALLOWED: "yes" }, inheritProcessEnv: false,
    }, new AbortController().signal)) records.push(record);
    expect(records).toEqual([{ allowed: "yes", hidden: null }]);
  });

  it("비정상 stdout을 제한된 진단 오류로 반환한다", async () => {
    const runner = new JsonlProcessRunner();
    const consume = async () => {
      for await (const _record of runner.run({
        runId: "invalid-json", command: process.execPath, args: ["-e", "console.log('not-json')"], cwd: process.cwd(),
      }, new AbortController().signal)) { /* 레코드가 없어야 한다. */ }
    };
    await expect(consume()).rejects.toBeInstanceOf(JsonlProcessExitError);
  });

  it("명시적 cancel이 장수 프로세스를 종료하고 cancelled 원인을 보존한다", async () => {
    const runner = new JsonlProcessRunner();
    const iterator = runner.run({
      runId: "cancel-me", command: process.execPath,
      args: ["-e", "console.log(JSON.stringify({type:'started'}));setInterval(()=>{},1000)"],
      cwd: process.cwd(), abortGraceMs: 50,
    }, new AbortController().signal)[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: { type: "started" } });
    expect(runner.cancel("cancel-me", 50)).toBe(true);
    await expect(iterator.next()).rejects.toEqual(expect.objectContaining({ name: "JsonlProcessExitError", cancelled: true }));
  });

  it("SIGTERM 처리기가 종료 코드 0을 반환해도 취소 성공으로 오판하지 않는다", async () => {
    const runner = new JsonlProcessRunner();
    const iterator = runner.run({
      runId: "cancel-zero", command: process.execPath,
      args: ["-e", "process.on('SIGTERM',()=>process.exit(0));console.log(JSON.stringify({type:'started'}));setInterval(()=>{},1000)"],
      cwd: process.cwd(), abortGraceMs: 100,
    }, new AbortController().signal)[Symbol.asyncIterator]();
    await iterator.next();
    expect(runner.cancel("cancel-zero", 100)).toBe(true);
    await expect(iterator.next()).rejects.toEqual(expect.objectContaining({ name: "JsonlProcessExitError", cancelled: true, exitCode: 0 }));
  });

  it.skipIf(process.platform === "win32")("취소 신호를 CLI가 띄운 손자 프로세스까지 전달한다", async () => {
    const runner = new JsonlProcessRunner();
    const marker = path.join(os.tmpdir(), `wam-process-group-${crypto.randomUUID()}`);
    const ready = `${marker}.ready`;
    const grandchild = `const fs=require('node:fs');process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(marker)},'term');process.exit(0)});fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`;
    const parent = `const fs=require('node:fs');const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)})){clearInterval(timer);console.log(JSON.stringify({type:'started',pid:child.pid}))}},5);setInterval(()=>{},1000)`;
    const iterator = runner.run({
      runId: "cancel-group", command: process.execPath, args: ["-e", parent], cwd: process.cwd(), abortGraceMs: 200,
    }, new AbortController().signal)[Symbol.asyncIterator]();
    await iterator.next();
    expect(runner.cancel("cancel-group", 200)).toBe(true);
    await expect(iterator.next()).rejects.toEqual(expect.objectContaining({ cancelled: true }));
    for (let attempt = 0; attempt < 20 && !fs.existsSync(marker); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(fs.readFileSync(marker, "utf8")).toBe("term");
    fs.rmSync(marker, { force: true });
    fs.rmSync(ready, { force: true });
  });
});
