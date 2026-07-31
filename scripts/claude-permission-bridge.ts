import process from "node:process";

// 표준 입력 전체를 Claude 훅 JSON 문자열로 읽는다.
async function readInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

// Claude 권한 요청을 로컬 웹 서버에 전달하고 결정을 stdout으로 반환한다.
async function main(): Promise<void> {
  const url = process.env.WEB_AGENT_MANAGER_HOOK_URL ?? process.env.MYAGENT_HOOK_URL;
  const token = process.env.WEB_AGENT_MANAGER_HOOK_TOKEN ?? process.env.MYAGENT_HOOK_TOKEN;
  if (!url || !token) throw new Error("웹 승인 브리지 설정이 없습니다.");
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: await readInput(),
    signal: AbortSignal.timeout(590_000),
  });
  if (!response.ok) throw new Error(`웹 승인 요청 실패: ${response.status}`);
  process.stdout.write(JSON.stringify(await response.json()));
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "deny", message: error instanceof Error ? error.message : "웹 승인 실패", interrupt: false },
    },
  }));
  process.exitCode = 0;
});
