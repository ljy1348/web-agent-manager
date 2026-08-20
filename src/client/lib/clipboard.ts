// HTTPS가 아닌 LAN 접속 등 비보안 컨텍스트에서는 navigator.clipboard 자체가 없어, 옛 방식(임시
// textarea + execCommand)으로 대체한다.
export function copyText(text: string): void {
  if (navigator.clipboard?.writeText) { void navigator.clipboard.writeText(text).catch(() => undefined); return; }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try { document.execCommand("copy"); } catch { /* 복사 실패는 조용히 무시 */ }
  document.body.removeChild(area);
}
