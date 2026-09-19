import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import { ExperimentRepository } from "../src/server/services/experiment-repository";
import type { ProviderAdapter } from "../src/server/providers/provider";
import { AgentBridge } from "../src/server/services/agent-bridge";
import type { HistoryCache } from "../src/server/services/history-cache";
import type { SessionManager } from "../src/server/services/session-manager";
import {
  omitFixtureGroundTruth,
  parseExperimentFixtureInput,
  parseExperimentOutputContract,
  parseFindingReport,
} from "../src/shared/experiments";

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function tempConfig(): AppConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-finding-report-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    rootDir: root, dataDir: root, homeDir: root, host: "127.0.0.1", port: 0,
    publicUrl: "http://127.0.0.1", allowedRoots: [root], sessionTtlHours: 1,
    runtimeEnabled: false, slack: {}, ntfy: { serverUrl: "https://ntfy.sh" },
  } as AppConfig;
}

function createHarness(): { database: AppDatabase; repository: ExperimentRepository; projectId: number } {
  const config = tempConfig();
  const database = openDatabase(config);
  const result = database.prepare("INSERT INTO projects(name, path, source) VALUES ('실험 프로젝트', ?, 'manual')")
    .run(path.join(config.dataDir, "project"));
  cleanup.push(() => database.close());
  return { database, repository: new ExperimentRepository(database), projectId: Number(result.lastInsertRowid) };
}

function fixtureInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "review-sample", url: "https://github.com/example/repo", pinnedCommit: SHA_A,
    sizeClass: "small", setupCommand: [], testCommand: [],
    ...overrides,
  };
}

function truthFinding(overrides: Record<string, unknown> = {}) {
  return {
    id: "gt-1", file: "src/app.ts", lineStart: 10, lineEnd: 12,
    category: "off-by-one", severity: "major", mustFind: true, rationale: "경계 조건이 빠졌다",
    ...overrides,
  };
}

describe("산출물 계약·정답·보고 파서", () => {
  it("생략된 산출물 계약은 code_change이고 알 수 없는 값은 거부한다", () => {
    expect(parseExperimentOutputContract(undefined)).toBe("code_change");
    expect(parseExperimentOutputContract(null)).toBe("code_change");
    expect(parseExperimentOutputContract("finding_report")).toBe("finding_report");
    expect(() => parseExperimentOutputContract("review")).toThrow("산출물 계약");
  });

  it("빈 findings는 유효하고 자유 category 문자열을 통과시킨다", () => {
    expect(parseFindingReport({ findings: [] })).toEqual({ findings: [] });
    expect(parseFindingReport({
      findings: [{
        file: "lib/parse.ts", lineStart: 3, lineEnd: 3, category: "correctness",
        severity: "blocker", title: "널 역참조", evidence: "ptr가 검사 없이 쓰인다",
      }],
    })).toMatchObject({
      findings: [{ file: "lib/parse.ts", lineStart: 3, lineEnd: 3, category: "correctness", suggestion: null }],
    });
  });

  it("lineEnd가 lineStart보다 작거나 경로·줄 번호가 잘못되면 거부한다", () => {
    expect(() => parseFindingReport({
      findings: [{ file: "a.ts", lineStart: 8, lineEnd: 7, category: "x", severity: "minor", title: "역전" }],
    })).toThrow("끝 줄은 시작 줄 이상이어야 합니다");
    expect(() => parseFindingReport({
      findings: [{ file: "/abs/a.ts", lineStart: 1, lineEnd: 1, category: "x", severity: "minor", title: "절대" }],
    })).toThrow("저장소 상대 POSIX 경로");
    expect(() => parseFindingReport({
      findings: [{ file: "a.ts", lineStart: 0, lineEnd: 1, category: "x", severity: "minor", title: "0-index" }],
    })).toThrow("1-indexed");
    expect(() => parseFindingReport({ findings: "없음" })).toThrow("배열이어야 합니다");
  });

  it("역슬래시 경로는 POSIX로 정규화하고 정규화 뒤 탈출·절대 경로는 거부한다", () => {
    expect(parseFindingReport({
      findings: [{ file: "src\\server\\index.ts", lineStart: 1, lineEnd: 1, category: "x", severity: "minor", title: "역슬래시" }],
    }).findings[0].file).toBe("src/server/index.ts");
    expect(parseExperimentFixtureInput(fixtureInput({
      groundTruth: [truthFinding({ file: "src\\auth.ts" })],
    })).groundTruth?.[0].file).toBe("src/auth.ts");

    expect(() => parseFindingReport({
      findings: [{ file: "src\\..\\..\\etc\\passwd", lineStart: 1, lineEnd: 1, category: "x", severity: "minor", title: "탈출" }],
    })).toThrow("저장소 상대 POSIX 경로");
    expect(() => parseExperimentFixtureInput(fixtureInput({
      groundTruth: [truthFinding({ file: "\\src\\app.ts" })],
    }))).toThrow("저장소 상대 POSIX 경로");
  });

  it("fixture 정답과 리뷰 대상을 검증하고 잘못된 SHA·중복 id를 거부한다", () => {
    const parsed = parseExperimentFixtureInput(fixtureInput({
      reviewTarget: { baseCommit: SHA_A, headCommit: SHA_B },
      findingTaxonomy: "code-review-v1",
      groundTruth: [truthFinding(), truthFinding({ id: "gt-2", category: "security", severity: "blocker", mustFind: false })],
    }));
    expect(parsed.reviewTarget).toEqual({ baseCommit: SHA_A, headCommit: SHA_B });
    expect(parsed.findingTaxonomy).toBe("code-review-v1");
    expect(parsed.groundTruth).toHaveLength(2);
    expect(parsed.groundTruth?.[0]).toMatchObject({ category: "off-by-one", mustFind: true });

    expect(parseExperimentFixtureInput(fixtureInput()).groundTruth).toBeNull();
    expect(parseExperimentFixtureInput(fixtureInput({ groundTruth: [] })).groundTruth).toEqual([]);
    expect(() => parseExperimentFixtureInput(fixtureInput({
      reviewTarget: { baseCommit: "abc1234", headCommit: SHA_B },
    }))).toThrow("40자 SHA");
    expect(() => parseExperimentFixtureInput(fixtureInput({
      groundTruth: [truthFinding(), truthFinding()],
    }))).toThrow("중복");
    expect(() => parseExperimentFixtureInput(fixtureInput({
      groundTruth: [truthFinding({ lineStart: 20, lineEnd: 4 })],
    }))).toThrow("끝 줄은 시작 줄 이상이어야 합니다");
  });
});

describe("산출물 계약 마이그레이션", () => {
  it("컬럼 없는 기존 DB를 열면 실험 행이 code_change로 채워지고 fixture 선택 컬럼은 null이다", () => {
    const config = tempConfig();
    const sqlitePath = path.join(config.dataDir, "web-agent-manager.sqlite");
    const legacy = new Database(sqlitePath);
    legacy.exec(`
      CREATE TABLE experiment_fixtures (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        url TEXT NOT NULL,
        pinned_commit TEXT NOT NULL,
        size_class TEXT NOT NULL,
        language TEXT,
        license TEXT,
        lines_of_code INTEGER,
        setup_command_json TEXT NOT NULL DEFAULT '[]',
        test_command_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'draft',
        gate_json TEXT NOT NULL DEFAULT '{}',
        mirror_path TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE experiments (
        id TEXT PRIMARY KEY,
        project_id INTEGER NOT NULL,
        created_by INTEGER,
        name TEXT NOT NULL,
        command TEXT NOT NULL,
        design_json TEXT NOT NULL DEFAULT '{}',
        rubric_json TEXT NOT NULL DEFAULT '{}',
        suite_id TEXT,
        task_kind TEXT,
        fixture_id TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    legacy.prepare(`
      INSERT INTO experiment_fixtures(id, name, url, pinned_commit, size_class)
      VALUES ('fixture-1', 'old', 'https://github.com/example/repo', ?, 'small')
    `).run(SHA_A);
    legacy.prepare(`
      INSERT INTO experiments(id, project_id, name, command)
      VALUES ('experiment-1', 1, '기존 실험', '구현해')
    `).run();
    legacy.close();

    const database = openDatabase(config);
    cleanup.push(() => database.close());
    const experimentColumns = database.prepare("PRAGMA table_info(experiments)").all() as Array<{ name: string }>;
    const fixtureColumns = database.prepare("PRAGMA table_info(experiment_fixtures)").all() as Array<{ name: string }>;
    expect(experimentColumns.some((column) => column.name === "output_contract")).toBe(true);
    expect(fixtureColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "review_target_json", "finding_taxonomy", "ground_truth_json",
    ]));
    expect(database.prepare("SELECT output_contract FROM experiments WHERE id = 'experiment-1'").get())
      .toEqual({ output_contract: "code_change" });
    expect(database.prepare("SELECT review_target_json, finding_taxonomy, ground_truth_json FROM experiment_fixtures WHERE id = 'fixture-1'").get())
      .toEqual({ review_target_json: null, finding_taxonomy: null, ground_truth_json: null });
  });
});

describe("산출물 계약 저장·조회", () => {
  it("실험 계약과 fixture 정답을 왕복하고 생략 값은 기본·null로 남긴다", () => {
    const { repository, projectId } = createHarness();
    const fixture = repository.createFixture(fixtureInput({
      reviewTarget: { baseCommit: SHA_A.toUpperCase(), headCommit: SHA_B },
      findingTaxonomy: "cwe-injection",
      groundTruth: [truthFinding({ file: "src/auth.ts", lineStart: 40, lineEnd: 44, category: "sql-injection" })],
    }));
    expect(fixture).toMatchObject({
      reviewTarget: { baseCommit: SHA_A, headCommit: SHA_B },
      findingTaxonomy: "cwe-injection",
      groundTruth: [{ id: "gt-1", file: "src/auth.ts", category: "sql-injection", mustFind: true }],
    });
    expect(repository.getFixture(fixture.id)?.groundTruth).toEqual(fixture.groundTruth);

    const reported = repository.createExperiment({
      projectId, name: "보안 감사", command: "취약점을 찾아라",
      taskKind: "security", outputContract: "finding_report", fixtureId: fixture.id,
    });
    expect(reported).toMatchObject({
      taskKind: "security", outputContract: "finding_report", fixtureId: fixture.id,
    });
    expect(repository.getExperiment(reported.id)?.outputContract).toBe("finding_report");

    const plain = repository.createExperiment({ projectId, name: "기본", command: "구현해" });
    expect(plain.outputContract).toBe("code_change");
    expect(repository.createFixture(fixtureInput({ name: "plain-fixture" }))).toMatchObject({
      reviewTarget: null, findingTaxonomy: null, groundTruth: null,
    });
  });
});

describe("에이전트용 fixture 정답 가림", () => {
  it("정답이 있어도 필드 자체를 빼서 존재·개수가 새지 않게 한다", () => {
    const withAnswers = omitFixtureGroundTruth({
      id: "f1", name: "review", groundTruth: [truthFinding(), truthFinding({ id: "gt-2" })],
    });
    expect(withAnswers).toEqual({ id: "f1", name: "review" });
    expect("groundTruth" in withAnswers).toBe(false);

    const empty = omitFixtureGroundTruth({ id: "f2", groundTruth: [] });
    const missing = omitFixtureGroundTruth({ id: "f3", groundTruth: null });
    expect("groundTruth" in empty).toBe(false);
    expect("groundTruth" in missing).toBe(false);
    expect(Object.keys(empty)).toEqual(["id"]);
    expect(Object.keys(missing)).toEqual(["id"]);
  });

  it("브리지 조회·생성 응답에는 정답이 없고 저장소에는 남는다", async () => {
    const { database, repository } = createHarness();
    repository.createFixture(fixtureInput({
      name: "leaky", findingTaxonomy: "code-review-v1",
      groundTruth: [truthFinding()],
    }));
    const bridge = new AgentBridge({
      database,
      adapters: [] as unknown as ProviderAdapter[],
      historyCache: { get: () => ({ messages: [], turnEndedAt: null }) } as unknown as HistoryCache,
      sessions: { start: () => undefined, sendPrompt: async () => "" } as unknown as Pick<SessionManager, "start" | "sendPrompt">,
      experiments: {
        repository,
        summary: () => ({}),
        suiteSummary: () => ({}),
        cleanupWorkspaces: async () => ({}),
        startRunPlan: () => ({}),
        cancelRunPlan: () => ({}),
      },
      socketPath: path.join(os.tmpdir(), "unused-finding-report.sock"),
    });

    const listed = await bridge.execute({ method: "experiment.fixtures" }) as Array<Record<string, unknown>>;
    expect(listed).toHaveLength(1);
    expect("groundTruth" in listed[0]).toBe(false);
    expect(listed[0].findingTaxonomy).toBe("code-review-v1");
    expect(repository.listFixtures()[0].groundTruth).toEqual([expect.objectContaining({ id: "gt-1" })]);

    const created = await bridge.execute({
      method: "experiment.fixture_create",
      params: fixtureInput({ name: "created-secret", groundTruth: [truthFinding({ id: "hidden-1" })] }),
    }) as { id: string };
    expect("groundTruth" in created).toBe(false);
    expect(repository.getFixture(created.id)?.groundTruth).toEqual([expect.objectContaining({ id: "hidden-1" })]);
  });
});
