import { execFile } from "node:child_process";

// 검증 명령은 fixture가 선언한 argv만 실행한다. Variant나 프롬프트가 명령을 바꿀 수 없다.
const MAX_OUTPUT_CHARS = 8_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export type DeterministicCheckStatus = "passed" | "failed" | "skipped" | "error";

export interface DeterministicCheckResult {
  status: DeterministicCheckStatus;
  exitCode: number | null;
  durationMs: number;
  output: string;
}

// 테스트 출력은 실패 원인이 끝에 몰리므로 뒤쪽을 남긴다.
function tail(value: string): string {
  if (value.length <= MAX_OUTPUT_CHARS) return value;
  return `[앞부분 ${value.length - MAX_OUTPUT_CHARS}자 생략]\n${value.slice(-MAX_OUTPUT_CHARS)}`;
}

// fixture가 선언한 검증 명령을 shell 없이 실행해 완성도의 1차 지표를 만든다. 명령이 없으면 skipped다.
export function runDeterministicCheck(
  command: string[],
  workingDirectory: string,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<DeterministicCheckResult> {
  if (!command.length) {
    return Promise.resolve({ status: "skipped", exitCode: null, durationMs: 0, output: "" });
  }
  const [executable, ...args] = command;
  const startedAt = Date.now();
  return new Promise((resolve) => {
    execFile(executable, args, {
      cwd: workingDirectory,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      env: options.env,
      shell: false,
    }, (error, stdout, stderr) => {
      const durationMs = Date.now() - startedAt;
      const output = tail([stdout, stderr].filter(Boolean).join("\n").trim());
      if (!error) {
        resolve({ status: "passed", exitCode: 0, durationMs, output });
        return;
      }
      const detail = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
      // 명령 자체를 실행하지 못했거나 시간 초과로 죽은 것은 "테스트 실패"와 구분해야 한다.
      // 전자는 fixture 환경 문제이고 후자만 에이전트 산출물의 문제일 수 있기 때문이다.
      if (typeof detail.code === "string" || detail.killed) {
        resolve({
          status: "error", exitCode: null, durationMs,
          output: tail(`${output}\n[검증 명령 실행 실패: ${detail.killed ? "시간 초과" : detail.code}]`.trim()),
        });
        return;
      }
      resolve({ status: "failed", exitCode: typeof detail.code === "number" ? detail.code : null, durationMs, output });
    });
  });
}
