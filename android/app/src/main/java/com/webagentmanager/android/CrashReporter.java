package com.webagentmanager.android;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.os.Build;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

// 처리되지 않은 예외의 스택을 저장했다가 다음 실행에서 로그인 세션으로 서버 클라이언트 로그에 보낸다.
// 폰이 서버에 연결돼 있지 않아도 크래시 원인을 확인하기 위한 장치다.
public final class CrashReporter {
    private static final String PREFS = "web_agent_manager_crash";
    private static final String KEY_REPORT = "pending_report";
    private static final String KEY_COUNT = "pending_count";
    // 서버 클라이언트 로그가 메시지를 4000자에서 자르므로 머리말을 뺀 스택을 그 안으로 맞춘다.
    private static final int MAX_STACK_LENGTH = 3600;
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();
    private static boolean installed;

    private CrashReporter() {}

    // 기존 처리기(시스템 크래시 처리)를 유지한 채 앞단에서 스택을 저장한다. 여러 번 호출돼도 한 번만 설치한다.
    public static synchronized void install(Context context) {
        if (installed) return;
        installed = true;
        Context appContext = context.getApplicationContext();
        Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            try {
                save(appContext, thread, error);
            } catch (Throwable ignored) {
                // 기록 실패가 원래 크래시 처리를 막으면 안 된다.
            }
            if (previous != null) previous.uncaughtException(thread, error);
        });
    }

    // 프로세스가 곧 끝나므로 apply가 아닌 commit으로 즉시 기록한다. 최신 크래시만 남기고 횟수는 누적한다.
    @SuppressLint("ApplySharedPref")
    private static void save(Context context, Thread thread, Throwable error) {
        StringWriter stack = new StringWriter();
        error.printStackTrace(new PrintWriter(stack));
        String trace = stack.toString();
        if (trace.length() > MAX_STACK_LENGTH) trace = trace.substring(0, MAX_STACK_LENGTH) + "…";
        String report = "Android 앱 크래시 " + appVersion(context)
                + " at=" + isoNow()
                + " thread=" + thread.getName()
                + " device=" + Build.MANUFACTURER + " " + Build.MODEL + " sdk=" + Build.VERSION.SDK_INT
                + "\n" + trace;
        SharedPreferences preferences = preferences(context);
        preferences.edit()
                .putString(KEY_REPORT, report)
                .putInt(KEY_COUNT, preferences.getInt(KEY_COUNT, 0) + 1)
                .commit();
    }

    // 저장된 크래시가 있으면 로그인 세션으로 /api/logs/client에 보내고, 성공하면 지운다.
    public static void flush(Context context) {
        Context appContext = context.getApplicationContext();
        String report = preferences(appContext).getString(KEY_REPORT, "");
        if (report.isEmpty()) return;
        EXECUTOR.execute(() -> {
            try {
                int count = preferences(appContext).getInt(KEY_COUNT, 1);
                JSONObject entry = new JSONObject();
                entry.put("at", isoNow());
                entry.put("level", "error");
                entry.put("scope", "android-crash");
                entry.put("message", "누적 " + count + "회 · " + report);
                JSONObject body = new JSONObject();
                body.put("entries", new JSONArray().put(entry));
                AuthenticatedApiClient.Session session = AuthenticatedApiClient.current(appContext);
                if (AuthenticatedApiClient.request(session, "/api/logs/client", "POST", body).status == 204) {
                    preferences(appContext).edit().remove(KEY_REPORT).remove(KEY_COUNT).apply();
                }
            } catch (Exception ignored) {
                // 로그인 전·네트워크 실패면 다음 페이지 로드에서 다시 보낸다.
            }
        });
    }

    // 로그인 전에 앱이 죽으면 서버로 보낼 수 없으므로, 다음 실행 때 저장된 스택을 팝업으로 보여주고 복사하게 한다.
    // 서버 전송(flush)이 성공하면 기록이 지워지므로 팝업은 전송 전까지만 뜬다.
    public static void showPendingIfAny(Activity activity) {
        String report = preferences(activity).getString(KEY_REPORT, "");
        if (report.isEmpty()) return;
        new AlertDialog.Builder(activity)
                .setTitle("이전 실행에서 앱이 종료됐습니다")
                .setMessage(report)
                .setPositiveButton("복사", (dialog, which) -> {
                    ClipboardManager clipboard = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
                    if (clipboard != null) clipboard.setPrimaryClip(ClipData.newPlainText("crash", report));
                    Toast.makeText(activity, "크래시 내용을 복사했습니다", Toast.LENGTH_SHORT).show();
                })
                .setNegativeButton("닫기", null)
                .show();
    }

    // minSdk 23에서 java.time을 쓸 수 없어 SimpleDateFormat으로 UTC ISO 시각을 만든다.
    private static String isoNow() {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date());
    }

    // AGP 9는 BuildConfig를 기본 생성하지 않으므로 설치된 패키지 정보에서 버전을 읽는다.
    @SuppressWarnings("deprecation")
    private static String appVersion(Context context) {
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            long code = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode;
            return info.versionName + "(" + code + ")";
        } catch (Exception error) {
            return "unknown";
        }
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
