import type { DatabaseSync } from "node:sqlite";
import type { AgentConnections } from "../contracts/index.js";

/** Adapt provider-owned refresh grants without exposing tokens or browser sessions. */
export function createConnections(database: DatabaseSync): AgentConnections {
  return {
    /** Group rotated credentials into one client authorization per backing session. */
    list(owner) {
      return database
        .prepare(
          `
        SELECT MIN(r.id) AS id, COALESCE(c.name, 'Agent 客户端') AS name,
          MIN(r.createdAt) AS createdAt
        FROM oauthRefreshToken r JOIN oauthClient c ON c.clientId = r.clientId
        JOIN session s ON s.id = r.sessionId
        WHERE r.userId = ? AND r.revoked IS NULL AND r.expiresAt > ?
          AND s.expiresAt > ?
        GROUP BY r.clientId, r.sessionId ORDER BY MIN(r.createdAt) DESC
      `,
        )
        .all(owner, new Date().toISOString(), new Date().toISOString())
        .map((row) => ({
          id: String(row.id),
          name: String(row.name),
          createdAt: new Date(String(row.createdAt)).toISOString(),
        }));
    },
    /** Revoke the whole rotation family while preserving the website login. */
    revoke(owner, id) {
      database
        .prepare(
          `UPDATE oauthRefreshToken SET revoked = ?
        WHERE userId = ? AND (clientId, sessionId) IN (
          SELECT clientId, sessionId FROM oauthRefreshToken WHERE id = ? AND userId = ?
        )`,
        )
        .run(new Date().toISOString(), owner, id, owner);
    },
  };
}

/** Require an active refresh grant as well as an active backing session. */
export function hasActiveGrant(
  database: DatabaseSync,
  session: string,
  owner: string,
  client: string,
) {
  return Boolean(
    database
      .prepare(
        `SELECT 1 FROM oauthRefreshToken
    WHERE sessionId = ? AND userId = ? AND clientId = ?
      AND revoked IS NULL AND expiresAt > ? LIMIT 1`,
      )
      .get(session, owner, client, new Date().toISOString()),
  );
}
