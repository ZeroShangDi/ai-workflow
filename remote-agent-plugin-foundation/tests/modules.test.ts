import { notesClient } from "../src/server/notes/index.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createClient,
  fileCredentials,
  serverOrigin,
} from "../foundation/client/index.js";
import { createNotes } from "../src/server/notes/index.js";
import { createMcp } from "../src/mcp/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Credentials } from "../foundation/contracts/index.js";
import type { Note } from "../src/server/notes/index.js";

/** Verify domain behavior using a small replacement repository. */
test("business module validates before writing and uses owner contract", () => {
  const records = new Map<string, Note[]>();
  const service = createNotes({
    list: (owner) => records.get(owner) ?? [],
    create: (owner, note) =>
      records.set(owner, [...(records.get(owner) ?? []), note]),
  });
  assert.throws(() => service.create("a", { text: "" }));
  assert.equal(records.size, 0);
  service.create("a", { text: " hello " });
  assert.equal(service.list("a")[0].text, "hello");
  assert.deepEqual(service.list("b"), []);
});

/** Verify credential isolation and private filesystem permissions. */
test("credentials are private, per-origin and replaceable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plugin-credentials-"));
  try {
    const store = fileCredentials(dir);
    await store.write("https://one.test", "private-token");
    assert.equal(await store.read("https://two.test"), null);
    assert.equal(await store.read("https://one.test"), "private-token");
    const files = await readdir(dir);
    assert.equal((await stat(join(dir, files[0]))).mode & 0o777, 0o600);
    await store.remove("https://one.test");
    await store.remove("https://one.test");
    assert.equal(await store.read("https://one.test"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** Unknown writes must not be retried or leak to redirected destinations. */
test("API transport is bounded, fixed-origin and never retries writes", async () => {
  assert.throws(() => serverOrigin("http://remote.test"));
  assert.throws(() => serverOrigin("https://user:password@remote.test"));
  let calls = 0;
  const credentials: Credentials = {
    read: async () => "secret",
    write: async () => {},
    remove: async () => {},
  };
  const transport = (async (_url: unknown, options: RequestInit) => {
    calls++;
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    throw new Error("disconnected after write");
  }) as typeof fetch;
  await assert.rejects(
    notesClient(
      createClient("https://remote.test", credentials, transport),
    ).create("hello"),
  );
  assert.equal(calls, 1);
});

/** Verify the real MCP protocol using an in-memory transport and fake business client. */
test("MCP tools preserve contract and report dependency failure", async () => {
  const server = createMcp({
    list: async () => [],
    create: async () => {
      throw new Error("secret must not leak");
    },
  });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    assert.equal((await client.listTools()).tools.length, 2);
    const list = await client.callTool({ name: "notes_list", arguments: {} });
    assert.equal(list.isError, undefined);
    const failed = await client.callTool({
      name: "notes_create",
      arguments: { text: "hello" },
    });
    assert.equal(failed.isError, true);
    assert.ok(!JSON.stringify(failed).includes("secret must not leak"));
  } finally {
    await client.close();
    await server.close();
  }
});
