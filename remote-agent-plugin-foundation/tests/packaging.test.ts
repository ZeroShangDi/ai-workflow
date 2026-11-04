import { test } from "node:test";
import assert from "node:assert/strict";
import config from "../plugin.config.js";
import { packageHost } from "../foundation/hosts/index.js";

/** Protect the transport/association distinction that previously prevented MCP discovery. */
test("host packaging keeps OAuth bindings and transport conventions distinct", () => {
  const direct = packageHost(
    "codex",
    { ...config, hosts: { codex: { appId: "" } } },
    "/app/cli.js",
  );
  assert.ok(direct[".mcp.json"]);
  assert.equal(direct[".app.json"], undefined);
  const linked = packageHost(
    "codex",
    { ...config, hosts: { codex: { appId: "asdk_app_test" } } },
    "/app/cli.js",
  );
  assert.ok(linked[".app.json"]);
  assert.equal(linked[".mcp.json"], undefined);
  assert.throws(() => packageHost("doubao", config, "/app/cli.js"), /HTTPS/);
  const remote = { ...config, origin: "https://example.test" };
  const workbuddy = packageHost("workbuddy", remote, "/app/cli.js");
  const doubao = packageHost("doubao", remote, "/app/cli.js");
  assert.equal(
    (workbuddy["mcp.json"] as any).mcpServers[config.name].type,
    "streamableHttp",
  );
  assert.equal(
    (doubao["mcp.json"] as any).mcpServers[config.name].type,
    "streamable-http",
  );
  assert.throws(
    () => packageHost("../unknown", remote, "/app/cli.js"),
    /Unsupported/,
  );
});
