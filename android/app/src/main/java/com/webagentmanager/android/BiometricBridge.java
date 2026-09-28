package com.webagentmanager.android;

import android.app.Activity;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.CancellationSignal;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;

// 웹 본인 확인 안내창이 지문으로 서버 challenge를 서명할 수 있게 하는 WebView JS 브리지.
// HTTP 요청은 웹 api()가 CSRF와 함께 보내고, 이 브리지는 Keystore 서명만 돌려준다.
public final class BiometricBridge {
    public static final String JS_NAME = "WamAndroidBiometric";
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "wam_biometric_reauth";

    private final Activity activity;
    private final WebView webView;

    public BiometricBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
    }

    // 이 기기에서 강한 생체인증 키를 쓸 수 있는지 동기로 알려준다(API 30 미만은 미지원).
    @JavascriptInterface
    public boolean isAvailable() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return false;
        BiometricManager manager = activity.getSystemService(BiometricManager.class);
        return manager != null && manager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS;
    }

    // 새 지문 키를 만들고 기존 기기 키로 "공개키+challenge"를 서명해 같은 기기임을 증명한다.
    @JavascriptInterface
    public void prepareEnrollment(String challenge, String callbackId) {
        activity.runOnUiThread(() -> {
            if (!allowed(callbackId)) return;
            try {
                if (!isAvailable()) throw new IllegalStateException("이 기기에서는 지문 본인 확인을 쓸 수 없습니다. 지문이 등록되어 있는지 확인해주세요.");
                String publicKey = createKey();
                String signature = AppTrustManager.signChallenge("wam-biometric-enroll-v1\n" + challenge + "\n" + publicKey);
                JSONObject result = new JSONObject();
                result.put("ok", true);
                result.put("publicKey", publicKey);
                result.put("signature", signature);
                deliver(callbackId, result);
            } catch (Exception error) {
                deliverError(callbackId, "error", error.getMessage() == null ? "지문 키를 만들지 못했습니다." : error.getMessage());
            }
        });
    }

    // 지문 확인 창을 띄우고, 성공하면 지문 키로 본인 확인 challenge를 서명한다.
    @JavascriptInterface
    public void signReauth(String challenge, String callbackId) {
        activity.runOnUiThread(() -> {
            if (!allowed(callbackId)) return;
            Signature signature;
            try {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) throw new IllegalStateException("Android 11 이상에서만 지문 본인 확인을 쓸 수 있습니다.");
                KeyStore keyStore = KeyStore.getInstance(KEYSTORE);
                keyStore.load(null);
                PrivateKey key = (PrivateKey) keyStore.getKey(KEY_ALIAS, null);
                if (key == null) { deliverError(callbackId, "missing", "이 기기의 지문 키가 없습니다. 설정에서 다시 등록해주세요."); return; }
                signature = Signature.getInstance("SHA256withECDSA");
                signature.initSign(key);
            } catch (KeyPermanentlyInvalidatedException invalidated) {
                deleteKey();
                deliverError(callbackId, "invalidated", "지문 정보가 바뀌어 지문 키가 무효화됐습니다. 비밀번호로 확인한 뒤 다시 등록해주세요.");
                return;
            } catch (Exception error) {
                deliverError(callbackId, "error", error.getMessage() == null ? "지문 본인 확인을 시작하지 못했습니다." : error.getMessage());
                return;
            }
            BiometricPrompt prompt = new BiometricPrompt.Builder(activity)
                    .setTitle("본인 확인")
                    .setSubtitle("중요 작업을 계속하려면 지문으로 확인하세요")
                    .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                    .setNegativeButton("취소", activity.getMainExecutor(), (dialog, which) -> deliverError(callbackId, "cancelled", "지문 본인 확인을 취소했습니다."))
                    .build();
            prompt.authenticate(new BiometricPrompt.CryptoObject(signature), new CancellationSignal(), activity.getMainExecutor(), new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                    try {
                        Signature signer = result.getCryptoObject().getSignature();
                        signer.update(("wam-biometric-reauth-v1\n" + challenge).getBytes(StandardCharsets.UTF_8));
                        JSONObject payload = new JSONObject();
                        payload.put("ok", true);
                        payload.put("signature", Base64.encodeToString(signer.sign(), Base64.NO_WRAP));
                        deliver(callbackId, payload);
                    } catch (Exception error) {
                        deliverError(callbackId, "error", "지문 서명에 실패했습니다.");
                    }
                }

                @Override
                public void onAuthenticationError(int errorCode, CharSequence message) {
                    boolean cancelled = errorCode == BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED || errorCode == BiometricPrompt.BIOMETRIC_ERROR_CANCELED;
                    deliverError(callbackId, cancelled ? "cancelled" : "error", message == null ? "지문 본인 확인에 실패했습니다." : message.toString());
                }
            });
        });
    }

    // 서버에서 지문 등록을 해제할 때 기기에 남은 지문 키도 지운다.
    @JavascriptInterface
    public void removeKey() {
        activity.runOnUiThread(() -> {
            if (currentPageInsideServer()) deleteKey();
        });
    }

    // 설정 서버 밖 페이지가 브리지를 호출하면 서명하지 않고 거부한다.
    private boolean allowed(String callbackId) {
        if (currentPageInsideServer()) return true;
        deliverError(callbackId, "forbidden", "설정된 서버 페이지에서만 지문 본인 확인을 쓸 수 있습니다.");
        return false;
    }

    // WebView의 현재 주소가 설정된 서버 안인지 UI 스레드에서 확인한다.
    private boolean currentPageInsideServer() {
        String url = webView.getUrl();
        return url != null && ServerConfig.isInsideServer(ServerConfig.getBaseUrl(activity), url);
    }

    // 매 사용마다 강한 생체인증이 필요하고 지문 추가 시 무효화되는 P-256 키를 새로 만든다.
    private static String createKey() throws Exception {
        deleteKey();
        KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE);
        generator.initialize(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(true)
                .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
                .setInvalidatedByBiometricEnrollment(true)
                .build());
        return Base64.encodeToString(generator.generateKeyPair().getPublic().getEncoded(), Base64.NO_WRAP);
    }

    // 지문 키를 Keystore에서 지운다. 없으면 아무것도 하지 않는다.
    private static void deleteKey() {
        try {
            KeyStore keyStore = KeyStore.getInstance(KEYSTORE);
            keyStore.load(null);
            if (keyStore.containsAlias(KEY_ALIAS)) keyStore.deleteEntry(KEY_ALIAS);
        } catch (Exception ignored) {
            // 삭제 실패는 다음 등록 때 같은 별칭을 덮어쓰며 정리된다.
        }
    }

    // 실패 결과를 코드와 문구로 웹에 전달한다.
    private void deliverError(String callbackId, String code, String message) {
        try {
            JSONObject result = new JSONObject();
            result.put("ok", false);
            result.put("code", code);
            result.put("message", message);
            deliver(callbackId, result);
        } catch (Exception ignored) {
            // JSONObject 문자열 입력은 실패하지 않는다.
        }
    }

    // 웹이 등록한 콜백으로 결과 JSON을 넘긴다.
    private void deliver(String callbackId, JSONObject result) {
        activity.runOnUiThread(() -> {
            if (activity.isFinishing()) return;
            webView.evaluateJavascript("window.__wamBiometricCallback&&window.__wamBiometricCallback(" + JSONObject.quote(callbackId) + "," + result + ")", null);
        });
    }
}
