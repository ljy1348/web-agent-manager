package com.webagentmanager.android;

import android.content.Intent;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;

// 1×1 위젯에서 Claude·Codex 카드를 스와이프할 수 있는 두 항목 컬렉션을 제공한다.
public final class WidgetStackService extends RemoteViewsService {
    // 런처가 요청한 StackView 데이터 팩토리를 생성한다.
    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new Factory();
    }

    // 저장된 최신 위젯 스냅샷을 두 장의 RemoteViews로 변환한다.
    private final class Factory implements RemoteViewsFactory {
        private WidgetSnapshot snapshot;

        // 초기 스냅샷을 읽는다.
        @Override public void onCreate() { snapshot = WidgetDataStore.load(WidgetStackService.this); }
        // 갱신 알림마다 새 스냅샷을 다시 읽는다.
        @Override public void onDataSetChanged() { snapshot = WidgetDataStore.load(WidgetStackService.this); }
        // 별도 자원이 없어 정리할 내용이 없다.
        @Override public void onDestroy() {}
        // Claude·Codex 두 장을 반환한다.
        @Override public int getCount() { return 2; }

        // 지정 위치의 공급자 카드와 앱 열기 fill-in intent를 만든다.
        @Override public RemoteViews getViewAt(int position) {
            RemoteViews views = new RemoteViews(getPackageName(), R.layout.widget_stack_item);
            WidgetSnapshot.Usage usage = snapshot == null ? null : (position == 0 ? snapshot.claude : snapshot.codex);
            views.setTextViewText(R.id.stack_provider, position == 0 ? "Claude" : "Codex");
            int percent = usage == null ? -1 : usage.usedPercent;
            views.setTextViewText(R.id.stack_value, UsageWidgetProvider.percentText(percent));
            views.setProgressBar(R.id.stack_progress, 100, Math.max(0, percent), percent < 0);
            views.setOnClickFillInIntent(R.id.stack_item_root, new Intent());
            return views;
        }

        // 로딩 중에는 별도 뷰를 제공하지 않는다.
        @Override public RemoteViews getLoadingView() { return null; }
        // 두 카드 레이아웃이 동일하므로 뷰 유형은 하나다.
        @Override public int getViewTypeCount() { return 1; }
        // 위치를 안정 ID로 그대로 사용한다.
        @Override public long getItemId(int position) { return position; }
        // 두 공급자 순서가 고정이라 안정 ID를 사용한다.
        @Override public boolean hasStableIds() { return true; }
    }
}
