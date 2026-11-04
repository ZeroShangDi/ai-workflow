import plugin from "../plugin.config.js";
import { readFile } from "node:fs/promises";
import { createApp, type openStorage } from "./server/index.js";
import type { createIdentity } from "../foundation/auth/index.js";
import { createMcpHttp } from "./mcp/index.js";
/** Compose this plugin's public server, tools and pages without importing private implementations. */
export async function createApplication(
  origin: string,
  storage: ReturnType<typeof openStorage>,
  auth: Awaited<ReturnType<typeof createIdentity>>,
) {
  const app = createApp({
    ...auth,
    authHandler: auth.handler,
    repository: storage.repository,
    origin: origin,
    log: (record) => console.error(JSON.stringify(record)),
  });
  app.get("/.well-known/oauth-authorization-server/api/auth", (c) =>
    auth.handler(c.req.raw),
  );
  app.route("/", createMcpHttp(origin, auth.oauth, storage.repository));
  const web = new URL("./web/", import.meta.url);
  const sharedWeb = new URL("../foundation/web/", import.meta.url);
  const html = (await readFile(new URL("index.html", web), "utf8"))
    .replace(
      "{{ACCOUNT}}",
      await readFile(new URL("account.html", sharedWeb), "utf8"),
    )
    .replace(
      "{{AUTHORIZATION}}",
      await readFile(new URL("authorization.html", sharedWeb), "utf8"),
    )
    .replaceAll("{{PLUGIN_NAME}}", plugin.displayName);
  const script = await readFile(new URL("app.js", web), "utf8");
  const style = await readFile(new URL("style.css", web), "utf8");
  app.get("/", (c) => c.html(html));
  app.get("/device", (c) => c.html(html));
  app.get("/connect", (c) => c.html(html));
  for (const file of ["account.js", "connection.js"]) {
    const content = await readFile(new URL(file, sharedWeb), "utf8");
    app.get(`/foundation/${file}`, (c) =>
      c.body(content, 200, { "Content-Type": "text/javascript" }),
    );
  }
  app.get("/app.js", (c) =>
    c.body(script, 200, { "Content-Type": "text/javascript" }),
  );
  app.get("/style.css", (c) =>
    c.body(style, 200, { "Content-Type": "text/css" }),
  );
  return app;
}
