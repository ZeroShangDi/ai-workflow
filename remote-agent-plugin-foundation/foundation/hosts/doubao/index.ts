import type { HostFiles, PackageInput } from "../contracts.js";
/** Generate portable MCP configuration with Doubao display bindings; no credentials are embedded. */
export function packageDoubao(config: PackageInput): HostFiles {
  return {
    "plugin.json": {
      name: config.name,
      version: config.version,
      description: config.description,
      extensions: {
        "com.doubao": {
          mcpServers: {
            [config.name]: {
              displayName: { zh: config.displayName },
              displayDescription: { zh: config.description },
            },
          },
        },
      },
    },
    "mcp.json": {
      mcpServers: {
        [config.name]: { type: "streamable-http", url: `${config.origin}/mcp` },
      },
    },
  };
}
