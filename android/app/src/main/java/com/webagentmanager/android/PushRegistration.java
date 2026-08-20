package com.webagentmanager.android;

import android.content.Context;
import android.os.Build;

import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;

import org.json.JSONObject;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

// Firebase 설정이 있는 빌드에서 현재 로그인 세션에 FCM 등록 토큰을 연결한다.
public final class PushRegistration {
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();

    private PushRegistration() {}

    // Firebase가 구성돼 있으면 최신 토큰을 얻어 서버 등록을 비동기로 시도한다.
    public static void sync(Context context) {
        Context appContext = context.getApplicationContext();
        if (FirebaseApp.getApps(appContext).isEmpty()) return;
        FirebaseMessaging.getInstance().setAutoInitEnabled(true);
        FirebaseMessaging.getInstance().getToken().addOnSuccessListener(token -> {
            ServerConfig.preferences(appContext).edit().putString("pending_fcm_token", token).apply();
            EXECUTOR.execute(() -> register(appContext, token));
        });
    }

    // 토큰 갱신 콜백에서 받은 값을 로그인 완료 뒤 재전송할 수 있게 보관한다.
    public static void rememberAndSync(Context context, String token) {
        Context appContext = context.getApplicationContext();
        ServerConfig.preferences(appContext).edit().putString("pending_fcm_token", token).apply();
        EXECUTOR.execute(() -> register(appContext, token));
    }

    // 세션 쿠키와 /auth/me의 CSRF 값을 사용해 토큰을 관리자 계정에 등록한다.
    private static void register(Context context, String token) {
        try {
            AuthenticatedApiClient.Session session = AuthenticatedApiClient.current(context);
            JSONObject body = new JSONObject();
            body.put("token", token);
            body.put("label", Build.MANUFACTURER + " " + Build.MODEL);
            AuthenticatedApiClient.Response registration = AuthenticatedApiClient.request(session, "/api/mobile/push-token", "POST", body);
            if (registration.status == 204) ServerConfig.preferences(context).edit().remove("pending_fcm_token").apply();
        } catch (Exception ignored) {
            // 로그인 전·일시적 네트워크 실패는 다음 페이지 로드나 토큰 갱신 때 다시 시도한다.
        }
    }
}
