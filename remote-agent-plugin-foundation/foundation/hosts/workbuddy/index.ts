import type { HostFiles, PackageInput } from "../contracts.js";
/** Generate the documented DCR connector shape; platform review and runtime acceptance are separate. */
export function packageWorkbuddy(config: PackageInput): HostFiles {
  return {
    "connector-meta.json": {
      name: config.displayName,
      source: config.name,
      description: config.description,
      type: "mcp",
      auth_mode: "server-side",
      server_auth: {
        auth_type: "mcp_oauth",
        data: {
          mcp_oauth: {
            server_url: `${config.origin}/mcp`,
            scopes: config.auth.scopes.join(" "),
          },
        },
      },
    },
    "mcp.json": {
      mcpServers: {
        [config.name]: { type: "streamableHttp", url: `${config.origin}/mcp` },
      },
    },
  };
}
