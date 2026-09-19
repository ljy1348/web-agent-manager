package com.webagentmanager.android;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;

// 위젯에 필요한 공급자 사용량과 CPU·메모리 비율만 보관한다.
public final class WidgetSnapshot {
    // 공급자 한 개의 표시 이름·사용률·초기화 시각을 보관한다.
    public static final class Usage {
        public final String label;
        public final int usedPercent;
        public final String resetAt;

        // 공급자 한 개의 표시용 사용량을 만든다.
        Usage(String label, int usedPercent, String resetAt) {
            this.label = label;
            this.usedPercent = usedPercent;
            this.resetAt = resetAt;
        }
    }

    public final Usage[] usages;
    public final Usage claude;
    public final Usage codex;
    public final Usage grok;
    public final int cpuPercent;
    public final int memoryPercent;
    public final String capturedAt;

    // 파싱된 위젯 스냅샷을 하나의 불변 값으로 만든다.
    private WidgetSnapshot(Usage[] usages, Usage claude, Usage codex, Usage grok, int cpuPercent, int memoryPercent, String capturedAt) {
        this.usages = usages;
        this.claude = claude;
        this.codex = codex;
        this.grok = grok;
        this.cpuPercent = cpuPercent;
        this.memoryPercent = memoryPercent;
        this.capturedAt = capturedAt;
    }

    // 서버의 모바일 위젯 JSON 응답에서 표시용 값을 추출한다. 공급자를 버리지 않고 전부 보관한다.
    public static WidgetSnapshot fromJson(String json) throws Exception {
        JSONObject root = new JSONObject(json);
        ArrayList<Usage> rows = new ArrayList<>();
        Usage claude = new Usage("Claude", -1, "");
        Usage codex = new Usage("Codex", -1, "");
        Usage grok = new Usage("Grok", -1, "");
        JSONArray usageRows = root.optJSONArray("usage");
        if (usageRows != null) {
            for (int index = 0; index < usageRows.length(); index += 1) {
                JSONObject row = usageRows.getJSONObject(index);
                String provider = row.optString("provider");
                String windowLabel = row.optString("windowLabel");
                int percent = row.isNull("usedPercent") ? -1 : (int) Math.round(row.optDouble("usedPercent"));
                String resetAt = row.isNull("resetAt") ? "" : row.optString("resetAt");
                String label = displayLabel(provider) + (windowLabel.isEmpty() ? "" : " · " + windowLabel);
                Usage parsed = new Usage(label, clamp(percent), resetAt);
                rows.add(parsed);
                if (provider.equals("claude") && claude.usedPercent < 0) claude = parsed;
                if (provider.equals("codex") && codex.usedPercent < 0) codex = parsed;
                if (provider.equals("grok") && grok.usedPercent < 0) grok = parsed;
            }
        }
        JSONObject system = root.optJSONObject("system");
        int cpu = system == null || system.isNull("cpuPercent") ? -1 : clamp((int) Math.round(system.optDouble("cpuPercent")));
        int memory = system == null || system.isNull("memoryUsedPercent") ? -1 : clamp((int) Math.round(system.optDouble("memoryUsedPercent")));
        return new WidgetSnapshot(rows.toArray(new Usage[0]), claude, codex, grok, cpu, memory, root.optString("capturedAt", ""));
    }

    // 알려진 공급자 id를 위젯 표시 이름으로 바꾼다.
    private static String displayLabel(String provider) {
        if (provider.equals("claude")) return "Claude";
        if (provider.equals("codex")) return "Codex";
        if (provider.equals("grok")) return "Grok";
        return provider;
    }

    // 위젯 프로그레스 범위에 맞게 0~100으로 제한하고 미확인 값 -1은 보존한다.
    private static int clamp(int value) {
        return value < 0 ? -1 : Math.min(100, value);
    }
}
