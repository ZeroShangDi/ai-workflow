import plugin from "../plugin.config.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { createIdentity } from "../foundation/auth/index.js";
import { openStorage } from "../src/server/notes/index.js";
import { createApp } from "../src/server/index.js";
import { createMcpHttp } from "../src/mcp/index.js";

const origin = "http://localhost:8787";

/** Exercise the provider's actual PKCE flow and HTTP MCP against isolated state. */
test("OAuth consent, PKCE, MCP write and webpage read share the same identity", async () => {
  const storage = openStorage(":memory:");
  try {
    const auth = await createIdentity(
      storage.database,
      origin,
      "oauth-test-secret-that-is-long-and-only-for-tests",
      plugin.auth,
    );
    const app = createApp({
      identity: auth.identity,
      connections: auth.connections,
      repository: storage.repository,
      authHandler: auth.handler,
      origin,
    });
    app.route("/", createMcpHttp(origin, auth.oauth, storage.repository));
    const request = makeRequester(app);
    const signup = await request("/api/auth/sign-up/email", {
      name: "OAuth Test",
      email: "oauth@example.test",
      password: "test-password-long-enough",
    });
    const sessionToken = signup.token;
    assert.deepEqual(
      (await request("/api/connections", undefined, sessionToken)).connections,
      [],
    );
    const { client, token } = await authorize(
      request,
      sessionToken,
      auth.oauth,
    );
    const principal = await auth.oauth.resolve(
      new Request(`${origin}/mcp`, {
        headers: { Authorization: `Bearer ${token.access_token}` },
      }),
    );
    assert.ok(principal, "OAuth token must resolve to an active user session");
    await verifyMcpWrite(app, token.access_token);
    const notes = await request("/api/notes", undefined, sessionToken);
    assert.equal(notes.notes[0].text, "OAuth MCP acceptance note");
    const renewed = await request("/api/auth/oauth2/token", {
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: token.refresh_token,
      resource: `${origin}/mcp`,
    });
    assert.ok(
      await auth.oauth.resolve(
        new Request(`${origin}/mcp`, {
          headers: { Authorization: `Bearer ${renewed.access_token}` },
        }),
      ),
    );
    const unauthenticated = await app.request(`${origin}/mcp`);
    assert.equal(unauthenticated.status, 401);
    assert.ok(
      unauthenticated.headers
        .get("WWW-Authenticate")
        ?.includes("oauth-protected-resource/mcp"),
    );
    assert.equal(
      await auth.oauth.resolve(
        new Request(`${origin}/mcp`, {
          headers: { Authorization: `Bearer ${sessionToken}` },
        }),
      ),
      null,
    );
    await verifyConnections(request, sessionToken, token.refresh_token);
    assert.equal(
      await auth.oauth.resolve(
        new Request(`${origin}/mcp`, {
          headers: { Authorization: `Bearer ${token.access_token}` },
        }),
      ),
      null,
    );
  } finally {
    storage.close();
  }
});

/** Send protocol requests and fail with a useful non-secret stage identifier. */
function makeRequester(app: ReturnType<typeof createApp>) {
  return async (path: string, body?: unknown, token?: string) => {
    const response = await app.request(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": path.endsWith("/token")
          ? "application/x-www-form-urlencoded"
          : "application/json",
        Accept: "application/json",
        Origin: origin,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body:
        body === undefined
          ? undefined
          : path.endsWith("/token")
            ? new URLSearchParams(body as Record<string, string>).toString()
            : JSON.stringify(body),
    });
    const location = response.headers.get("Location");
    if (location) return { url: location };
    const result = await response.json();
    assert.ok(
      response.ok,
      `${path}: ${response.status} ${JSON.stringify(result)}`,
    );
    return result;
  };
}

/** Obtain a real provider token through explicit consent and S256 PKCE. */
async function authorize(
  request: ReturnType<typeof makeRequester>,
  sessionToken: string,
  authority: import("../foundation/contracts/index.js").OAuthAuthority,
) {
  const client = await request("/api/auth/oauth2/register", {
    client_name: "Acceptance client",
    redirect_uris: ["http://127.0.0.1:3210/callback"],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: "notes offline_access",
    application_type: "native",
  });
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    client_id: client.client_id,
    response_type: "code",
    redirect_uri: "http://127.0.0.1:3210/callback",
    scope: "notes offline_access",
    resource: `${origin}/mcp`,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "test-state",
  });
  const authorization = await request(
    `/api/auth/oauth2/authorize?${query}`,
    undefined,
    sessionToken,
  );
  const consentUrl = new URL(authorization.url, origin);
  assert.equal(
    consentUrl.pathname,
    "/connect",
    consentUrl.searchParams.get("error_description") ??
      consentUrl.searchParams.get("error") ??
      "Unexpected redirect",
  );
  assert.ok(await authority.consent(consentUrl.search.slice(1)));
  assert.equal(
    await authority.consent(consentUrl.search.slice(1) + "&scope=other"),
    null,
  );
  const consent = await request(
    "/api/auth/oauth2/consent",
    { accept: true, oauth_query: consentUrl.search.slice(1) },
    sessionToken,
  );
  const callback = new URL(consent.url);
  assert.equal(callback.searchParams.get("state"), "test-state");
  const token = await request("/api/auth/oauth2/token", {
    grant_type: "authorization_code",
    client_id: client.client_id,
    code: callback.searchParams.get("code"),
    code_verifier: verifier,
    redirect_uri: "http://127.0.0.1:3210/callback",
    resource: `${origin}/mcp`,
  });
  assert.ok(token.access_token);
  return { client, token };
}

/** Verify connection lifecycle and independence from the website login. */
async function verifyConnections(
  request: ReturnType<typeof makeRequester>,
  sessionToken: string,
  refreshToken: string,
) {
  const connections = (
    await request("/api/connections", undefined, sessionToken)
  ).connections;
  assert.equal(connections.length, 1);
  assert.equal(connections[0].name, "Acceptance client");
  assert.equal(JSON.stringify(connections).includes(refreshToken), false);
  await request(
    "/api/connections/revoke",
    { id: connections[0].id },
    sessionToken,
  );
  await request(
    "/api/connections/revoke",
    { id: connections[0].id },
    sessionToken,
  );
  assert.deepEqual(
    (await request("/api/connections", undefined, sessionToken)).connections,
    [],
  );
  assert.equal(
    (await request("/api/notes", undefined, sessionToken)).notes.length,
    1,
  );
}

/** Verify an authenticated write through the actual HTTP MCP transport. */
async function verifyMcpWrite(
  app: ReturnType<typeof createApp>,
  accessToken: string,
) {
  const response = await app.request(`${origin}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "notes_create",
        arguments: { text: "OAuth MCP acceptance note" },
      },
    }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).result.isError, undefined);
}
