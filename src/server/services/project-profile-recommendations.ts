import fs from "node:fs";
import path from "node:path";

export interface ProjectProfileVerificationStep {
  kind: "static" | "focused_test" | "full_test" | "build" | "ui" | "contract" | "human_review";
  command?: string;
  argv?: string[];
  required: boolean;
  timeoutMs?: number;
  includePaths?: string[];
}

export interface ProjectProfileRecommendation {
  id: string;
  reasoningEffort?: string;
  verificationSteps: ProjectProfileVerificationStep[];
  protectedActions: string[];
  warnings: string[];
}

function npmStep(scripts: Set<string>, name: string, kind: ProjectProfileVerificationStep["kind"], extra: Partial<ProjectProfileVerificationStep> = {}): ProjectProfileVerificationStep[] {
  return scripts.has(name) ? [{ kind, command: `npm run ${name}`, argv: ["npm", "run", name], required: true, ...extra }] : [];
}

function humanReview(includePaths?: string[]): ProjectProfileVerificationStep {
  return { kind: "human_review", required: true, ...(includePaths ? { includePaths } : {}) };
}

// 9장에 명시한 현재 활성 프로젝트의 초기 추천을 실행 가능한 argv와 보호 작업으로 변환한다.
// 이름이 우연히 같은 빈 폴더에 위험한 명령을 제안하지 않도록 명령은 실제 wrapper/script 존재를 함께 확인한다.
export function registeredProjectProfileRecommendation(
  projectName: string,
  projectPath: string,
  scriptNames: string[],
): ProjectProfileRecommendation | null {
  const scripts = new Set(scriptNames);
  const file = (relative: string) => fs.existsSync(path.join(projectPath, relative));
  if (projectName === "WSS-Server") {
    const gradle = file("gradlew");
    return {
      id: "wss-server-spring",
      reasoningEffort: "high",
      verificationSteps: gradle ? [
        { kind: "full_test", command: "./gradlew test", argv: ["./gradlew", "test"], required: true, timeoutMs: 1_800_000 },
        { kind: "contract", command: "./gradlew apiDocs", argv: ["./gradlew", "apiDocs"], required: true, timeoutMs: 1_800_000,
          includePaths: ["src/main/**/controller/**", "src/main/**/dto/**", "src/test/**"] },
      ] : [],
      protectedActions: ["production_database", "redis", "credential_change", "deploy", "database_migration", "schema_apply"],
      warnings: gradle ? [] : ["맞춤 검증 wrapper 없음: gradlew"],
    };
  }
  if (projectName === "WSS-admin-web") return {
    id: "wss-admin-fullstack",
    verificationSteps: [...npmStep(scripts, "test", "full_test"), ...npmStep(scripts, "build", "build"), humanReview(["frontend/**"])],
    protectedActions: ["external_mysql", "aws", "cloudwatch", "fcm", "sql_execution", "deploy", "credential_change"],
    warnings: scripts.has("test") && scripts.has("build") ? [] : ["맞춤 test/build script 확인 필요"],
  };
  if (projectName === "myagent") return {
    id: "wam-provider-runtime",
    reasoningEffort: "high",
    verificationSteps: [
      ...npmStep(scripts, "verify", "full_test", { timeoutMs: 1_800_000 }),
      ...npmStep(scripts, "test:ui", "ui", { timeoutMs: 1_800_000, includePaths: ["src/client/**", "tests/e2e/**"] }),
    ],
    protectedActions: ["production_database", "process_restart", "tmux_or_cli_stop", "release", "credential_change"],
    warnings: scripts.has("verify") && scripts.has("test:ui") ? [] : ["맞춤 verify/test:ui script 확인 필요"],
  };
  if (projectName === "geulmeok-frontend") return {
    id: "geulmeok-react-ui",
    verificationSteps: [...npmStep(scripts, "build", "build"), humanReview()],
    protectedActions: ["sibling_repository_write", "gocd_deploy", "deploy_wait"],
    warnings: scripts.has("build") ? [] : ["맞춤 build script 확인 필요"],
  };
  if (projectName === "geulmeok-scrap") return {
    id: "geulmeok-fixture-scraper",
    reasoningEffort: "high",
    verificationSteps: [humanReview()],
    protectedActions: ["live_scrape", "production_database", "session_cookie", "scheduled_trigger", "long_collection"],
    warnings: file("pyproject.toml") ? [] : ["pyproject.toml 없음"],
  };
  if (projectName === "resume") {
    const nestedTest = file("job-automation/package.json");
    return {
      id: "resume-evidence-writing",
      verificationSteps: [
        ...(nestedTest ? [{ kind: "focused_test" as const, command: "npm --prefix job-automation test", argv: ["npm", "--prefix", "job-automation", "test"], required: true, timeoutMs: 600_000 }] : []),
        humanReview(),
      ],
      protectedActions: ["personal_data_write", "unsupported_claim", "existing_submission_overwrite"],
      warnings: nestedTest ? [] : ["job-automation test 없음"],
    };
  }
  if (projectName === "스터디") return {
    id: "study-single-agent-tutor",
    verificationSteps: [humanReview()],
    protectedActions: ["multi_agent_delegation", "curriculum_change", "sibling_repository_write"],
    warnings: [],
  };
  if (projectName === "genshincalculator") return {
    id: "genshin-simulation-safe",
    reasoningEffort: "high",
    verificationSteps: [...npmStep(scripts, "test", "full_test"), ...npmStep(scripts, "typecheck", "static")],
    protectedActions: ["gcsim_install", "full_benchmark", "large_search", "version_or_data_update"],
    warnings: scripts.has("test") && scripts.has("typecheck") ? [] : ["맞춤 test/typecheck script 확인 필요"],
  };
  return null;
}
