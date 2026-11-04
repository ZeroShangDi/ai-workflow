import {
  mkdir,
  readFile,
  writeFile,
  rename,
  unlink,
  chmod,
} from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Credentials } from "../contracts/index.js";

/** Recognize only missing-file errors; permission and corruption errors must surface. */
function missing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Store per-origin credentials in a private directory with atomic replacement. */
export function fileCredentials(directory: string): Credentials {
  /** Derive a path without incorporating untrusted URL characters. */
  const path = (origin: string) =>
    join(
      directory,
      `${createHash("sha256").update(origin).digest("hex")}.json`,
    );
  return {
    /** Read one credential and fail visibly on malformed local state. */
    async read(origin) {
      try {
        const value = JSON.parse(await readFile(path(origin), "utf8"));
        if (
          value.origin !== origin ||
          typeof value.token !== "string" ||
          !value.token
        )
          throw new Error("Invalid credential file");
        return value.token;
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
    /** Atomically replace the private credential file. */
    async write(origin, token) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const temporary = `${path(origin)}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ origin, token }), {
          mode: 0o600,
          flag: "wx",
        });
        await rename(temporary, path(origin));
      } finally {
        await unlink(temporary).catch((error) => {
          if (!missing(error)) throw error;
        });
      }
    },
    /** Remove only this origin's local session. */
    async remove(origin) {
      await unlink(path(origin)).catch((error) => {
        if (!missing(error)) throw error;
      });
    },
  };
}
