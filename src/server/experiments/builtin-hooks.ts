import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ExperimentHookBus } from "./hook-bus";
import { collectGitChangeSnapshot } from "./git-change-snapshot";

const execFileAsync = promisify(execFile);
export const BUILTIN_EXPERIMENT_HOOKS = ["diff_stats", "git_diff_check"] as const;

// 허용된 내장 ID만 실행별 HookBus에 등록한다.
export function createBuiltinExperimentHookBus(ids: string[], workingDirectory: string): ExperimentHookBus {
  const bus = new ExperimentHookBus();
  for (const id of ids) {
    if (!BUILTIN_EXPERIMENT_HOOKS.includes(id as typeof BUILTIN_EXPERIMENT_HOOKS[number])) throw new Error(`등록되지 않은 실험 훅입니다: ${id}`);
    if (id === "diff_stats") {
      bus.register({
        id, event: "after_node", mode: "transform", timeoutMs: 10_000,
        // 현재 tracked·untracked diff의 크기를 hook 이벤트 payload에 추가한다.
        handler: async (context) => {
          const snapshot = await collectGitChangeSnapshot(workingDirectory, false);
          return { payload: { ...context.payload, diffStats: snapshot.stats } };
        },
      });
    } else {
      bus.register({
        id, event: "after_node", mode: "validate", timeoutMs: 10_000,
        // Git diff 검사 실패를 구조화된 validate 거부로 바꾼다.
        handler: async () => {
          try {
            await execFileAsync("git", ["diff", "--check", "--", "."], { cwd: workingDirectory, timeout: 8_000, maxBuffer: 1024 * 1024 });
            return { valid: true };
          } catch (error) {
            const detail = error as { stdout?: string; stderr?: string };
            return { valid: false, reason: (detail.stdout || detail.stderr || "git diff --check 실패").trim() };
          }
        },
      });
    }
  }
  return bus;
}
