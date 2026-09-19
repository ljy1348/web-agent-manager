import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface WidgetUsage {
  label: string;
  usedPercent: number;
  resetAt: string;
}

// WidgetSnapshot.fromJson과 같은 규칙으로 서버 위젯 JSON을 표시용 값으로 바꾼다.
function displayLabel(provider: string): string {
  if (provider === "claude") return "Claude";
  if (provider === "codex") return "Codex";
  if (provider === "grok") return "Grok";
  return provider;
}

// 위젯 프로그레스 범위에 맞게 0~100으로 제한하고 미확인 값 -1은 보존한다.
function clamp(value: number): number {
  return value < 0 ? -1 : Math.min(100, value);
}

// 서버의 usage 배열을 필터 없이 보관하고 claude·codex·grok 별칭도 채운다.
function parseWidgetSnapshot(json: string): { usages: WidgetUsage[]; claude: WidgetUsage; codex: WidgetUsage; grok: WidgetUsage } {
  const root = JSON.parse(json) as {
    usage?: Array<{ provider?: string; windowLabel?: string | null; usedPercent?: number | null; resetAt?: string | null }>;
  };
  const usages: WidgetUsage[] = [];
  let claude: WidgetUsage = { label: "Claude", usedPercent: -1, resetAt: "" };
  let codex: WidgetUsage = { label: "Codex", usedPercent: -1, resetAt: "" };
  let grok: WidgetUsage = { label: "Grok", usedPercent: -1, resetAt: "" };
  for (const row of root.usage ?? []) {
    const provider = row.provider ?? "";
    const percent = row.usedPercent == null ? -1 : clamp(Math.round(Number(row.usedPercent)));
    const resetAt = row.resetAt == null ? "" : String(row.resetAt);
    const label = `${displayLabel(provider)}${row.windowLabel ? ` · ${row.windowLabel}` : ""}`;
    const parsed = { label, usedPercent: percent, resetAt };
    usages.push(parsed);
    if (provider === "claude" && claude.usedPercent < 0) claude = parsed;
    if (provider === "codex" && codex.usedPercent < 0) codex = parsed;
    if (provider === "grok" && grok.usedPercent < 0) grok = parsed;
  }
  return { usages, claude, codex, grok };
}

describe("Android 위젯 스냅샷 파싱", () => {
  it("서버가 준 grok 사용량 행을 버리지 않는다", () => {
    const parsed = parseWidgetSnapshot(JSON.stringify({
      usage: [
        { provider: "claude", windowLabel: "5시간", usedPercent: 37, resetAt: "18:00" },
        { provider: "codex", windowLabel: "5시간", usedPercent: 12, resetAt: "내일" },
        { provider: "grok", windowLabel: "주간", usedPercent: 16, resetAt: "13:23" },
      ],
    }));
    expect(parsed.usages).toHaveLength(3);
    expect(parsed.grok).toEqual({ label: "Grok · 주간", usedPercent: 16, resetAt: "13:23" });
    expect(parsed.usages.map((row) => row.label)).toEqual(["Claude · 5시간", "Codex · 5시간", "Grok · 주간"]);
  });

  it("Java fromJson이 grok 행을 배열과 별칭으로 보관한다", () => {
    const source = readFileSync("android/app/src/main/java/com/webagentmanager/android/WidgetSnapshot.java", "utf8");
    expect(source).toContain("Usage[] usages");
    expect(source).toContain('provider.equals("grok")');
    expect(source).toContain("Grok");
    expect(source).toContain("windowLabel");
    expect(source).toMatch(/rows\.add\(|list\.add\(/);
  });

  it("1×1 스택 항목 수가 2로 고정되지 않고 usages 길이를 따른다", () => {
    const source = readFileSync("android/app/src/main/java/com/webagentmanager/android/WidgetStackService.java", "utf8");
    expect(source).not.toMatch(/public int getCount\(\)\s*\{\s*return 2;\s*\}/);
    expect(source).toContain("usages.length");
  });
});
