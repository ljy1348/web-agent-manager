package com.webagentmanager.android;

import android.content.Context;
import android.webkit.CookieManager;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

// WebView 로그인 쿠키와 CSRF 토큰으로 Android 네이티브 API 요청을 공통 처리한다.
final class AuthenticatedApiClient {
    private AuthenticatedApiClient() {}

    // 현재 WebView 로그인 세션의 서버 주소·쿠키·CSRF 값을 확인한다.
    static Session current(Context context) throws Exception {
        String baseUrl = ServerConfig.getBaseUrl(context);
        String cookies = CookieManager.getInstance().getCookie(baseUrl);
        if (baseUrl.isEmpty() || cookies == null || cookies.isEmpty()) throw new IllegalStateException("앱 로그인이 필요합니다.");
        HttpURLConnection connection = open(baseUrl + "/api/auth/me", cookies, "GET");
        Response response = response(connection);
        if (response.status != 200) throw new IllegalStateException("앱 로그인이 필요합니다.");
        String csrfToken = response.json().optString("csrfToken", "");
        if (csrfToken.isEmpty()) throw new IllegalStateException("로그인 세션을 확인하지 못했습니다.");
        return new Session(baseUrl, cookies, csrfToken);
    }

    // 인증 세션으로 JSON API를 호출하고 상태 코드와 본문을 반환한다.
    static Response request(Session session, String path, String method, JSONObject body) throws Exception {
        HttpURLConnection connection = open(session.baseUrl + path, session.cookies, method);
        connection.setRequestProperty("x-csrf-token", session.csrfToken);
        return send(connection, body);
    }

    // 로그인 쿠키가 없는 기기 서명 세션 발급 API를 호출한다.
    static Response anonymous(Context context, String path, JSONObject body) throws Exception {
        String baseUrl = ServerConfig.getBaseUrl(context);
        if (baseUrl.isEmpty()) throw new IllegalStateException("앱에서 서버 설정이 필요합니다.");
        return send(open(baseUrl + path, "", "POST"), body);
    }

    // 선택적 JSON 본문을 전송하고 응답을 공통 형식으로 읽는다.
    private static Response send(HttpURLConnection connection, JSONObject body) throws Exception {
        if (body != null) {
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setDoOutput(true);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
        }
        return response(connection);
    }

    // 쿠키와 보수적인 타임아웃을 적용한 서버 연결을 만든다.
    private static HttpURLConnection open(String url, String cookies, String method) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(10_000);
        connection.setInstanceFollowRedirects(false);
        if (cookies != null && !cookies.isEmpty()) connection.setRequestProperty("Cookie", cookies);
        connection.setRequestProperty("Accept", "application/json");
        return connection;
    }

    // 성공·오류 응답 스트림을 모두 닫고 문자열 본문으로 바꾼다.
    private static Response response(HttpURLConnection connection) throws Exception {
        int status = connection.getResponseCode();
        List<String> setCookies = new ArrayList<>();
        for (Map.Entry<String, List<String>> header : connection.getHeaderFields().entrySet()) {
            if (header.getKey() != null && header.getKey().equalsIgnoreCase("Set-Cookie") && header.getValue() != null) {
                setCookies.addAll(header.getValue());
            }
        }
        InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        StringBuilder result = new StringBuilder();
        if (stream != null) {
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) result.append(line);
            }
        }
        connection.disconnect();
        return new Response(status, result.toString(), setCookies);
    }

    // 한 번 확인한 로그인 쿠키·CSRF 문맥을 연속 API 요청에서 재사용한다.
    static final class Session {
        final String baseUrl;
        final String cookies;
        final String csrfToken;

        // 확인된 인증 문맥의 불변 값을 묶는다.
        Session(String baseUrl, String cookies, String csrfToken) {
            this.baseUrl = baseUrl;
            this.cookies = cookies;
            this.csrfToken = csrfToken;
        }
    }

    // HTTP 상태와 JSON 문자열을 함께 보존한다.
    static final class Response {
        final int status;
        final String body;
        final List<String> setCookies;

        // 연결을 닫은 뒤에도 사용할 상태·본문·세션 쿠키 응답을 보존한다.
        Response(int status, String body, List<String> setCookies) {
            this.status = status;
            this.body = body;
            this.setCookies = Collections.unmodifiableList(new ArrayList<>(setCookies));
        }

        // 비어 있는 응답도 안전한 JSON 객체로 변환한다.
        JSONObject json() throws Exception {
            return body.isEmpty() ? new JSONObject() : new JSONObject(body);
        }
    }
}
