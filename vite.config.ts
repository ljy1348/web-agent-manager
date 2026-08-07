import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export const VITE_POLLING_INTERVAL_MS = 1_000;

// 쉼표로 구분한 개발 서버 추가 허용 호스트를 정규화한다.
export function parseAllowedHosts(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(",").map((host) => host.trim()).filter(Boolean))];
}

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "");
  const allowedHosts = parseAllowedHosts(
    process.env.WEB_AGENT_MANAGER_DEV_ALLOWED_HOSTS ?? environment.WEB_AGENT_MANAGER_DEV_ALLOWED_HOSTS,
  );

  return {
    plugins: [react()],
    root: path.resolve(process.cwd(), "src/client"),
    server: {
      allowedHosts,
      // Docker에서도 HMR은 유지하되 상위 dev 스크립트의 300ms 폴링이 Vite 전체 트리에 전파되지 않게 한다.
      watch: { usePolling: process.env.CHOKIDAR_USEPOLLING === "true", interval: VITE_POLLING_INTERVAL_MS },
    },
    build: {
      outDir: path.resolve(process.cwd(), "dist/client"),
      emptyOutDir: true,
    },
  };
});
