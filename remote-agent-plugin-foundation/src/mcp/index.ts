import plugin from "../../plugin.config.js";
import { createMcpHttp as mountMcpHttp } from "../../foundation/mcp/index.js";
import type { OAuthAuthority } from "../../foundation/contracts/index.js";
import { createNotes, type NotesRepository } from "../server/notes/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { NotesApi } from "../server/notes/index.js";

/** Create a transport-independent MCP surface around the public business client. */
export function createMcp(notes: NotesApi) {
  const server = new McpServer({ name: plugin.name, version: plugin.version });
  /** Translate failures without exposing credentials or raw dependency exceptions. */
  const invoke = async (operation: () => Promise<unknown>) => {
    try {
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(await operation()) },
        ],
      };
    } catch {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: "Request failed. Check the service and CLI login. For a failed create, read notes before retrying: the write may have completed.",
          },
        ],
      };
    }
  };
  server.registerTool(
    "notes_list",
    {
      description: "List up to 100 newest personal notes.",
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    () => invoke(() => notes.list()),
  );
  server.registerTool(
    "notes_create",
    {
      description:
        "Create a personal note. If the result is unknown, list notes before retrying.",
      inputSchema: { text: z.string().trim().min(1).max(4000) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    ({ text }) => invoke(() => notes.create(text)),
  );
  return server;
}

/** Bind each HTTP MCP request to its authenticated business owner. */
export function createMcpHttp(
  origin: string,
  authority: OAuthAuthority,
  repository: NotesRepository,
) {
  const notes = createNotes(repository);
  return mountMcpHttp(
    origin,
    authority,
    (principal) =>
      createMcp({
        list: async () => notes.list(principal.id),
        create: async (text) => notes.create(principal.id, { text }),
      }),
    plugin.auth.scopes,
  );
}
