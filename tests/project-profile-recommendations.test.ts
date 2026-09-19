import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registeredProjectProfileRecommendation } from "../src/server/services/project-profile-recommendations";

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

function project(files: string[] = []): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-profile-recommendation-")); roots.push(root);
  for (const relative of files) {
    const target = path.join(root, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, "fixture");
  }
  return root;
}

describe("등록 프로젝트 맞춤 profile 추천", () => {
  it("현재 활성 8개 프로젝트에 서로 다른 검증·보호 경계를 제안한다", () => {
    const rows = [
      ["WSS-Server", project(["gradlew"]), [], "wss-server-spring", "./gradlew", "production_database"],
      ["WSS-admin-web", project(), ["test", "build"], "wss-admin-fullstack", "npm", "external_mysql"],
      ["myagent", project(), ["verify", "test:ui"], "wam-provider-runtime", "npm", "tmux_or_cli_stop"],
      ["geulmeok-frontend", project(), ["build"], "geulmeok-react-ui", "npm", "gocd_deploy"],
      ["geulmeok-scrap", project(["pyproject.toml"]), [], "geulmeok-fixture-scraper", null, "live_scrape"],
      ["resume", project(["job-automation/package.json"]), [], "resume-evidence-writing", "npm", "personal_data_write"],
      ["스터디", project(), [], "study-single-agent-tutor", null, "curriculum_change"],
      ["genshincalculator", project(), ["test", "typecheck"], "genshin-simulation-safe", "npm", "full_benchmark"],
    ] as const;
    for (const [name, root, scripts, id, command, protectedAction] of rows) {
      const recommendation = registeredProjectProfileRecommendation(name, root, [...scripts]);
      expect(recommendation?.id).toBe(id);
      expect(recommendation?.verificationSteps.length).toBeGreaterThan(0);
      expect(recommendation?.protectedActions).toContain(protectedAction);
      if (command) expect(recommendation?.verificationSteps.some((step) => step.argv?.[0] === command)).toBe(true);
    }
    expect(registeredProjectProfileRecommendation("unknown", project(), [])).toBeNull();
  });

  it("wrapper나 필수 script가 사라지면 실행 명령을 추측하지 않고 경고한다", () => {
    const gradle = registeredProjectProfileRecommendation("WSS-Server", project(), []);
    expect(gradle?.verificationSteps).toEqual([]);
    expect(gradle?.warnings).toContain("맞춤 검증 wrapper 없음: gradlew");
    const wam = registeredProjectProfileRecommendation("myagent", project(), ["test"]);
    expect(wam?.verificationSteps).toEqual([]);
    expect(wam?.warnings).toContain("맞춤 verify/test:ui script 확인 필요");
  });
});
