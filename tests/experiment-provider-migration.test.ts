import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type AppDatabase } from "../src/server/core/database";

const roots: string[] = [];
const databases: AppDatabase[] = [];

// 실제 스키마가 적용된 임시 데이터베이스를 연다.
function open(dataDir: string): AppDatabase {
  const database = openDatabase({
    rootDir: dataDir, dataDir, homeDir: dataDir,
    host: "127.0.0.1", port: 0, publicUrl: "", allowedRoots: ["/"],
    sessionTtlHours: 1, runtimeEnabled: false, slack: {}, ntfy: { serverUrl: "https://ntfy.sh" },
  });
  databases.push(database);
  return database;
}

const EXPERIMENT_PROVIDER_TABLES = ["experiment_nodes", "experiment_evaluation_calls", "experiment_judgments"];

// 대상 테이블을 grok이 없던 예전 CHECK 제약으로 되돌려 마이그레이션 이전 DB를 재현한다.
function downgradeConstraints(database: AppDatabase): void {
  database.pragma("foreign_keys = OFF");
  for (const table of EXPERIMENT_PROVIDER_TABLES) {
    const row = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string };
    database.exec(`DROP TABLE ${table}`);
    database.exec(row.sql.replaceAll("IN ('codex', 'claude', 'grok')", "IN ('codex', 'claude')"));
  }
  database.pragma("foreign_keys = ON");
}

// 판정 행이 참조하는 실험·변형·실행·평가 부모 행을 최소 구성으로 만든다.
function seedJudgmentParents(database: AppDatabase): void {
  database.prepare("INSERT INTO projects(id, name, path) VALUES (1, 'sample', '/tmp/sample')").run();
  database.prepare("INSERT INTO experiments(id, project_id, name, command) VALUES ('experiment-1', 1, '실험', 'npm test')").run();
  database.prepare("INSERT INTO experiment_variants(id, experiment_id, name, config_json) VALUES ('variant-1', 'experiment-1', '변형', '{}')").run();
  database.prepare(`
    INSERT INTO experiment_runs(id, experiment_id, variant_id, attempt, config_snapshot_json)
    VALUES ('run-1', 'experiment-1', 'variant-1', 1, '{}')
  `).run();
  database.prepare("INSERT INTO experiment_evaluations(id, experiment_id, method, rubric_json) VALUES ('evaluation-1', 'experiment-1', 'rubric', '{}')").run();
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("실험 테이블 공급자 제약 마이그레이션", () => {
  it("grok이 없던 기존 DB를 다시 열면 실험 테이블 제약이 넓혀지고 기존 행은 남는다", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "experiment-provider-migration-"));
    roots.push(dataDir);
    const first = open(dataDir);
    downgradeConstraints(first);
    // 마이그레이션은 끝에 foreign_key_check로 검증하므로 표식 행의 부모도 실제로 있어야 한다.
    seedJudgmentParents(first);
    first.prepare(`
      INSERT INTO experiment_judgments(id, evaluation_id, run_id, evaluator_label, evaluator_provider, subject_provider, score, result_json)
      VALUES ('judgment-1', 'evaluation-1', 'run-1', 'Claude judge', 'claude', 'codex', 0.9, '{}')
    `).run();
    for (const table of EXPERIMENT_PROVIDER_TABLES) {
      const row = first.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string };
      expect(row.sql).not.toContain("'grok'");
    }
    first.close();
    databases.splice(databases.indexOf(first), 1);

    const reopened = open(dataDir);
    for (const table of EXPERIMENT_PROVIDER_TABLES) {
      const row = reopened.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string };
      expect(row.sql).toContain("'grok'");
    }
    expect(reopened.prepare("SELECT evaluator_provider FROM experiment_judgments WHERE id = 'judgment-1'").get())
      .toEqual({ evaluator_provider: "claude" });
    expect(() => reopened.prepare(`
      INSERT INTO experiment_judgments(id, evaluation_id, run_id, evaluator_label, evaluator_provider, subject_provider, score, result_json)
      VALUES ('judgment-2', 'evaluation-1', 'run-1', 'Grok judge', 'grok', 'grok', 0.7, '{}')
    `).run()).not.toThrow();
  });
});
