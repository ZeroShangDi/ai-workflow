import { createConnections, hasActiveGrant } from "./connections.js";
import { oauthPlugin, oauthAuthority } from "./oauth.js";
import { betterAuth } from "better-auth";
import { bearer, deviceAuthorization, jwt } from "better-auth/plugins";
import { getMigrations } from "better-auth/db/migration";
import type { DatabaseSync } from "node:sqlite";
import type { Identity, AuthConfig } from "../contracts/index.js";

/** Configure first-party device sessions; authentication logic remains in Better Auth. */
export async function createIdentity(
  database: DatabaseSync,
  baseURL: string,
  secret: string,
  config: AuthConfig,
) {
  const options = {
    database,
    baseURL,
    secret,
    trustedOrigins: [baseURL],
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
    session: { expiresIn: 60 * 60 * 24 * 7, cookieCache: { enabled: false } },
    rateLimit: { enabled: true as const, storage: "database" as const },
    plugins: [
      bearer(),
      jwt(),
      oauthPlugin(baseURL, config.scopes),
      deviceAuthorization({
        verificationUri: `${baseURL}/device`,
        validateClient: (clientId: string) =>
          clientId === config.deviceClientId,
      }),
    ],
  };
  const migration = await getMigrations(options);
  await migration.runMigrations();
  const auth = betterAuth(options);
  const identity: Identity = {
    /** Resolve identity against stored sessions so revocation takes effect immediately. */
    async resolve(headers) {
      const session = await auth.api.getSession({ headers });
      return session ? { id: session.user.id, name: session.user.name } : null;
    },
  };
  const oauth = oauthAuthority(
    baseURL,
    secret,
    {
      keys: () => auth.api.getJwks(),
      async sessionExists(id, owner, client) {
        const context = await auth.$context;
        const session = await context.adapter.findOne<{
          userId: string;
          expiresAt: Date;
        }>({
          model: "session",
          where: [{ field: "id", value: id }],
        });
        return Boolean(
          hasActiveGrant(database, id, owner, client) &&
          session &&
          session.userId === owner &&
          new Date(session.expiresAt) > new Date(),
        );
      },
    },
    config.accessScope,
  );
  return {
    identity,
    oauth,
    connections: createConnections(database),
    handler: auth.handler,
  };
}
