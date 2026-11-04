import type { HostFiles, PackageInput } from "../contracts.js";
/** Generate a local stdio configuration example; installation remains version-specific. */
export function packageDsh(config: PackageInput, cliPath: string): HostFiles {
  return {
    "mcp-entry.json": {
      id: `mcp-${config.name}`,
      name: "@deepseek-ai/dsh-mcp-client",
      config: {
        serverName: config.name,
        transport: "stdio",
        command: process.execPath,
        args: [cliPath, "serve"],
        env: { APP_ORIGIN: config.origin },
      },
    },
  };
}
