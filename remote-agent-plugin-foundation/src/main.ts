import { createApplication } from "./app.js";
import { readSettings, startServer } from "../foundation/server/index.js";
import plugin from "../plugin.config.js";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createIdentity } from "../foundation/auth/index.js";
import { openStorage } from "./server/index.js";

/** Compose concrete adapters and start a single-instance server. */
async function main() {
  const config = readSettings(plugin.origin);
  await mkdir(config.data, { recursive: true, mode: 0o700 });
  process.umask(0o077);
  const storage = openStorage(resolve(config.data, "app.db"));
  const auth = await createIdentity(
    storage.database,
    config.origin,
    config.secret,
    plugin.auth,
  );
  const app = await createApplication(config.origin, storage, auth);
  startServer(app.fetch, config, storage.close);
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
