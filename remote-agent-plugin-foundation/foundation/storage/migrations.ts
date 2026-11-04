import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
export interface Migration {
  id: string;
  sql: string;
}
/** Apply ordered migrations atomically; reject edits to previously applied schema history. */
export function applyMigrations(
  database: DatabaseSync,
  migrations: Migration[],
) {
  if (new Set(migrations.map((item) => item.id)).size !== migrations.length)
    throw new Error("Duplicate migration ID");
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(
      "CREATE TABLE IF NOT EXISTS foundation_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL)",
    );
    for (const migration of migrations) {
      const checksum = createHash("sha256").update(migration.sql).digest("hex");
      const applied = database
        .prepare("SELECT checksum FROM foundation_migrations WHERE id = ?")
        .get(migration.id);
      if (applied && applied.checksum !== checksum)
        throw new Error(`Applied migration changed: ${migration.id}`);
      if (applied) continue;
      database.exec(migration.sql);
      database
        .prepare(
          "INSERT INTO foundation_migrations (id, checksum) VALUES (?, ?)",
        )
        .run(migration.id, checksum);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
