import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import { loadConfig } from "../src/server/core/config";
import { expectedDatabaseShape, openDatabase, type AppDatabase } from "../src/server/core/database";
import { verifyPassword } from "../src/server/core/security";
import { upsertTestOnlyUser } from "../src/server/core/test-user";

const DURABLE_TABLES = [
  "users", "projects", "chats", "prompt_schedules", "agent_presets", "agent_preset_versions", "agent_tasks", "verification_runs",
] as const;

function tableExists(database: Database.Database, table: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get("table", table));
}

function columnExists(database: Database.Database, table: string, column: string): boolean {
  return tableExists(database, table)
    && (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((row) => row.name === column);
}

function durableCounts(database: Database.Database): Record<string, number> {
  return Object.fromEntries(DURABLE_TABLES.map((table) => {
    if (!tableExists(database, table)) return [table, 0];
    const permanentOnly = table === "users" && columnExists(database, "users", "temporary_expires_at");
    const sql = `SELECT COUNT(*) AS count FROM ${table}${permanentOnly ? " WHERE temporary_expires_at IS NULL" : ""}`;
    return [table, Number((database.prepare(sql).get() as { count: number }).count)];
  }));
}

function schemaSignature(database: Database.Database): string {
  const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE ? ORDER BY name").all("table", "sqlite_%") as Array<{ name: string }>);
  return crypto.createHash("sha256").update(JSON.stringify(tables.map(({ name }) => ({
    name,
    columns: (database.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>).map((row) => row.name),
  })))).digest("hex");
}

function missingShape(database: Database.Database): { tables: string[]; columns: string[] } {
  const expected = expectedDatabaseShape();
  const tables: string[] = [];
  const columns: string[] = [];
  for (const [table, expectedColumns] of Object.entries(expected)) {
    if (!tableExists(database, table)) { tables.push(table); continue; }
    for (const column of expectedColumns) if (!columnExists(database, table, column)) columns.push(`${table}.${column}`);
  }
  return { tables: tables.sort(), columns: columns.sort() };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const sourceFile = path.join(config.dataDir, "web-agent-manager.sqlite");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-deployment-drill-"));
  fs.chmodSync(root, 0o700);
  const cloneFile = path.join(root, "web-agent-manager.sqlite");
  const startedAt = performance.now();
  let sourceSchemaBefore = "";
  let beforeCounts: Record<string, number> = {};
  try {
    const source = new Database(sourceFile, { readonly: true, fileMustExist: true });
    try {
      sourceSchemaBefore = schemaSignature(source);
      beforeCounts = durableCounts(source);
      await source.backup(cloneFile);
    } finally { source.close(); }
    fs.chmodSync(cloneFile, 0o600);

    const migrationStartedAt = performance.now();
    const clone = openDatabase({ ...config, dataDir: root });
    const migrationMs = performance.now() - migrationStartedAt;
    try {
      const integrity = clone.pragma("integrity_check") as Array<{ integrity_check: string }>;
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") throw new Error("migration clone integrity_check가 실패했습니다.");
      const foreignKeys = clone.pragma("foreign_key_check") as Array<Record<string, unknown>>;
      if (foreignKeys.length) throw new Error(`migration clone foreign_key_check가 ${foreignKeys.length}건 실패했습니다.`);
      const afterCounts = durableCounts(clone);
      if (JSON.stringify(afterCounts) !== JSON.stringify(beforeCounts)) throw new Error("migration 전후 durable table 건수가 다릅니다.");
      const missing = missingShape(clone);
      if (missing.tables.length || missing.columns.length) {
        throw new Error(`migration 뒤 current schema가 불완전합니다: table ${missing.tables.length}, column ${missing.columns.length}`);
      }

      const drillUsername = `deployment-drill-${crypto.randomUUID()}`;
      const drillPassword = crypto.randomBytes(32).toString("base64url");
      const tester = await upsertTestOnlyUser(clone as AppDatabase, drillUsername, drillPassword);
      const stored = clone.prepare("SELECT password_hash FROM users WHERE id = ?").get(tester.id) as { password_hash: string };
      if (tester.role !== "user" || tester.access_scope !== "test_only" || !await verifyPassword(drillPassword, stored.password_hash)) {
        throw new Error("migration clone의 test_only 계정 검증이 실패했습니다.");
      }

      const sourceAfter = new Database(sourceFile, { readonly: true, fileMustExist: true });
      let sourceSchemaUnchanged: boolean;
      try { sourceSchemaUnchanged = schemaSignature(sourceAfter) === sourceSchemaBefore; }
      finally { sourceAfter.close(); }
      if (!sourceSchemaUnchanged) throw new Error("source DB schema가 drill 중 변경됐습니다.");

      process.stdout.write(`${JSON.stringify({
        drillPassed: true,
        sourceSchemaUnchanged,
        integrity: "ok",
        foreignKeyViolations: 0,
        durableCounts: beforeCounts,
        currentSchema: { tables: Object.keys(expectedDatabaseShape()).length, missingTables: 0, missingColumns: 0 },
        testOnlyCredential: { role: tester.role, accessScope: tester.access_scope, passwordVerified: true },
        migrationMs: Number(migrationMs.toFixed(3)),
        elapsedMs: Number((performance.now() - startedAt).toFixed(3)),
      }, null, 2)}\n`);
    } finally { clone.close(); }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "deployment migration drill 실패"}\n`);
  process.exitCode = 1;
});
