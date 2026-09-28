package com.webagentmanager.android;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

// FCM 전경 메시지를 web-agent-manager 전용 시스템 알림으로 표시한다.
public final class NotificationHelper {
    public static final String CHANNEL_ID = "web_agent_manager_events";
    // FCM data와 알림 intent가 같은 키를 써서, 백그라운드 시스템 알림도 같은 채팅으로 이동한다.
    public static final String EXTRA_CHAT_ID = "chatId";

    private NotificationHelper() {}

    // Android 8 이상에서 운영 이벤트 알림 채널을 보장한다.
    public static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "에이전트 이벤트", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("작업 완료, 권한 요청, 사용량 한도 및 터미널 상태 알림");
        context.getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    // 제목과 본문을 탭하면 앱이 열리고, chatId가 있으면 그 채팅으로 이동하는 알림을 표시한다.
    public static void show(Context context, String title, String body, String chatId) {
        ensureChannel(context);
        Intent launch = new Intent(context, MainActivity.class).setAction("OPEN_WEB_AGENT_MANAGER");
        if (chatId != null) launch.putExtra(EXTRA_CHAT_ID, chatId);
        // 채팅마다 다른 requestCode를 써서 여러 알림의 chatId extra가 서로 덮어쓰지 않게 한다.
        int requestCode = chatId == null ? 0 : chatId.hashCode();
        PendingIntent pendingIntent = PendingIntent.getActivity(context, requestCode, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        android.app.Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new android.app.Notification.Builder(context, CHANNEL_ID)
                : new android.app.Notification.Builder(context);
        builder.setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new android.app.Notification.BigTextStyle().bigText(body))
                .setContentIntent(pendingIntent)
                .setAutoCancel(true);
        ((NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE)).notify((title + body).hashCode(), builder.build());
    }
}
