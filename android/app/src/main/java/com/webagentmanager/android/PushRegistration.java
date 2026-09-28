package com.webagentmanager.android;

import android.content.Context;
import android.os.Build;
import android.util.Log;

import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;

import org.json.JSONObject;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

// Firebase 설정이 있는 빌드에서 현재 로그인 세션에 Firebase Installation ID를 연결한다.
public final class PushRegistration {
    private static final String TAG = "PushRegistration";
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();

    private PushRegistration() {}

    // Firebase가 구성돼 있으면 최신 설치 ID 등록을 요청한다. 결과는 onRegistered로 받는다.
    public static void sync(Context context) {
        Context appContext = context.getApplicationContext();
        if (FirebaseApp.getApps(appContext).isEmpty()) return;
        EXECUTOR.execute(() -> unregisterStale(appContext));
        // 자동 초기화는 매니페스트에서 끄지 않는 한 기본으로 켜져 있어 setAutoInitEnabled(true)를 부르지 않는다.
        // firebase-messaging 25는 그 호출 안에서 설치 ID를 Tasks.await로 동기 대기해, 메인 스레드인
        // onPageFinished에서 부르면 IllegalStateException으로 앱이 종료됐다(#122).
        // register()는 Firebase 실행기로 넘기고 Task를 돌려주는 비동기 API라 여기서 불러도 된다.
        FirebaseMessaging.getInstance().register()
                .addOnFailureListener(error -> Log.w(TAG, "FCM 설치 ID 등록 요청 실패", error));
        String pending = ServerConfig.preferences(appContext).getString("pending_fcm_token", "");
        if (!pending.isEmpty()) EXECUTOR.execute(() -> register(appContext, pending));
    }

    // 토큰 갱신 콜백에서 받은 값을 로그인 완료 뒤 재전송할 수 있게 보관한다.
    public static void rememberAndSync(Context context, String token) {
        Context appContext = context.getApplicationContext();
        ServerConfig.preferences(appContext).edit().putString("pending_fcm_token", token).apply();
        EXECUTOR.execute(() -> unregisterStale(appContext));
        EXECUTOR.execute(() -> register(appContext, token));
    }

    // 다른 WAM으로 전환하면 이전 서버의 등록을 회수하고, 실패 시 다음 페이지 로드에서 재시도한다.
    public static void onServerChanging(Context context, String nextBaseUrl) {
        String previous = ServerConfig.preferences(context).getString("registered_fcm_server", "");
        String token = ServerConfig.preferences(context).getString("registered_fcm_token", "");
        if (previous.isEmpty() || token.isEmpty() || previous.equals(nextBaseUrl)) return;
        ServerConfig.preferences(context).edit().putString("stale_fcm_server", previous).putString("stale_fcm_token", token).apply();
        EXECUTOR.execute(() -> unregisterStale(context.getApplicationContext()));
    }

    // 세션 쿠키와 /auth/me의 CSRF 값을 사용해 토큰을 관리자 계정에 등록한다.
    private static void register(Context context, String token) {
        try {
            String oldToken = ServerConfig.preferences(context).getString("registered_fcm_token", "");
            String oldServer = ServerConfig.preferences(context).getString("registered_fcm_server", "");
            if (!oldToken.isEmpty() && !oldServer.isEmpty() && !oldToken.equals(token)) {
                ServerConfig.preferences(context).edit().putString("stale_fcm_server", oldServer).putString("stale_fcm_token", oldToken).apply();
                unregisterStale(context);
            }
            AuthenticatedApiClient.Session session = AuthenticatedApiClient.current(context);
            JSONObject body = new JSONObject();
            body.put("token", token);
            body.put("label", Build.MANUFACTURER + " " + Build.MODEL);
            AuthenticatedApiClient.Response registration = AuthenticatedApiClient.request(session, "/api/mobile/push-token", "POST", body);
            if (registration.status == 204) ServerConfig.preferences(context).edit()
                    .remove("pending_fcm_token")
                    .putString("registered_fcm_token", token)
                    .putString("registered_fcm_server", session.baseUrl)
                    .apply();
        } catch (Exception ignored) {
            // 로그인 전·일시적 네트워크 실패는 다음 페이지 로드나 토큰 갱신 때 다시 시도한다.
        }
    }

    private static void unregisterStale(Context context) {
        String server = ServerConfig.preferences(context).getString("stale_fcm_server", "");
        String token = ServerConfig.preferences(context).getString("stale_fcm_token", "");
        if (server.isEmpty() || token.isEmpty()) return;
        try {
            AuthenticatedApiClient.Session session = AuthenticatedApiClient.current(context, server);
            JSONObject body = new JSONObject();
            body.put("token", token);
            if (AuthenticatedApiClient.request(session, "/api/mobile/push-token", "DELETE", body).status == 204) {
                // 중간에 다른 서버 전환이 발생했으면 새 회수 작업을 지우지 않는다.
                if (server.equals(ServerConfig.preferences(context).getString("stale_fcm_server", ""))
                        && token.equals(ServerConfig.preferences(context).getString("stale_fcm_token", ""))) {
                    ServerConfig.preferences(context).edit().remove("stale_fcm_server").remove("stale_fcm_token").apply();
                }
            }
        } catch (Exception ignored) {
            // 옛 서버가 오프라인이면 다음 앱 접속에서 다시 시도한다.
        }
    }
}
