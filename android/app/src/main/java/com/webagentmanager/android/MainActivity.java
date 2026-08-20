package com.webagentmanager.android;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.util.Log;
import android.view.WindowInsets;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;

// 기존 web-agent-manager를 안전한 동일-origin WebView로 표시하는 Android 진입 화면이다.
public final class MainActivity extends Activity {
    private static final String TAG = "WebAgentManager";
    private static final int FILE_CHOOSER_REQUEST = 3001;
    private static final int NOTIFICATION_PERMISSION_REQUEST = 3002;
    private static final int STORAGE_PERMISSION_REQUEST = 3003;
    private WebView webView;
    private ValueCallback<Uri[]> fileChooserCallback;
    private FloatingSettingsController settingsController;
    private PendingDownload pendingDownload;

    // WebView와 서버 설정 버튼을 만들고 저장된 서버를 연다.
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.rgb(17, 24, 39));
        getWindow().setNavigationBarColor(Color.rgb(17, 24, 39));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) getWindow().setDecorFitsSystemWindows(false);
        buildContentView();
        configureWebView();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        }
        NotificationHelper.ensureChannel(this);
        // 이 액티비티는 회전 등 설정 변경을 configChanges로 흡수하므로, state가 있는 채로
        // onCreate가 다시 불렸다는 것은 파일 선택기 대기 등으로 백그라운드에 있는 동안 시스템이
        // 메모리 회수로 프로세스를 죽였다가 재생성했다는 뜻이다. 이때 저장된 WebView 상태를
        // 복원해 로그인 화면이 아니라 원래 보던 채팅 화면으로 돌아가게 한다.
        if (state != null && webView.restoreState(state) != null) return;
        String baseUrl = ServerConfig.getBaseUrl(this);
        if (baseUrl.isEmpty()) showServerDialog(true);
        else webView.loadUrl(baseUrl);
    }

    // 화면 회전 등으로 액티비티가 재생성되거나 시스템이 프로세스를 회수하기 전에 WebView의
    // 현재 URL·스크롤·폼 상태를 저장해 onCreate에서 복원할 수 있게 한다.
    @Override
    protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        webView.saveState(state);
    }

    // 안전 영역 WebView 위에 이동·숨김 가능한 서버 설정 버튼을 배치한다.
    private void buildContentView() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(17, 24, 39));
        applySystemInsets(root);
        webView = new WebView(this);
        root.addView(webView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        settingsController = new FloatingSettingsController(this, root, () -> showServerDialog(false));
        setContentView(root);
    }

    // 시스템 바·컷아웃·화면 키보드의 실제 영역만큼 WebView 가용 화면을 줄인다.
    private void applySystemInsets(FrameLayout root) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return;
        root.setOnApplyWindowInsetsListener((view, windowInsets) -> {
            Insets systemInsets = windowInsets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            Insets keyboardInsets = windowInsets.getInsets(WindowInsets.Type.ime());
            view.setPadding(
                    systemInsets.left,
                    systemInsets.top,
                    systemInsets.right,
                    Math.max(systemInsets.bottom, keyboardInsets.bottom)
            );
            if (settingsController != null) settingsController.reposition();
            return WindowInsets.CONSUMED;
        });
        root.requestApplyInsets();
    }

    // WebView 저장소·쿠키·파일 선택·다운로드와 외부 링크 경계를 구성한다.
    private void configureWebView() {
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setBuiltInZoomControls(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) settings.setSafeBrowsingEnabled(true);
        webView.setWebViewClient(new WebViewClient() {
            // 설정 서버 밖의 링크는 시스템 브라우저로 보내 WebView 권한 경계를 유지한다.
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return openExternalWhenNeeded(request.getUrl());
            }

            // 구형 콜백에서도 같은 origin 정책을 적용한다.
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return openExternalWhenNeeded(Uri.parse(url));
            }

            // 로그인 뒤 쿠키가 생기면 앱 기기 인증·위젯·FCM 등록을 재시도한다.
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (!ServerConfig.isInsideServer(ServerConfig.getBaseUrl(MainActivity.this), url)) return;
                CookieManager.getInstance().flush();
                AppTrustManager.sync(MainActivity.this, (success, message) -> runOnUiThread(() -> {
                    if (success && !isFinishing()) webView.reload();
                }));
                UsageWidgetProvider.requestRefresh(MainActivity.this);
                PushRegistration.sync(MainActivity.this);
                requestNotificationPermissionIfNeeded();
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            // 웹 파일 첨부 버튼을 Android 문서 선택기로 연결한다.
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileChooserCallback != null) fileChooserCallback.onReceiveValue(null);
                fileChooserCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), FILE_CHOOSER_REQUEST);
                    return true;
                } catch (RuntimeException error) {
                    fileChooserCallback = null;
                    Toast.makeText(MainActivity.this, "파일 선택기를 열 수 없습니다.", Toast.LENGTH_SHORT).show();
                    return false;
                }
            }
        });
        webView.setDownloadListener(this::startDownload);
    }

    // 동일 서버 링크는 WebView에 남기고 그 밖의 링크는 외부 앱으로 연다.
    private boolean openExternalWhenNeeded(Uri uri) {
        String baseUrl = ServerConfig.getBaseUrl(this);
        if (ServerConfig.isInsideServer(baseUrl, uri.toString())) return false;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (RuntimeException error) {
            Toast.makeText(this, "링크를 열 앱이 없습니다.", Toast.LENGTH_SHORT).show();
        }
        return true;
    }

    // 인증 쿠키를 포함한 동일 서버 파일을 Android 다운로드 관리자로 넘긴다.
    private void startDownload(String url, String userAgent, String contentDisposition, String mimeType, long contentLength) {
        String baseUrl = ServerConfig.getBaseUrl(this);
        if (!ServerConfig.isInsideServer(baseUrl, url)) {
            openExternalWhenNeeded(Uri.parse(url));
            return;
        }
        PendingDownload download = new PendingDownload(url, userAgent, contentDisposition, mimeType);
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            pendingDownload = download;
            requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, STORAGE_PERMISSION_REQUEST);
            return;
        }
        enqueueDownload(download);
    }

    // 인증 헤더와 공용 Downloads 경로를 적용해 시스템 다운로드 관리자에 파일을 등록한다.
    private void enqueueDownload(PendingDownload download) {
        String baseUrl = ServerConfig.getBaseUrl(this);
        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(download.url));
            String cookies = CookieManager.getInstance().getCookie(baseUrl);
            if (cookies != null) request.addRequestHeader("Cookie", cookies);
            if (download.userAgent != null && !download.userAgent.isEmpty()) request.addRequestHeader("User-Agent", download.userAgent);
            if (download.mimeType != null && !download.mimeType.isEmpty()) request.setMimeType(download.mimeType);
            String filename = URLUtil.guessFileName(download.url, download.contentDisposition, download.mimeType);
            request.setTitle(filename);
            request.setDescription("웹 에이전트 관리자에서 다운로드");
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename);
            ((DownloadManager) getSystemService(DOWNLOAD_SERVICE)).enqueue(request);
            Toast.makeText(this, "다운로드 시작: 내 파일 > 다운로드 > " + filename, Toast.LENGTH_LONG).show();
        } catch (RuntimeException error) {
            Toast.makeText(this, "다운로드를 시작하지 못했습니다.", Toast.LENGTH_SHORT).show();
        }
    }

    // 첫 실행 또는 설정 버튼에서 서버 주소 입력 대화상자를 연다.
    private void showServerDialog(boolean required) {
        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setHint("https://agent.example.com");
        input.setText(ServerConfig.getBaseUrl(this));
        input.setSelectAllOnFocus(true);
        int padding = dp(20);
        LinearLayout wrapper = new LinearLayout(this);
        wrapper.setOrientation(LinearLayout.VERTICAL);
        wrapper.setPadding(padding, dp(4), padding, 0);
        wrapper.addView(input, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        Button trustButton = new Button(this);
        trustButton.setText("이 기기 앱 인증");
        trustButton.setEnabled(!ServerConfig.getBaseUrl(this).isEmpty());
        LinearLayout.LayoutParams trustParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        trustParams.setMargins(0, dp(10), 0, 0);
        wrapper.addView(trustButton, trustParams);
        Button revokeTrustButton = new Button(this);
        revokeTrustButton.setText("이 기기 인증 해제");
        revokeTrustButton.setEnabled(AppTrustManager.hasRegistration(this));
        wrapper.addView(revokeTrustButton, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        AlertDialog.Builder builder = new AlertDialog.Builder(this)
                .setTitle("web-agent-manager 서버")
                .setMessage("내부망에서 관리자 로그인 후 기기를 인증하면 외부망에서도 내부망 기능을 사용할 수 있습니다.")
                .setView(wrapper)
                .setPositiveButton("연결", null)
                .setNegativeButton(required ? "앱 종료" : "취소", (target, which) -> { if (required) finish(); })
                .setCancelable(!required);
        if (!required) builder.setNeutralButton("설정 버튼 숨기기", null);
        AlertDialog dialog = builder.create();
        dialog.setOnShowListener(ignored -> {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
                try {
                    ServerConfig.setBaseUrl(this, input.getText().toString());
                    AppTrustManager.prepareServerConnection(this);
                    dialog.dismiss();
                    webView.loadUrl(ServerConfig.getBaseUrl(this));
                    UsageWidgetProvider.requestRefresh(this);
                } catch (IllegalArgumentException error) {
                    input.setError(error.getMessage());
                }
            });
            if (!required) dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(view -> {
                dialog.dismiss();
                settingsController.collapse();
            });
        });
        trustButton.setOnClickListener(view -> {
            trustButton.setEnabled(false);
            AppTrustManager.enroll(this, (success, message) -> runOnUiThread(() -> {
                if (isFinishing()) return;
                trustButton.setEnabled(true);
                Toast.makeText(this, message, Toast.LENGTH_LONG).show();
                if (success) {
                    dialog.dismiss();
                    webView.reload();
                }
            }));
        });
        revokeTrustButton.setOnClickListener(view -> {
            revokeTrustButton.setEnabled(false);
            AppTrustManager.revoke(this, (success, message) -> runOnUiThread(() -> {
                if (isFinishing()) return;
                revokeTrustButton.setEnabled(!success);
                Toast.makeText(this, message, Toast.LENGTH_LONG).show();
                if (success) {
                    dialog.dismiss();
                    webView.reload();
                }
            }));
        });
        dialog.show();
    }

    // Android 13 이상에서 FCM 알림 표시 권한을 한 번 요청한다.
    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION_REQUEST);
        }
    }

    // Android 9 이하 저장소 권한 결과에 따라 보류한 다운로드를 시작하거나 취소한다.
    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != STORAGE_PERMISSION_REQUEST) return;
        PendingDownload download = pendingDownload;
        pendingDownload = null;
        if (download != null && grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            enqueueDownload(download);
        } else {
            Toast.makeText(this, "다운로드 폴더 저장 권한이 필요합니다.", Toast.LENGTH_LONG).show();
        }
    }

    // 파일 선택기 결과를 WebChromeClient 콜백으로 돌려준다.
    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER_REQUEST) return;
        if (fileChooserCallback == null) {
            // 파일 선택기가 떠 있는 동안 시스템이 메모리 회수로 이 액티비티를 종료했다가 재생성한
            // 경우다. 콜백 필드는 인스턴스 상태라 프로세스가 죽으면 복구할 수 없어 파일 선택은
            // 조용히 무시된다 — 원인을 모른 채 "그냥 안 된다"로 보이지 않도록 로그를 남기고
            // 사용자에게 재시도를 안내한다.
            Log.w(TAG, "파일 선택 콜백 유실: requestCode=" + requestCode + " resultCode=" + resultCode
                    + " — 파일 선택기 대기 중 앱 프로세스가 재시작되어 이전 선택 요청과 연결할 콜백이 없습니다.");
            Toast.makeText(this, "파일 선택이 처리되지 못했습니다(앱이 재시작됨). 다시 시도해 주세요.", Toast.LENGTH_LONG).show();
            return;
        }
        fileChooserCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
        fileChooserCallback = null;
    }

    // Android 12 이하의 뒤로가기도 같은 WebView 기록 정책으로 처리한다.
    @SuppressLint("GestureBackNavigation")
    @Override
    public void onBackPressed() {
        handleBack();
    }

    // 웹 기록이 있으면 먼저 이동하고 없을 때만 Activity를 닫는다.
    private void handleBack() {
        if (webView.canGoBack()) webView.goBack();
        else finish();
    }

    // WebView 자원을 Activity 종료 시 해제한다.
    @Override
    protected void onDestroy() {
        if (webView != null) webView.destroy();
        super.onDestroy();
    }

    // dp 단위를 현재 화면 픽셀로 변환한다.
    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    // 권한 승인 뒤 동일 요청을 재개할 다운로드 메타데이터를 보관한다.
    private static final class PendingDownload {
        final String url;
        final String userAgent;
        final String contentDisposition;
        final String mimeType;

        // WebView DownloadListener가 전달한 요청 정보를 불변 값으로 묶는다.
        PendingDownload(String url, String userAgent, String contentDisposition, String mimeType) {
            this.url = url;
            this.userAgent = userAgent;
            this.contentDisposition = contentDisposition;
            this.mimeType = mimeType;
        }
    }
}
