import plugin from "../plugin.config.js";
import { notesClient } from "./server/notes/index.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  createClient,
  fileCredentials,
  RemoteError,
  login,
} from "../foundation/client/index.js";
import { createMcp } from "./mcp/index.js";

/** Dispatch local client commands; stdout is reserved for the MCP protocol in serve mode. */
async function main() {
  const credentials = fileCredentials(
    process.env.CREDENTIAL_DIR ??
      join(homedir(), ".remote-agent-plugin", plugin.name),
  );
  const client = createClient(
    process.env.APP_ORIGIN ?? plugin.origin,
    credentials,
  );
  const command = process.argv[2];
  if (command === "login") {
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    await login(
      client.origin,
      credentials,
      (url, code) => console.error(`Open ${url}\nEnter code: ${code}`),
      controller.signal,
      plugin.auth.deviceClientId,
    );
    console.error("Login complete.");
    return;
  }
  if (command === "logout") {
    try {
      await client.request("/api/auth/sign-out", {});
    } catch (error) {
      if (!(error instanceof RemoteError && error.status === 401)) throw error;
    }
    await credentials.remove(client.origin);
    console.error("Logged out.");
    return;
  }
  if (command === "status") {
    await notesClient(client).list();
    console.error("Authenticated.");
    return;
  }
  if (command === "serve") {
    const server = createMcp(notesClient(client));
    await server.connect(new StdioServerTransport());
    return;
  }
  throw new Error("Usage: cli login | logout | status | serve");
}
main().catch((error) => {
  console.error(
    error instanceof RemoteError
      ? error.message
      : "Client failed; check configuration, connectivity and local credential permissions.",
  );
  process.exitCode = 1;
});
