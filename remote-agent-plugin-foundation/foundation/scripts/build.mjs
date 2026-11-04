import { execFileSync } from "node:child_process";
import { cp, rm } from "node:fs/promises";
// Build a self-contained runtime tree; stale files must not mask broken imports.
await rm("dist", { recursive: true, force: true });
execFileSync(process.execPath, ["node_modules/typescript/bin/tsc"], {
  stdio: "inherit",
});
await cp("src/web", "dist/src/web", { recursive: true });
await cp("foundation/web", "dist/foundation/web", { recursive: true });
