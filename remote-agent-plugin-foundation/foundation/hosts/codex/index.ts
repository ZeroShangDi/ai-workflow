import type { HostFiles, PackageInput } from "../contracts.js";
/** Generate a Codex package using platform association when supplied, direct MCP otherwise. */
export function packageCodex(config: PackageInput): HostFiles {
  const appId = config.hosts.codex.appId;
  return {
    ".codex-plugin/plugin.json": {
      name: config.name,
      version: config.version,
      description: config.description,
      skills: "./skills/",
      ...(appId ? { apps: "./.app.json" } : { mcpServers: "./.mcp.json" }),
      interface: {
        displayName: config.displayName,
        shortDescription: config.description,
        longDescription: config.description,
        category: "Productivity",
        websiteURL: config.origin,
      },
    },
    ...(appId
      ? {
          ".app.json": {
            apps: { [config.name]: { id: appId, required: true } },
          },
        }
      : {
          ".mcp.json": {
            mcpServers: {
              [config.name]: { type: "http", url: `${config.origin}/mcp` },
            },
          },
        }),
  };
}
