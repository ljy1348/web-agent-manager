package com.webagentmanager.android;

import android.content.Context;
import android.webkit.CookieManager;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

// WebView 로그인 쿠키로 서버의 작은 위젯 스냅샷 API를 호출한다.
public final class WidgetApiClient {
    private WidgetApiClient() {}

    // 최신 위젯 JSON을 반환하고 설정·로그인·네트워크 오류는 짧은 한국어 예외로 구분한다.
    public static String fetch(Context context) throws Exception {
        String baseUrl = ServerConfig.getBaseUrl(context);
        if (baseUrl.isEmpty()) throw new IllegalStateException("앱에서 서버 설정 필요");
        String cookies = CookieManager.getInstance().getCookie(baseUrl);
        if (cookies == null || cookies.isEmpty()) throw new IllegalStateException("앱 로그인 필요");
        HttpURLConnection connection = (HttpURLConnection) new URL(baseUrl + "/api/mobile/widget").openConnection();
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(10_000);
        connection.setInstanceFollowRedirects(false);
        connection.setRequestProperty("Cookie", cookies);
        connection.setRequestProperty("Accept", "application/json");
        int status = connection.getResponseCode();
        if (status == 401 || status == 403) {
            connection.disconnect();
            throw new IllegalStateException("앱 로그인 필요");
        }
        if (status != 200) {
            connection.disconnect();
            throw new IllegalStateException("서버 응답 " + status);
        }
        StringBuilder result = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) result.append(line);
        } finally {
            connection.disconnect();
        }
        return result.toString();
    }
}
