// 채팅 첨부 업로드 제한. 서버(project-routes.ts)와 클라이언트(ChatView.tsx)가 같은 값을 참조해
// 클라이언트가 서버 제한을 넘는 파일을 애초에 전송 시도하지 않도록 한다.
export const CHAT_ATTACHMENT_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const CHAT_ATTACHMENT_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export const CHAT_ATTACHMENT_MAX_FILES = 5;
