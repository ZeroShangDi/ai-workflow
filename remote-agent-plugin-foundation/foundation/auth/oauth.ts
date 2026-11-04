import {
  oauthProvider,
  verifyOAuthQueryParams,
} from "@better-auth/oauth-provider";
import { verifyJwsAccessToken } from "better-auth/oauth2";
import type { OAuthAuthority } from "../contracts/index.js";

/** Configure standard authorization-code + PKCE for native Agent clients. */
export function oauthPlugin(origin: string, scopes: string[]) {
  return oauthProvider({
    loginPage: "/connect",
    consentPage: "/connect",
    scopes,
    resources: [`${origin}/mcp`],
    grantTypes: ["authorization_code", "refresh_token"],
    allowDynamicClientRegistration: true,
    clientRegistrationDefaultResources: [`${origin}/mcp`],
    clientRegistrationAllowedResources: [`${origin}/mcp`],
    clientRegistrationRequirePKCE: true,
    clientRegistrationDefaultApplicationType: "infer",
    allowUnauthenticatedClientRegistration: true,
    accessTokenExpiresIn: 300,
  });
}

type AuthOperations = {
  keys: Exclude<
    Parameters<typeof verifyJwsAccessToken>[1]["jwksFetch"],
    string
  >;
  sessionExists: (
    id: string,
    owner: string,
    client: string,
  ) => Promise<boolean>;
};

/** Verify signatures, audience, scope and the backing login session at the auth boundary. */
export function oauthAuthority(
  origin: string,
  secret: string,
  operations: AuthOperations,
  accessScope: string,
): OAuthAuthority {
  return {
    /** Reject session tokens, malformed JWTs and tokens issued to other resources. */
    async resolve(request) {
      const authorization = request.headers.get("Authorization");
      if (!authorization?.startsWith("Bearer ")) return null;
      let payload;
      try {
        payload = await verifyJwsAccessToken(authorization.slice(7), {
          jwksFetch: operations.keys,
          verifyOptions: {
            issuer: `${origin}/api/auth`,
            audience: `${origin}/mcp`,
          },
        });
      } catch {
        return null;
      }
      if (payload.cnf || !payload.sub || typeof payload.sid !== "string")
        return null;
      if (
        typeof payload.scope !== "string" ||
        !payload.scope.split(" ").includes(accessScope)
      )
        return null;
      if (typeof payload.client_id !== "string") return null;
      if (
        !(await operations.sessionExists(
          payload.sid,
          payload.sub,
          payload.client_id,
        ))
      )
        return null;
      return { id: payload.sub, name: "OAuth user" };
    },
    /** Only show consent details after the provider verifies the signed authorization query. */
    async consent(query) {
      if (!(await verifyOAuthQueryParams(query, secret))) return null;
      const params = new URLSearchParams(query);
      return {
        clientId: params.get("client_id") ?? "",
        scopes: params.get("scope") ?? "",
        resource: params.get("resource") ?? "",
      };
    },
  };
}
