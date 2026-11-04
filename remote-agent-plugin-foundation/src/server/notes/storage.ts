import {
  openDatabase,
  applyMigrations,
} from "../../../foundation/storage/index.js";
import type { Note, NotesRepository } from "./contracts.js";

/** Open SQLite and migrate this adapter's schema without owning authentication tables. */
export function openStorage(path: string) {
  const database = openDatabase(path);
  applyMigrations(database, [
    {
      id: "notes-001",
      sql: `CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, text TEXT NOT NULL, createdAt TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS notes_owner ON notes(owner, createdAt DESC);`,
    },
  ]);
  const repository: NotesRepository = {
    /** Query by owner at the storage boundary, never filter other users' data in memory. */
    list(owner, limit) {
      return database
        .prepare(
          "SELECT id, text, createdAt FROM notes WHERE owner = ? ORDER BY createdAt DESC, id DESC LIMIT ?",
        )
        .all(owner, limit) as Note[];
    },
    /** Persist one validated note atomically. */
    create(owner, note) {
      database
        .prepare(
          "INSERT INTO notes (id, owner, text, createdAt) VALUES (?, ?, ?, ?)",
        )
        .run(note.id, owner, note.text, note.createdAt);
    },
  };
  return { database, repository, close: () => database.close() };
}
