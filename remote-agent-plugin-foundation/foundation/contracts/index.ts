export interface Principal {
  id: string;
  name: string;
}
export interface Identity {
  /** Resolve the authenticated user; invalid or expired sessions return null. */
  resolve(headers: Headers): Promise<Principal | null>;
}
export interface Credentials {
  /** Retrieve a private credential for one server origin. */
  read(origin: string): Promise<string | null>;
  /** Atomically persist a credential, never returning it to the model. */
  write(origin: string, token: string): Promise<void>;
  /** Remove the local credential after remote revocation. */
  remove(origin: string): Promise<void>;
}

export interface OAuthAuthority {
  /** Resolve an access token bound to this MCP resource and an active user session. */
  resolve(request: Request): Promise<Principal | null>;
  /** Validate authorization context before rendering the consent screen. */
  consent(
    query: string,
  ): Promise<{ clientId: string; scopes: string; resource: string } | null>;
}

export interface AgentConnections {
  /** List active OAuth authorizations without exposing credentials. */
  list(owner: string): { id: string; name: string; createdAt: string }[];
  /** Revoke an owned authorization; repeated revocation is harmless. */
  revoke(owner: string, id: string): void;
}

export interface AuthConfig {
  scopes: string[];
  accessScope: string;
  deviceClientId: string;
}
