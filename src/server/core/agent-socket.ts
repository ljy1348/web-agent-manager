import crypto from "node:crypto";
import path from "node:path";

// 에이전트 브리지 소켓 주소. Linux·macOS는 데이터 폴더의 Unix 소켓, Windows는 파일 경로에 Unix 소켓을 만들 수
// 없어 데이터 폴더마다 고유한 이름 있는 파이프를 쓴다(#142). 서버·MCP 연동 설정·에이전트 스크립트가 함께 쓴다.
export function agentSocketPath(dataDir: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return path.join(dataDir, "web-agent-manager-agent.sock");
  const key = crypto.createHash("sha256").update(path.win32.resolve(dataDir).toLowerCase()).digest("hex").slice(0, 16);
  return `\\\\.\\pipe\\web-agent-manager-agent-${key}`;
}

export function isNamedPipe(socketPath: string): boolean {
  return socketPath.startsWith("\\\\.\\pipe\\") || socketPath.startsWith("\\\\?\\pipe\\");
}
