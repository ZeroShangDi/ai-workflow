import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { z, ZodError } from "zod";
import { randomUUID } from "node:crypto";
import type {
  AgentConnections,
  Identity,
  Principal,
} from "../contracts/index.js";

export type ServerEnvironment = {
  Variables: { principal: Principal; requestId: string };
};

export type ServerDependencies = {
  identity: Identity;
  connections?: AgentConnections;
  authHandler: (request: Request) => Promise<Response>;
  origin: string;
  log?: (record: Record<string, unknown>) => void;
};

/** Assemble HTTP routes without coupling them to a particular identity or database vendor. */
export function createServer(dependencies: ServerDependencies) {
  const app = new Hono<ServerEnvironment>();
  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
      },
    }),
  );
  app.use("*", async (c, next) => {
    const requestId = randomUUID();
    c.set("requestId", requestId);
    c.header("X-Request-Id", requestId);
    c.header("Cache-Control", "no-store");
    const start = performance.now();
    await next();
    dependencies.log?.({
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Math.round(performance.now() - start),
    });
  });
  app.use(
    "*",
    bodyLimit({
      maxSize: 16 * 1024,
      onError: (c) => c.json({ error: { code: "payload_too_large" } }, 413),
    }),
  );
  app.on(["GET", "POST"], "/api/auth/*", (c) =>
    dependencies.authHandler(c.req.raw),
  );
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.use("/api/*", async (c, next) => {
    // Cookie-authenticated writes require the configured origin; local bearer clients do not.
    if (
      c.req.method !== "GET" &&
      !c.req.header("Authorization") &&
      c.req.header("Origin") !== dependencies.origin
    ) {
      return c.json({ error: { code: "forbidden_origin" } }, 403);
    }
    const principal = await dependencies.identity.resolve(c.req.raw.headers);
    if (!principal) return c.json({ error: { code: "unauthorized" } }, 401);
    c.set("principal", principal);
    await next();
  });
  mountConnections(app, dependencies.connections);
  app.onError((error, c) => {
    const invalid = error instanceof ZodError || error instanceof SyntaxError;
    dependencies.log?.({
      requestId: c.get("requestId"),
      error: invalid ? "invalid_input" : "internal_error",
      kind: error.name,
    });
    return c.json(
      {
        error: {
          code: invalid ? "invalid_input" : "internal_error",
          requestId: c.get("requestId"),
        },
      },
      invalid ? 400 : 500,
    );
  });
  return app;
}

/** Expose credential-free connection management behind the shared authorization guard. */
function mountConnections(
  app: Hono<ServerEnvironment>,
  connections?: AgentConnections,
) {
  app.get("/api/connections", (c) =>
    c.json({
      connections: connections?.list(c.get("principal").id) ?? [],
    }),
  );
  app.post("/api/connections/revoke", async (c) => {
    const { id } = z
      .object({ id: z.string().min(1).max(256) })
      .strict()
      .parse(await c.req.json());
    connections?.revoke(c.get("principal").id, id);
    return c.json({ success: true });
  });
}

export { readSettings } from "./settings.js";
export { startServer } from "./runtime.js";
