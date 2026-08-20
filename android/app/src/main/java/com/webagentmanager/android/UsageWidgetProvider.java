package com.webagentmanager.android;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.widget.RemoteViews;

// 크기에 따라 1×1·2×1·1×2·2×2 레이아웃을 선택하고 서버 데이터를 갱신하는 홈 화면 위젯이다.
public final class UsageWidgetProvider extends AppWidgetProvider {
    private static final String ACTION_REFRESH = "com.webagentmanager.android.action.REFRESH_WIDGET";

    // 시스템 주기 갱신에서 현재 값을 먼저 그리고 백그라운드 API 갱신을 시작한다.
    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] appWidgetIds) {
        super.onUpdate(context, manager, appWidgetIds);
        renderAll(context);
        refreshAsync(context, goAsync());
    }

    // 크기가 바뀌면 즉시 적합한 레이아웃으로 다시 그린다.
    @Override
    public void onAppWidgetOptionsChanged(Context context, AppWidgetManager manager, int appWidgetId, Bundle options) {
        super.onAppWidgetOptionsChanged(context, manager, appWidgetId, options);
        render(context, manager, appWidgetId);
    }

    // 수동 새로고침 버튼 방송을 비동기 API 갱신으로 처리한다.
    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        if (ACTION_REFRESH.equals(intent.getAction())) refreshAsync(context, goAsync());
    }

    // Activity의 로그인·설정 완료 시 모든 위젯 갱신을 요청한다.
    public static void requestRefresh(Context context) {
        Intent intent = new Intent(context, UsageWidgetProvider.class).setAction(ACTION_REFRESH);
        context.sendBroadcast(intent);
    }

    // 네트워크 호출을 방송 제한 시간 안의 백그라운드 스레드에서 수행한다.
    private static void refreshAsync(Context context, PendingResult pendingResult) {
        Context appContext = context.getApplicationContext();
        new Thread(() -> {
            try {
                WidgetDataStore.save(appContext, WidgetApiClient.fetch(appContext));
            } catch (Exception error) {
                WidgetDataStore.saveError(appContext, error.getMessage() == null ? "갱신 실패" : error.getMessage());
            } finally {
                renderAll(appContext);
                pendingResult.finish();
            }
        }, "wam-widget-refresh").start();
    }

    // 설치된 모든 위젯 ID를 최신 저장 데이터로 다시 그린다.
    private static void renderAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, UsageWidgetProvider.class));
        for (int id : ids) render(context, manager, id);
    }

    // 런처가 준 실제 dp 크기로 compact·wide·tall·full 레이아웃을 선택한다.
    private static void render(Context context, AppWidgetManager manager, int appWidgetId) {
        Bundle options = manager.getAppWidgetOptions(appWidgetId);
        int width = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 110);
        int height = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 60);
        WidgetSnapshot snapshot = WidgetDataStore.load(context);
        String error = WidgetDataStore.error(context);
        if (width < 110 && height < 110) renderCompact(context, manager, appWidgetId, snapshot, error);
        else if (width >= 110 && height < 110) renderWide(context, manager, appWidgetId, snapshot, error);
        else if (width < 110) renderTall(context, manager, appWidgetId, snapshot, error);
        else renderFull(context, manager, appWidgetId, snapshot, error);
    }

    // 1×1에서는 StackView 두 장을 제공해 Claude·Codex를 위아래 스와이프한다.
    private static void renderCompact(Context context, AppWidgetManager manager, int id, WidgetSnapshot snapshot, String error) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_compact);
        Intent serviceIntent = new Intent(context, WidgetStackService.class);
        serviceIntent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id);
        serviceIntent.setData(Uri.parse(serviceIntent.toUri(Intent.URI_INTENT_SCHEME)));
        views.setRemoteAdapter(R.id.usage_stack, serviceIntent);
        views.setEmptyView(R.id.usage_stack, R.id.compact_empty);
        views.setTextViewText(R.id.compact_empty, snapshot == null ? emptyText(error) : "불러오는 중");
        views.setPendingIntentTemplate(R.id.usage_stack, openAppPendingIntent(context));
        views.setOnClickPendingIntent(R.id.compact_refresh, refreshPendingIntent(context, id));
        manager.updateAppWidget(id, views);
        manager.notifyAppWidgetViewDataChanged(id, R.id.usage_stack);
    }

    // 2×1에서는 Claude·Codex 사용량을 좌우 두 카드로 표시한다.
    private static void renderWide(Context context, AppWidgetManager manager, int id, WidgetSnapshot snapshot, String error) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_wide);
        bindUsage(views, R.id.claude_value, R.id.claude_progress, snapshot == null ? null : snapshot.claude);
        bindUsage(views, R.id.codex_value, R.id.codex_progress, snapshot == null ? null : snapshot.codex);
        views.setTextViewText(R.id.widget_status, snapshot == null ? emptyText(error) : "업데이트됨");
        bindCommonActions(context, views, id);
        manager.updateAppWidget(id, views);
    }

    // 1×2에서는 Claude·Codex 사용량을 위아래 두 카드로 표시한다.
    private static void renderTall(Context context, AppWidgetManager manager, int id, WidgetSnapshot snapshot, String error) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_tall);
        bindUsage(views, R.id.claude_value, R.id.claude_progress, snapshot == null ? null : snapshot.claude);
        bindUsage(views, R.id.codex_value, R.id.codex_progress, snapshot == null ? null : snapshot.codex);
        views.setTextViewText(R.id.widget_status, snapshot == null ? emptyText(error) : "업데이트됨");
        bindCommonActions(context, views, id);
        manager.updateAppWidget(id, views);
    }

    // 2×2 이상에서는 두 모델과 CPU·메모리 사용률을 함께 표시한다.
    private static void renderFull(Context context, AppWidgetManager manager, int id, WidgetSnapshot snapshot, String error) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_full);
        bindUsage(views, R.id.claude_value, R.id.claude_progress, snapshot == null ? null : snapshot.claude);
        bindUsage(views, R.id.codex_value, R.id.codex_progress, snapshot == null ? null : snapshot.codex);
        bindMetric(views, R.id.cpu_value, R.id.cpu_progress, snapshot == null ? -1 : snapshot.cpuPercent);
        bindMetric(views, R.id.memory_value, R.id.memory_progress, snapshot == null ? -1 : snapshot.memoryPercent);
        views.setTextViewText(R.id.widget_status, snapshot == null ? emptyText(error) : "업데이트됨");
        bindCommonActions(context, views, id);
        manager.updateAppWidget(id, views);
    }

    // 공급자 사용률 텍스트와 진행 막대를 함께 갱신한다.
    private static void bindUsage(RemoteViews views, int valueId, int progressId, WidgetSnapshot.Usage usage) {
        int percent = usage == null ? -1 : usage.usedPercent;
        views.setTextViewText(valueId, percentText(percent));
        views.setProgressBar(progressId, 100, Math.max(0, percent), percent < 0);
    }

    // CPU·메모리 비율 텍스트와 진행 막대를 함께 갱신한다.
    private static void bindMetric(RemoteViews views, int valueId, int progressId, int percent) {
        views.setTextViewText(valueId, percentText(percent));
        views.setProgressBar(progressId, 100, Math.max(0, percent), percent < 0);
    }

    // 루트 탭은 앱 열기, 새로고침 아이콘은 즉시 API 갱신으로 연결한다.
    private static void bindCommonActions(Context context, RemoteViews views, int id) {
        views.setOnClickPendingIntent(R.id.widget_root, openAppPendingIntent(context));
        views.setOnClickPendingIntent(R.id.widget_refresh, refreshPendingIntent(context, id));
    }

    // WebView 앱을 여는 불변 PendingIntent를 만든다.
    private static PendingIntent openAppPendingIntent(Context context) {
        Intent intent = new Intent(context, MainActivity.class).setAction("OPEN_WEB_AGENT_MANAGER");
        return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    // 특정 위젯의 수동 갱신 방송 PendingIntent를 만든다.
    private static PendingIntent refreshPendingIntent(Context context, int id) {
        Intent intent = new Intent(context, UsageWidgetProvider.class).setAction(ACTION_REFRESH).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id);
        return PendingIntent.getBroadcast(context, id, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    // 미확인 비율은 대시로, 정상 값은 퍼센트로 표시한다.
    public static String percentText(int percent) {
        return percent < 0 ? "—" : percent + "%";
    }

    // 데이터가 없을 때 마지막 오류 또는 기본 안내를 표시한다.
    private static String emptyText(String error) {
        return error == null || error.isEmpty() ? "앱에서 로그인" : error;
    }
}
