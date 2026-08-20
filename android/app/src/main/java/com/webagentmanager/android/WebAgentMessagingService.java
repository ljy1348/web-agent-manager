package com.webagentmanager.android;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

// FCM 토큰 회전과 앱 전경 메시지를 web-agent-manager 서버·알림 UI에 연결한다.
public final class WebAgentMessagingService extends FirebaseMessagingService {
    // 새 등록 토큰을 값 노출 없이 서버로 동기화한다.
    @Override
    public void onNewToken(String token) {
        super.onNewToken(token);
        PushRegistration.rememberAndSync(this, token);
    }

    // 전경에서 받은 데이터·알림 메시지를 Android 알림으로 표시한다.
    @Override
    public void onMessageReceived(RemoteMessage message) {
        super.onMessageReceived(message);
        String title = message.getNotification() != null ? message.getNotification().getTitle() : message.getData().get("title");
        String body = message.getNotification() != null ? message.getNotification().getBody() : message.getData().get("body");
        NotificationHelper.show(this, title == null ? "웹 에이전트 관리자" : title, body == null ? "새 알림이 있습니다." : body);
    }
}
