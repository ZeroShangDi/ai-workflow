import {
  createServer,
  type ServerDependencies,
} from "../../foundation/server/index.js";
import { createNotes, type NotesRepository } from "./notes/index.js";
export { openStorage, createNotes } from "./notes/index.js";
/** Mount this plugin's business routes onto the protected HTTP foundation. */
export function createApp(
  dependencies: ServerDependencies & { repository: NotesRepository },
) {
  const app = createServer(dependencies);
  const notes = createNotes(dependencies.repository);
  app.get("/api/notes", (c) =>
    c.json({ notes: notes.list(c.get("principal").id) }),
  );
  app.post("/api/notes", async (c) => {
    if (!c.req.header("Content-Type")?.startsWith("application/json")) {
      return c.json({ error: { code: "unsupported_media_type" } }, 415);
    }
    return c.json(
      { note: notes.create(c.get("principal").id, await c.req.json()) },
      201,
    );
  });
  return app;
}
