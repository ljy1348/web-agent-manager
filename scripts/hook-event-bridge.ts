import process from "node:process";

// Claude·Codex 관찰용 command 훅이 받은 JSON을 로컬 WAM 서버로 전달한다. 사용: hook-event-bridge <URL>
// 관찰 전용이라 결정 출력을 내지 않는다 — SessionStart 훅의 stdout은 모델 문맥에 추가되므로 아무것도
// 쓰지 않고, 어떤 실패도 CLI 작업을 막지 않게 항상 0으로 끝낸다.
async function readInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

// 채팅 ID가 있는 WAM 채팅 세션일 때만 훅 입력을 서버에 보낸다.
async function main(): Promise<void> {
  const url = process.argv[2];
  const token = process.env.WEB_AGENT_MANAGER_HOOK_TOKEN ?? process.env.MYAGENT_HOOK_TOKEN;
  const chatId = process.env.WEB_AGENT_MANAGER_CHAT_ID;
  // 사용량 조회 PTY나 사용자가 직접 띄운 세션처럼 WAM 채팅이 아니면 보낼 대상이 없다.
  if (!url || !token || !chatId) return;
  await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-WAM-Chat-Id": chatId },
    body: await readInput(),
    signal: AbortSignal.timeout(3_000),
  });
}

main().catch(() => undefined).finally(() => { process.exitCode = 0; });
