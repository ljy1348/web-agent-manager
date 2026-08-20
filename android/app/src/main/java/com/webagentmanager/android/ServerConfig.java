package com.webagentmanager.android;

import android.content.Context;
import android.content.SharedPreferences;

import java.net.URI;
import java.util.Locale;

// WebView·위젯·FCM 등록이 함께 쓰는 서버 주소를 검증하고 보관한다.
public final class ServerConfig {
    private static final String PREFS = "web_agent_manager_settings";
    private static final String KEY_BASE_URL = "base_url";

    private ServerConfig() {}

    // 저장된 서버 기준 URL을 반환한다.
    public static String getBaseUrl(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_BASE_URL, "");
    }

    // 검증된 서버 기준 URL을 마지막 슬래시 없이 저장한다.
    public static void setBaseUrl(Context context, String value) {
        String normalized = normalize(value);
        if (normalized == null) throw new IllegalArgumentException("HTTPS 주소 또는 사설망 HTTP 주소를 입력해주세요.");
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_BASE_URL, normalized).apply();
    }

    // 위젯 데이터 등 앱 공용 상태를 저장하는 환경설정을 반환한다.
    public static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // HTTPS 전체와 사설망·로컬 호스트의 HTTP만 허용해 기준 URL을 정규화한다.
    public static String normalize(String value) {
        try {
            URI uri = URI.create(value.trim());
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
            if (host.isEmpty() || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null) return null;
            if (!scheme.equals("https") && !(scheme.equals("http") && isPrivateHost(host))) return null;
            int port = uri.getPort();
            String authority = host.contains(":") ? "[" + host + "]" : host;
            String path = uri.getPath() == null ? "" : uri.getPath().replaceAll("/+$", "");
            return scheme + "://" + authority + (port >= 0 ? ":" + port : "") + path;
        } catch (RuntimeException error) {
            return null;
        }
    }

    // 링크가 설정된 서버와 같은 origin·기준 경로인지 확인한다.
    public static boolean isInsideServer(String baseUrl, String candidate) {
        try {
            URI base = URI.create(baseUrl);
            URI target = URI.create(candidate);
            int basePort = effectivePort(base);
            int targetPort = effectivePort(target);
            String basePath = base.getPath() == null || base.getPath().isEmpty() ? "/" : base.getPath() + "/";
            String targetPath = target.getPath() == null || target.getPath().isEmpty() ? "/" : target.getPath();
            return base.getScheme().equalsIgnoreCase(target.getScheme())
                    && base.getHost().equalsIgnoreCase(target.getHost())
                    && basePort == targetPort
                    && (targetPath.equals(base.getPath()) || targetPath.startsWith(basePath));
        } catch (RuntimeException error) {
            return false;
        }
    }

    // 기기 로그인 서명에 결합할 서버 origin을 기본 포트가 생략된 형태로 반환한다.
    public static String origin(String baseUrl) {
        URI uri = URI.create(baseUrl);
        String scheme = uri.getScheme().toLowerCase(Locale.ROOT);
        String host = uri.getHost().toLowerCase(Locale.ROOT);
        int port = uri.getPort();
        boolean defaultPort = port < 0 || (scheme.equals("https") && port == 443) || (scheme.equals("http") && port == 80);
        String authority = host.contains(":") ? "[" + host + "]" : host;
        return scheme + "://" + authority + (defaultPort ? "" : ":" + port);
    }

    // URI의 생략된 기본 포트를 실제 비교용 값으로 바꾼다.
    private static int effectivePort(URI uri) {
        if (uri.getPort() >= 0) return uri.getPort();
        return "https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80;
    }

    // 평문 접속을 허용해도 되는 사설 IPv4·로컬 DNS·IPv6 주소인지 판정한다.
    private static boolean isPrivateHost(String host) {
        if (host.equals("localhost") || host.endsWith(".local") || host.endsWith(".lan")) return true;
        if (host.contains(":")) {
            String normalized = host.toLowerCase(Locale.ROOT);
            return normalized.equals("::1") || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb");
        }
        String[] parts = host.split("\\.");
        if (parts.length != 4) return false;
        int[] octets = new int[4];
        try {
            for (int index = 0; index < 4; index += 1) {
                octets[index] = Integer.parseInt(parts[index]);
                if (octets[index] < 0 || octets[index] > 255) return false;
            }
        } catch (NumberFormatException error) {
            return false;
        }
        return octets[0] == 10
                || octets[0] == 127
                || (octets[0] == 169 && octets[1] == 254)
                || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31)
                || (octets[0] == 192 && octets[1] == 168)
                || (octets[0] == 100 && octets[1] >= 64 && octets[1] <= 127);
    }
}
