import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Principal, OAuthAuthority } from "../contracts/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Mount stateless MCP with per-request identity; no user state is shared between transports. */
export function createMcpHttp(
  origin: string,
  authority: OAuthAuthority,
  createServer: (principal: Principal) => McpServer,
  scopes: string[],
) {
  const app = new Hono();
  app.get("/.well-known/oauth-protected-resource/mcp", (c) =>
    c.json({
      resource: `${origin}/mcp`,
      authorization_servers: [`${origin}/api/auth`],
      scopes_supported: scopes,
      bearer_methods_supported: ["header"],
    }),
  );
  app.post("/api/connection-context", async (c) => {
    if (c.req.header("Origin") !== origin)
      return c.json({ error: "forbidden_origin" }, 403);
    const body = await c.req.json();
    if (typeof body.query !== "string")
      return c.json({ error: "invalid_query" }, 400);
    const context = await authority.consent(body.query);
    return context
      ? c.json(context)
      : c.json({ error: "invalid_or_expired_authorization" }, 400);
  });
  app.all("/mcp", async (c) => {
    const incomingOrigin = c.req.header("Origin");
    if (incomingOrigin && incomingOrigin !== origin)
      return c.json({ error: "forbidden_origin" }, 403);
    const principal = await authority.resolve(c.req.raw);
    if (!principal) {
      c.header(
        "WWW-Authenticate",
        `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
      );
      return c.json({ error: "invalid_token" }, 401);
    }
    const server = createServer(principal);
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });
  return app;
}
