// 이 브라우저가 Notification API를 지원하는지, 지원한다면 현재 권한 상태를 반환한다.
export function notificationPermission(): NotificationPermission {
  return typeof Notification === "undefined" ? "denied" : Notification.permission;
}

// 사용자 클릭 등 실제 제스처 안에서 호출해야 브라우저가 권한 요청 팝업을 띄워준다.
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof Notification === "undefined") return "denied";
  return Notification.requestPermission();
}

// 권한이 있을 때만 브라우저 알림을 띄운다. 지금 탭을 보고 있는 중이면 화면에 이미 반영되고 있으므로
// 굳이 팝업으로 방해하지 않는다.
export function showNotification(title: string, body: string): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (document.visibilityState === "visible" && document.hasFocus()) return;
  try {
    new Notification(title, { body });
  } catch {
    // 일부 환경(모바일 Safari 등)은 new Notification()을 지원하지 않아 조용히 무시한다.
  }
}
