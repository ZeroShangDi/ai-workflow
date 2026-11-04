import { cp, mkdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Copy a standalone project without dependencies, credentials, data, history or platform bindings. */
async function main() {
  const [target, name] = process.argv.slice(2);
  if (!target || !name || !/^[a-z][a-z0-9-]{0,63}$/.test(name))
    throw new Error("Usage: npm run create -- <new-directory> <plugin-name>");
  const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
  const destination = resolve(target);
  if (destination === root || destination.startsWith(root + "/"))
    throw new Error("Choose a directory outside this template");
  await mkdir(destination, { recursive: false });
  try {
    for (const file of [
      "foundation",
      "src",
      "skills",
      "tests",
      "docs",
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      "plugin.config.ts",
      ".env.example",
      ".gitignore",
      ".dockerignore",
      "Dockerfile",
      "README.md",
      "AGENTS.md",
    ]) {
      await cp(join(root, file), join(destination, file), { recursive: true });
    }
    // This subprocess uses the template's installed tsx, but the new project has no runtime dependency on it.
    execFileSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        join(root, "foundation/scripts/init.ts"),
        "--name",
        name,
      ],
      { cwd: destination, stdio: "inherit" },
    );
    console.log(
      `Created ${destination}. Run npm ci, npm run check and npm run dev there.`,
    );
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
