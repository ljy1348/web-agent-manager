package com.webagentmanager.android;

import android.content.Context;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.webkit.CookieManager;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

// Android Keystore 서명으로 현재 WebView 세션을 등록 기기 신뢰 상태로 인증한다.
public final class AppTrustManager {
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "wam_mobile_trust_device";
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();

    private AppTrustManager() {}

    // 새 origin은 기기 서명으로 로그인하고 기존 로그인 세션은 비동기로 신뢰 승격한다.
    public static void sync(Context context, Callback callback) {
        Context appContext = context.getApplicationContext();
        EXECUTOR.execute(() -> {
            try {
                KeyPair keyPair = existingKeyPair();
                if (keyPair == null) return;
                AuthenticatedApiClient.Session session;
                try {
                    session = AuthenticatedApiClient.current(appContext);
                } catch (Exception loginError) {
                    if (bootstrapAttempted(appContext)) return;
                    boolean bootstrapped = bootstrapSession(appContext, keyPair);
                    markBootstrapAttempted(appContext);
                    if (bootstrapped) callback.complete(true, "앱 기기 인증으로 로그인했습니다.");
                    return;
                }
                markBootstrapAttempted(appContext);
                String deviceId = storedDeviceId(appContext);
                JSONObject status = deviceId.isEmpty() ? null : deviceStatus(session, deviceId);
                if (status == null || !status.optBoolean("enrolled")) {
                    status = resolveDevice(session, keyPair);
                    deviceId = status.optString("deviceId", "");
                    if (deviceId.isEmpty() || !status.optBoolean("enrolled")) return;
                    storeDeviceId(appContext, deviceId);
                }
                if (status.optBoolean("sessionTrusted")) return;
                activate(session, deviceId);
                callback.complete(true, "앱 기기 인증을 적용했습니다.");
            } catch (Exception ignored) {
                // 로그인 전·일시적 네트워크 실패는 다음 페이지 로드에서 다시 시도한다.
            }
        });
    }

    // 내부망의 관리자 로그인 세션에서 이 기기 공개키를 등록하고 즉시 현재 세션을 인증한다.
    public static void enroll(Context context, Callback callback) {
        Context appContext = context.getApplicationContext();
        EXECUTOR.execute(() -> {
            try {
                AuthenticatedApiClient.Session session = AuthenticatedApiClient.current(appContext);
                KeyPair keyPair = keyPair();
                JSONObject body = new JSONObject();
                body.put("publicKey", Base64.encodeToString(keyPair.getPublic().getEncoded(), Base64.NO_WRAP));
                body.put("label", Build.MANUFACTURER + " " + Build.MODEL);
                AuthenticatedApiClient.Response enrolled = AuthenticatedApiClient.request(session, "/api/mobile/trust/enroll", "POST", body);
                if (enrolled.status == 403) {
                    callback.complete(false, "최초 앱 인증은 내부망에서 관리자 로그인 후 실행해주세요.");
                    return;
                }
                if (enrolled.status != 201) throw new IllegalStateException(errorMessage(enrolled, "앱 기기를 등록하지 못했습니다."));
                String deviceId = enrolled.json().optString("deviceId", "");
                if (deviceId.isEmpty()) throw new IllegalStateException("서버가 기기 식별자를 반환하지 않았습니다.");
                storeDeviceId(appContext, deviceId);
                markBootstrapAttempted(appContext);
                activate(session, deviceId);
                callback.complete(true, "이 기기를 인증했습니다. 외부망에서도 내부망 기능을 사용할 수 있습니다.");
            } catch (Exception error) {
                callback.complete(false, error.getMessage() == null ? "앱 기기 인증에 실패했습니다." : error.getMessage());
            }
        });
    }

    // 현재 서버에 이 앱이 보관한 기기 등록 식별자가 있는지 확인한다.
    public static boolean hasRegistration(Context context) {
        try {
            return !storedDeviceCandidates(context).isEmpty();
        } catch (Exception ignored) {
            return false;
        }
    }

    // 사용자가 서버 연결을 확정하면 해당 origin의 기기 로그인 시도를 한 번 다시 허용한다.
    public static void prepareServerConnection(Context context) {
        try {
            ServerConfig.preferences(context).edit().remove("mobile_trust_bootstrap_" + serverKey(context)).apply();
        } catch (Exception ignored) {
            // 유효한 서버 주소가 없으면 페이지 로드도 시작되지 않으므로 별도 처리가 필요 없다.
        }
    }

    // 현재 서버 등록과 모든 연결 세션 신뢰를 회수한다.
    public static void revoke(Context context, Callback callback) {
        Context appContext = context.getApplicationContext();
        EXECUTOR.execute(() -> {
            try {
                AuthenticatedApiClient.Session session = AuthenticatedApiClient.current(appContext);
                String deviceId = storedDeviceId(appContext);
                if (deviceId.isEmpty()) {
                    KeyPair keyPair = existingKeyPair();
                    if (keyPair == null) throw new IllegalStateException("이 서버에 등록된 앱 기기가 없습니다.");
                    deviceId = resolveDevice(session, keyPair).optString("deviceId", "");
                }
                if (deviceId.isEmpty()) throw new IllegalStateException("이 서버에 등록된 앱 기기가 없습니다.");
                JSONObject body = new JSONObject();
                body.put("deviceId", deviceId);
                AuthenticatedApiClient.Response revoked = AuthenticatedApiClient.request(session, "/api/mobile/trust", "DELETE", body);
                if (revoked.status != 204) throw new IllegalStateException(errorMessage(revoked, "앱 기기 인증을 해제하지 못했습니다."));
                ServerConfig.preferences(appContext).edit().remove("mobile_trust_device_" + serverKey(appContext)).apply();
                if (deviceId.equals(ServerConfig.preferences(appContext).getString("mobile_trust_device_last", ""))) {
                    ServerConfig.preferences(appContext).edit().remove("mobile_trust_device_last").apply();
                }
                callback.complete(true, "이 기기의 앱 인증을 해제했습니다.");
            } catch (Exception error) {
                callback.complete(false, error.getMessage() == null ? "앱 기기 인증 해제에 실패했습니다." : error.getMessage());
            }
        });
    }

    // 서버 challenge를 Keystore 개인키로 서명해 현재 웹 세션에만 신뢰 capability를 부여한다.
    private static void activate(AuthenticatedApiClient.Session session, String deviceId) throws Exception {
        JSONObject challengeBody = new JSONObject();
        challengeBody.put("deviceId", deviceId);
        AuthenticatedApiClient.Response challengeResponse = AuthenticatedApiClient.request(session, "/api/mobile/trust/challenge", "POST", challengeBody);
        if (challengeResponse.status != 200) throw new IllegalStateException(errorMessage(challengeResponse, "앱 인증 challenge를 받지 못했습니다."));
        String challenge = challengeResponse.json().optString("challenge", "");
        if (challenge.isEmpty()) throw new IllegalStateException("앱 인증 challenge가 비어 있습니다.");

        JSONObject activationBody = new JSONObject();
        activationBody.put("deviceId", deviceId);
        activationBody.put("challenge", challenge);
        activationBody.put("signature", signChallenge(challenge));
        AuthenticatedApiClient.Response activated = AuthenticatedApiClient.request(session, "/api/mobile/trust/activate", "POST", activationBody);
        if (activated.status != 200) throw new IllegalStateException(errorMessage(activated, "앱 기기 서명 인증에 실패했습니다."));
    }

    // 주소별 로그인 쿠키가 없으면 등록 기기 서명으로 새 origin의 신뢰 세션을 발급받는다.
    private static boolean bootstrapSession(Context context, KeyPair keyPair) throws Exception {
        for (String deviceId : storedDeviceCandidates(context)) {
            JSONObject challengeBody = new JSONObject();
            challengeBody.put("deviceId", deviceId);
            challengeBody.put("publicKey", Base64.encodeToString(keyPair.getPublic().getEncoded(), Base64.NO_WRAP));
            AuthenticatedApiClient.Response challengeResponse = AuthenticatedApiClient.anonymous(context, "/api/mobile/trust/session/challenge", challengeBody);
            if (challengeResponse.status != 200) continue;
            String challenge = challengeResponse.json().optString("challenge", "");
            if (challenge.isEmpty()) continue;

            JSONObject activationBody = new JSONObject();
            activationBody.put("deviceId", deviceId);
            activationBody.put("challenge", challenge);
            String origin = ServerConfig.origin(ServerConfig.getBaseUrl(context));
            activationBody.put("signature", signChallenge("wam-device-login-v1\n" + origin + "\n" + challenge));
            AuthenticatedApiClient.Response activated = AuthenticatedApiClient.anonymous(context, "/api/mobile/trust/session/activate", activationBody);
            if (activated.status != 200 || activated.setCookies.isEmpty()) continue;
            String baseUrl = ServerConfig.getBaseUrl(context);
            CookieManager cookieManager = CookieManager.getInstance();
            for (String cookie : activated.setCookies) cookieManager.setCookie(baseUrl, cookie);
            cookieManager.flush();
            storeDeviceId(context, deviceId);
            return true;
        }
        return false;
    }

    // 서버의 임의 challenge를 설치 단위 Keystore 개인키로 서명한다.
    private static String signChallenge(String challenge) throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE);
        keyStore.load(null);
        PrivateKey privateKey = (PrivateKey) keyStore.getKey(KEY_ALIAS, null);
        if (privateKey == null) throw new IllegalStateException("앱 기기 인증 키를 찾을 수 없습니다.");
        Signature signer = Signature.getInstance("SHA256withECDSA");
        signer.initSign(privateKey);
        signer.update(challenge.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(signer.sign(), Base64.NO_WRAP);
    }

    // 앱 설치 단위 P-256 키를 Android Keystore에서 조회하거나 새로 생성한다.
    private static KeyPair keyPair() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE);
        keyStore.load(null);
        KeyPair existing = existingKeyPair(keyStore);
        if (existing != null) return existing;
        KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE);
        generator.initialize(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY)
                .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(false)
                .build());
        return generator.generateKeyPair();
    }

    // 이미 생성된 앱 설치 단위 기기 키를 반환하며 아직 없으면 null을 반환한다.
    private static KeyPair existingKeyPair() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE);
        keyStore.load(null);
        return existingKeyPair(keyStore);
    }

    // 열린 Android Keystore에서 기기 키 쌍을 복원한다.
    private static KeyPair existingKeyPair(KeyStore keyStore) throws Exception {
        if (!keyStore.containsAlias(KEY_ALIAS)) return null;
        return new KeyPair(keyStore.getCertificate(KEY_ALIAS).getPublicKey(), (PrivateKey) keyStore.getKey(KEY_ALIAS, null));
    }

    // 서버 주소 해시로 환경설정의 충돌 없는 짧은 키를 만든다.
    private static String serverKey(Context context) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(ServerConfig.getBaseUrl(context).getBytes(StandardCharsets.UTF_8));
        StringBuilder value = new StringBuilder();
        for (int index = 0; index < 12; index += 1) value.append(String.format("%02x", digest[index]));
        return value.toString();
    }

    // 현재 서버에 등록된 불투명 기기 식별자를 앱 전용 저장소에서 읽는다.
    private static String storedDeviceId(Context context) throws Exception {
        String current = ServerConfig.preferences(context).getString("mobile_trust_device_" + serverKey(context), "");
        return current.isEmpty() ? ServerConfig.preferences(context).getString("mobile_trust_device_last", "") : current;
    }

    // 서버가 발급한 공개 기기 식별자만 서버별 앱 전용 저장소에 보관한다.
    private static void storeDeviceId(Context context, String deviceId) throws Exception {
        ServerConfig.preferences(context).edit()
                .putString("mobile_trust_device_" + serverKey(context), deviceId)
                .putString("mobile_trust_device_last", deviceId)
                .apply();
    }

    // 업그레이드 전 주소별 저장값까지 모아 새 외부 origin에서 시도할 기기 ID 후보를 만든다.
    private static Set<String> storedDeviceCandidates(Context context) throws Exception {
        Set<String> candidates = new LinkedHashSet<>();
        String current = storedDeviceId(context);
        if (!current.isEmpty()) candidates.add(current);
        for (Map.Entry<String, ?> entry : ServerConfig.preferences(context).getAll().entrySet()) {
            if (!entry.getKey().startsWith("mobile_trust_device_") || !(entry.getValue() instanceof String)) continue;
            String value = (String) entry.getValue();
            if (!value.isEmpty()) candidates.add(value);
        }
        return candidates;
    }

    // 현재 origin에서 이미 자동 기기 로그인을 시도했는지 확인해 명시적 로그아웃을 존중한다.
    private static boolean bootstrapAttempted(Context context) throws Exception {
        return ServerConfig.preferences(context).getBoolean("mobile_trust_bootstrap_" + serverKey(context), false);
    }

    // 현재 origin의 자동 로그인 시도를 기록해 페이지 완료 때 무한 재로그인을 막는다.
    private static void markBootstrapAttempted(Context context) throws Exception {
        ServerConfig.preferences(context).edit().putBoolean("mobile_trust_bootstrap_" + serverKey(context), true).apply();
    }

    // 저장된 기기 ID가 현재 서버에서 활성인지 조회한다.
    private static JSONObject deviceStatus(AuthenticatedApiClient.Session session, String deviceId) throws Exception {
        AuthenticatedApiClient.Response response = AuthenticatedApiClient.request(session, "/api/mobile/trust?deviceId=" + deviceId, "GET", null);
        return response.status == 200 ? response.json() : null;
    }

    // 앱 공개키로 같은 사용자에게 이미 등록된 현재 서버 기기를 다시 찾는다.
    private static JSONObject resolveDevice(AuthenticatedApiClient.Session session, KeyPair keyPair) throws Exception {
        JSONObject body = new JSONObject();
        body.put("publicKey", Base64.encodeToString(keyPair.getPublic().getEncoded(), Base64.NO_WRAP));
        AuthenticatedApiClient.Response response = AuthenticatedApiClient.request(session, "/api/mobile/trust/resolve", "POST", body);
        if (response.status != 200) throw new IllegalStateException(errorMessage(response, "등록된 앱 기기를 확인하지 못했습니다."));
        return response.json();
    }

    // 서버 오류 JSON에서 사용자에게 표시할 짧은 메시지만 꺼낸다.
    private static String errorMessage(AuthenticatedApiClient.Response response, String fallback) {
        try {
            return response.json().optString("error", fallback);
        } catch (Exception ignored) {
            return fallback;
        }
    }

    // 인증 완료 여부와 사용자 메시지를 Activity 스레드로 전달한다.
    public interface Callback {
        // 비동기 인증 작업의 성공 여부와 사용자 표시 메시지를 전달한다.
        void complete(boolean success, String message);
    }
}
