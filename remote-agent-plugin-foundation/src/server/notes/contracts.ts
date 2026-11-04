import { z } from "zod";

export const noteInput = z
  .object({ text: z.string().trim().min(1).max(4000) })
  .strict();
export const noteSchema = noteInput.extend({
  id: z.string().uuid(),
  createdAt: z.string(),
});
export type Note = z.infer<typeof noteSchema>;
export interface NotesRepository {
  /** Return only this owner's notes, bounded by the requested limit. */
  list(owner: string, limit: number): Note[];
  /** Store a note; the authenticated owner is supplied by the service. */
  create(owner: string, note: Note): void;
}
export interface NotesApi {
  /** List notes for the current authenticated client. */
  list(): Promise<Note[]>;
  /** Create a note, without automatically retrying an uncertain write. */
  create(text: string): Promise<Note>;
}
