export type ChatViewMode = "chat" | "terminal";

// 터미널 WebSocket은 서버에서 관리자만 구독할 수 있다. 저장값이 예전 terminal 상태여도
// 일반 사용자는 빈 터미널 화면에 들어가지 않도록 항상 채팅 모드로 정규화한다.
export function effectiveChatViewMode(role: string | null | undefined, savedMode: string | null | undefined): ChatViewMode {
  return role === "admin" && savedMode === "terminal" ? "terminal" : "chat";
}
