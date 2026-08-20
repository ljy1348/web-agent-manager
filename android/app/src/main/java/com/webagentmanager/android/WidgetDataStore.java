package com.webagentmanager.android;

import android.content.Context;

// 마지막 위젯 API 응답과 오류를 앱 공용 환경설정에 저장한다.
public final class WidgetDataStore {
    private static final String KEY_JSON = "widget_snapshot_json";
    private static final String KEY_ERROR = "widget_snapshot_error";

    private WidgetDataStore() {}

    // 정상 JSON 응답을 저장하고 이전 오류를 지운다.
    public static void save(Context context, String json) {
        ServerConfig.preferences(context).edit().putString(KEY_JSON, json).remove(KEY_ERROR).apply();
    }

    // 사용자에게 보여줄 짧은 갱신 오류를 저장한다.
    public static void saveError(Context context, String error) {
        ServerConfig.preferences(context).edit().putString(KEY_ERROR, error).apply();
    }

    // 마지막 정상 스냅샷을 파싱하며 아직 데이터가 없으면 null을 반환한다.
    public static WidgetSnapshot load(Context context) {
        String json = ServerConfig.preferences(context).getString(KEY_JSON, "");
        if (json == null || json.isEmpty()) return null;
        try {
            return WidgetSnapshot.fromJson(json);
        } catch (Exception error) {
            return null;
        }
    }

    // 마지막 갱신 오류 문구를 반환한다.
    public static String error(Context context) {
        return ServerConfig.preferences(context).getString(KEY_ERROR, "");
    }
}
