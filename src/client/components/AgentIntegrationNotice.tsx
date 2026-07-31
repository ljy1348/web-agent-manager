import React, { useEffect, useState } from "react";
import { Plug, RefreshCw } from "lucide-react";
import { api } from "../api";
import type { Json } from "../types";

interface AgentIntegrationStatus {
  provider: "codex" | "claude";
  cliInstalled: boolean;
  version: string | null;
  skillsInstalled: boolean;
  mcpInstalled: boolean;
  ready: boolean;
}

const PROVIDER_LABELS = { codex: "Codex", claude: "Claude" } as const;

// 새로 설치된 Codex·Claude를 감지해 관리자에게 web-agent-manager 연동 버튼을 제공한다.
export function AgentIntegrationNotice({ user }: { user: Json }): React.ReactElement | null {
  const [integrations, setIntegrations] = useState<AgentIntegrationStatus[]>([]);
  const [installing, setInstalling] = useState<AgentIntegrationStatus["provider"] | null>(null);
  const [error, setError] = useState("");

  // 현재 CLI·스킬·MCP 상태를 서버에서 다시 읽는다.
  async function refresh(): Promise<void> {
    const data = await api("/agent-integrations");
    setIntegrations(data.integrations || []);
  }

  useEffect(() => {
    if (user.role !== "admin") return;
    void refresh().catch(() => undefined);
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 60_000);
    const handleVisibility = (): void => {
      if (document.visibilityState === "visible") void refresh().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [user.role]);

  // 선택한 공급자에 전역 스킬과 web-agent-manager MCP를 함께 설치한다.
  async function install(provider: AgentIntegrationStatus["provider"]): Promise<void> {
    setInstalling(provider);
    setError("");
    try {
      await api(`/agent-integrations/${provider}/install`, { method: "POST" });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "연동에 실패했습니다.");
    } finally {
      setInstalling(null);
    }
  }

  if (user.role !== "admin") return null;
  const pending = integrations.filter((item) => item.cliInstalled && !item.ready);
  if (!pending.length && !error) return null;

  return <section className="agent-integration-notice" aria-live="polite">
    <Plug size={18} aria-hidden="true" />
    <div className="agent-integration-copy">
      <strong>에이전트 연동 필요</strong>
      <span>{error || "설치된 에이전트에 web-agent-manager 스킬과 MCP를 연결하세요."}</span>
    </div>
    <div className="agent-integration-actions">
      {pending.map((item) => <button
        key={item.provider}
        type="button"
        disabled={installing !== null}
        title={`${PROVIDER_LABELS[item.provider]} 전역 스킬과 web-agent-manager MCP 설치`}
        onClick={() => void install(item.provider)}
      >
        {installing === item.provider && <RefreshCw className="spin" size={15} aria-hidden="true" />}
        {PROVIDER_LABELS[item.provider]} 연결
      </button>)}
    </div>
  </section>;
}
