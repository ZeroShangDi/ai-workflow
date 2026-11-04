import { packageCodex } from "./codex/index.js";
import { packageWorkbuddy } from "./workbuddy/index.js";
import { packageDoubao } from "./doubao/index.js";
import { packageDsh } from "./dsh/index.js";
import type { PackageInput } from "./contracts.js";
export type { PackageInput } from "./contracts.js";
/** Select a thin host formatter; host-specific dependencies never enter business code. */
export function packageHost(
  host: string,
  config: PackageInput,
  cliPath: string,
) {
  if (
    ["workbuddy", "doubao"].includes(host) &&
    !config.origin.startsWith("https://")
  )
    throw new Error(`${host} requires a reachable HTTPS origin`);
  switch (host) {
    case "codex":
      return packageCodex(config);
    case "workbuddy":
      return packageWorkbuddy(config);
    case "doubao":
      return packageDoubao(config);
    case "dsh":
      return packageDsh(config, cliPath);
    default:
      throw new Error(`Unsupported host: ${host}`);
  }
}
