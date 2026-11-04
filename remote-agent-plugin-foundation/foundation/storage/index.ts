import { DatabaseSync } from "node:sqlite";
/** Open one database; business modules own their schema and queries. */
export function openDatabase(path: string) {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA busy_timeout = 5000");
  return database;
}
export { applyMigrations, type Migration } from "./migrations.js";
