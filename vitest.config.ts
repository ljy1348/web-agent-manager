import { defineConfig } from "vitest/config";

// Codex의 timezone 없는 reset 문구는 WAM 운영 호스트의 Asia/Seoul 현지 시각이다.
// CI runner의 UTC 기본값에 따라 날짜 경계 테스트가 달라지지 않게 테스트 시간대를 고정한다.
process.env.TZ = "Asia/Seoul";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
