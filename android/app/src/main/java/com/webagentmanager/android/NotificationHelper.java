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

    private NotificationHelper() {}

    // Android 8 이상에서 운영 이벤트 알림 채널을 보장한다.
    public static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "에이전트 이벤트", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("작업 완료, 권한 요청, 사용량 한도 및 터미널 상태 알림");
        context.getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    // 제목과 본문을 탭하면 WebView 앱이 열리는 알림으로 표시한다.
    public static void show(Context context, String title, String body) {
        ensureChannel(context);
        Intent launch = new Intent(context, MainActivity.class).setAction("OPEN_WEB_AGENT_MANAGER");
        PendingIntent pendingIntent = PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
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
