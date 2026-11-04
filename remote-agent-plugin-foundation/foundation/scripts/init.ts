import { format } from "prettier";
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { writeFile, readFile, mkdir } from "node:fs/promises";

/** Initialize a copied project; never replace existing private configuration. */
async function main() {
  const { values } = parseArgs({
    options: { name: { type: "string" }, "display-name": { type: "string" } },
  });
  if (values.name) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(values.name))
      throw new Error("Use a kebab-case plugin name");
    const config = {
      name: values.name,
      displayName: values["display-name"] ?? values.name,
      version: "0.1.0",
      description: "请填写插件介绍",
      origin: "http://localhost:8787",
      auth: {
        scopes: ["notes", "offline_access"],
        accessScope: "notes",
        deviceClientId: `${values.name}-cli`,
      },
      hosts: { codex: { appId: "" } },
    };
    await writeFile(
      "plugin.config.ts",
      await format(
        "/** Public product configuration; never store credentials here. */\nexport default " +
          JSON.stringify(config, null, 2) +
          ";\n",
        { parser: "typescript" },
      ),
    );
    await mkdir(".agents/plugins", { recursive: true });
    await writeFile(
      ".agents/plugins/marketplace.json",
      JSON.stringify(
        {
          name: `${values.name}-local`,
          plugins: [
            {
              name: values.name,
              source: { source: "local", path: "./artifacts/codex" },
              policy: {
                installation: "AVAILABLE",
                authentication: "ON_INSTALL",
              },
              category: "Productivity",
            },
          ],
        },
        null,
        2,
      ) + "\n",
    );
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    pkg.name = values.name;
    await writeFile("package.json", JSON.stringify(pkg, null, 2) + "\n");
    const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
    lock.name = values.name;
    lock.packages[""].name = values.name;
    await writeFile("package-lock.json", JSON.stringify(lock, null, 2) + "\n");
  }
  try {
    await writeFile(
      ".env",
      `APP_ORIGIN=http://localhost:8787\nAUTH_SECRET=${randomBytes(32).toString("hex")}\nPORT=8787\nDATA_DIR=.data\n`,
      { flag: "wx", mode: 0o600 },
    );
    console.log("Created private .env");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    console.log("Kept existing .env");
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
