import type { AppConfig } from "./config";
import { DEFAULT_TRUSTED_NETWORKS, isTrustedNetworkAddress } from "./network";

export interface DeploymentSecurityIssue {
  code: string;
  severity: "warning" | "blocker";
  message: string;
  remediation: string;
}

export interface DeploymentSecurityDiagnostic {
  status: "safe" | "warning" | "blocked";
  publicOrigin: string;
  https: boolean;
  secureCookie: boolean;
  hsts: boolean;
  trustedProxyConfigured: boolean;
  issues: DeploymentSecurityIssue[];
}

function normalizedHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function isLocalHostname(hostname: string, trustedNetworks: string[]): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".lan")) return true;
  return isTrustedNetworkAddress(hostname, trustedNetworks);
}

export function diagnoseDeploymentSecurity(config: AppConfig, production: boolean): DeploymentSecurityDiagnostic {
  const issues: DeploymentSecurityIssue[] = [];
  let parsed: URL;
  try { parsed = new URL(config.publicUrl); }
  catch { parsed = new URL("http://invalid.invalid"); issues.push({ code: "public_url_invalid", severity: "blocker", message: "PUBLIC_URL이 올바른 절대 URL이 아닙니다.", remediation: "WEB_AGENT_MANAGER_PUBLIC_URL을 실제 http(s) origin으로 설정하세요." }); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    issues.push({ code: "public_url_not_origin", severity: "blocker", message: "PUBLIC_URL은 자격증명·경로가 없는 http(s) origin이어야 합니다.", remediation: "예: https://wam.example.com" });
  }
  const hostname = normalizedHostname(parsed);
  const wildcard = ["0.0.0.0", "::"].includes(hostname);
  const trustedNetworks = config.trustedNetworks?.length ? config.trustedNetworks : DEFAULT_TRUSTED_NETWORKS;
  const local = wildcard || isLocalHostname(hostname, trustedNetworks);
  const https = parsed.protocol === "https:";
  if (production && !https && !local) {
    issues.push({
      code: config.allowInsecureHttp ? "external_http_explicitly_allowed" : "external_http_blocked",
      severity: config.allowInsecureHttp ? "warning" : "blocker",
      message: "외부 주소에서 평문 HTTP를 사용하면 비밀번호와 세션 cookie가 노출될 수 있습니다.",
      remediation: "TLS reverse proxy를 두고 PUBLIC_URL을 https://로 설정하세요.",
    });
  } else if (production && !https) {
    issues.push({ code: "private_http_transport", severity: "warning", message: "사설망 HTTP에서는 전송 구간 암호화가 제공되지 않습니다.", remediation: "가능하면 HTTPS 또는 VPN/Tailscale을 사용하세요." });
  }
  if (wildcard) issues.push({ code: "public_url_wildcard", severity: "warning", message: "PUBLIC_URL에 wildcard bind 주소가 사용되어 브라우저의 실제 origin과 다를 수 있습니다.", remediation: "접속에 사용하는 실제 호스트 이름이나 IP를 PUBLIC_URL로 설정하세요." });
  if (https && !(config.trustedProxies?.length)) issues.push({ code: "https_proxy_untrusted", severity: "warning", message: "HTTPS PUBLIC_URL이지만 trusted proxy가 설정되지 않았습니다.", remediation: "TLS proxy의 정확한 주소만 WEB_AGENT_MANAGER_TRUSTED_PROXIES에 등록하세요." });
  const status = issues.some((issue) => issue.severity === "blocker") ? "blocked" : issues.length ? "warning" : "safe";
  return { status, publicOrigin: parsed.origin, https, secureCookie: https, hsts: https, trustedProxyConfigured: !!config.trustedProxies?.length, issues };
}

export function assertDeploymentSecurity(diagnostic: DeploymentSecurityDiagnostic): void {
  const blockers = diagnostic.issues.filter((issue) => issue.severity === "blocker");
  if (blockers.length) throw new Error(`안전하지 않은 배포 설정: ${blockers.map((issue) => issue.code).join(", ")}. ${blockers[0].remediation}`);
}
