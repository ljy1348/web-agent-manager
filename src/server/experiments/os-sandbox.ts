import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Linux OS 샌드박스(bwrap/Codex landlock)는 유저 네임스페이스가 필요하다.
// PATH에 bwrap이 있어도 namespace 생성이 막히면 읽기까지 실패하므로 존재 여부만 보지 않는다.
export async function detectOsSandboxSupport(): Promise<boolean> {
  if (process.platform !== "linux") return true;
  try {
    await execFileAsync("unshare", ["--user", "--", "/bin/true"], { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}
