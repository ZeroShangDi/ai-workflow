import { z } from "zod";
import { createClient } from "../../../foundation/client/index.js";
import { noteSchema, type NotesApi } from "./contracts.js";
/** Project the generic HTTP client into this plugin's typed business API. */
export function notesClient(client: ReturnType<typeof createClient>): NotesApi {
  return {
    /** Validate the server response at the business boundary. */
    async list() {
      return z
        .array(noteSchema)
        .parse((await client.request("/api/notes")).notes);
    },
    /** Send one write; never retry an unknown outcome automatically. */
    async create(text) {
      return noteSchema.parse(
        (await client.request("/api/notes", { text })).note,
      );
    },
  };
}
