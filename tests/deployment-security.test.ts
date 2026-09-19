import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { assertDeploymentSecurity, diagnoseDeploymentSecurity } from "../src/server/core/deployment-security";

function config(publicUrl: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return { rootDir: "/tmp/wam", dataDir: "/tmp/wam/data", homeDir: "/tmp", host: "127.0.0.1", port: 4317, publicUrl, allowedRoots: ["/tmp"], sessionTtlHours: 1, runtimeEnabled: false, slack: {}, ntfy: { serverUrl: "https://ntfy.sh" }, ...overrides };
}

describe("배포 보안 진단", () => {
  it("production 외부 HTTP는 차단하고 명시적 비상 허용은 경고로 남긴다", () => {
    const blocked = diagnoseDeploymentSecurity(config("http://wam.example.com"), true);
    expect(blocked.status).toBe("blocked");
    expect(blocked.issues).toContainEqual(expect.objectContaining({ code: "external_http_blocked", severity: "blocker" }));
    expect(() => assertDeploymentSecurity(blocked)).toThrow("external_http_blocked");

    const allowed = diagnoseDeploymentSecurity(config("http://wam.example.com", { allowInsecureHttp: true }), true);
    expect(allowed.status).toBe("warning");
    expect(allowed.issues).toContainEqual(expect.objectContaining({ code: "external_http_explicitly_allowed" }));
    expect(() => assertDeploymentSecurity(allowed)).not.toThrow();
  });

  it("loopback 개발은 안전하고 사설망 production HTTP는 명시 경고한다", () => {
    expect(diagnoseDeploymentSecurity(config("http://127.0.0.1:4317"), false)).toMatchObject({ status: "safe", secureCookie: false, hsts: false });
    const privateHttp = diagnoseDeploymentSecurity(config("http://192.168.1.10:4317"), true);
    expect(privateHttp.status).toBe("warning");
    expect(privateHttp.issues.map((issue) => issue.code)).toContain("private_http_transport");
  });

  it("HTTPS는 Secure cookie/HSTS를 일치시키고 proxy 누락을 경고한다", () => {
    const missing = diagnoseDeploymentSecurity(config("https://wam.example.com"), true);
    expect(missing).toMatchObject({ status: "warning", https: true, secureCookie: true, hsts: true, trustedProxyConfigured: false });
    expect(missing.issues.map((issue) => issue.code)).toContain("https_proxy_untrusted");
    const configured = diagnoseDeploymentSecurity(config("https://wam.example.com", { trustedProxies: ["127.0.0.1/32"] }), true);
    expect(configured).toMatchObject({ status: "safe", trustedProxyConfigured: true });
  });

  it("wildcard·경로·내장 자격증명 PUBLIC_URL을 진단한다", () => {
    expect(diagnoseDeploymentSecurity(config("http://0.0.0.0:4317"), true).issues.map((issue) => issue.code)).toContain("public_url_wildcard");
    expect(diagnoseDeploymentSecurity(config("https://user:pass@example.com/path"), true).status).toBe("blocked");
  });
});
