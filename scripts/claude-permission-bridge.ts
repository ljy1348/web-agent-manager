import process from "node:process";

// Claude·Codex PermissionRequest 훅 브리지. 인자 없이 실행하면 Claude 모드(환경변수 URL, 실패 시 거부),
// URL 인자를 주면 Codex 모드(#95)다 — Codex는 훅이 결정을 내지 않으면 기본 승인 화면으로 넘어가므로,
// 서버가 없거나 오류면 거부하지 않고 아무것도 출력하지 않아 기존 화면 감지 경로가 이어받게 한다.
const codexUrl = process.argv[2];

// 표준 입력 전체를 훅 JSON 문자열로 읽는다.
async function readInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

// 권한 요청을 로컬 웹 서버에 전달하고 결정을 stdout으로 반환한다. tmux가 넘겨준 채팅 ID를
// 함께 보내 서버가 session_id·cwd로 채팅을 추측하지 않게 한다.
async function main(): Promise<void> {
  const url = codexUrl ?? process.env.WEB_AGENT_MANAGER_HOOK_URL ?? process.env.MYAGENT_HOOK_URL;
  const token = process.env.WEB_AGENT_MANAGER_HOOK_TOKEN ?? process.env.MYAGENT_HOOK_TOKEN;
  if (!url || !token) throw new Error("웹 승인 브리지 설정이 없습니다.");
  const chatId = process.env.WEB_AGENT_MANAGER_CHAT_ID;
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(chatId ? { "X-WAM-Chat-Id": chatId } : {}) },
    body: await readInput(),
    signal: AbortSignal.timeout(590_000),
  });
  if (!response.ok) throw new Error(`웹 승인 요청 실패: ${response.status}`);
  process.stdout.write(JSON.stringify(await response.json()));
}

main().catch((error) => {
  // Codex 모드는 결정 없이 끝내 기본 승인 화면으로 넘긴다.
  if (!codexUrl) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: error instanceof Error ? error.message : "웹 승인 실패", interrupt: false },
      },
    }));
  }
  process.exitCode = 0;
});
