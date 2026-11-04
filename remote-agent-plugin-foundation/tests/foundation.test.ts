import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, applyMigrations } from "../foundation/storage/index.js";
import { readdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";

/** Protect the schema recovery path rather than depending on migration implementation details. */
test("migrations are repeatable, reject history edits and roll back partial failure", () => {
  const db = openDatabase(":memory:");
  try {
    const initial = [{ id: "001", sql: "CREATE TABLE example (id TEXT)" }];
    applyMigrations(db, initial);
    applyMigrations(db, initial);
    assert.throws(
      () => applyMigrations(db, [{ id: "001", sql: "DROP TABLE example" }]),
      /changed/,
    );
    assert.throws(() =>
      applyMigrations(db, [
        { id: "002", sql: "CREATE TABLE rolled_back (id TEXT); INVALID SQL" },
      ]),
    );
    assert.equal(
      db
        .prepare("SELECT name FROM sqlite_master WHERE name = 'rolled_back'")
        .get(),
      undefined,
    );
    assert.equal(
      db.prepare("SELECT id FROM foundation_migrations WHERE id = '002'").get(),
      undefined,
    );
    assert.ok(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'example'").get(),
    );
  } finally {
    db.close();
  }
});

/** Guard the template boundary so business changes cannot leak back into the foundation. */
test("foundation runtime never imports the product implementation", async () => {
  /** Inspect source imports recursively; the assertion targets an architectural dependency contract. */
  async function inspect(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await inspect(path);
        continue;
      }
      if (!/\.(ts|js|mjs)$/.test(path)) continue;
      const source = await readFile(path, "utf8");
      for (const match of source.matchAll(
        /(?:from|import)\s*[('"\s]+(\.[^'"\n]+)['"]/g,
      )) {
        const target = resolve(directory, match[1]);
        assert.ok(!target.startsWith(resolve("src") + "/"), path);
      }
    }
  }
  await inspect(resolve("foundation"));
});
