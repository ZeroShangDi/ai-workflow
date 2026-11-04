import { randomUUID } from "node:crypto";
import { noteInput, type NotesRepository } from "./contracts.js";

/** Assemble the example business service using an injected persistence contract. */
export function createNotes(repository: NotesRepository) {
  return {
    /** List a bounded set of notes belonging to the trusted principal. */
    list(owner: string) {
      return repository.list(owner, 100);
    },
    /** Validate the payload before creating a note for the trusted principal. */
    create(owner: string, input: unknown) {
      const { text } = noteInput.parse(input);
      const note = {
        id: randomUUID(),
        text,
        createdAt: new Date().toISOString(),
      };
      repository.create(owner, note);
      return note;
    },
  };
}
