import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server/index.js";

/** Exercise route failure semantics without a database or authentication provider. */
test("HTTP rejects malformed, oversized and cross-origin writes", async () => {
  let writes = 0;
  const app = createApp({
    identity: { resolve: async () => ({ id: "user", name: "User" }) },
    repository: {
      list: () => [],
      create: () => {
        writes++;
      },
    },
    authHandler: async () => new Response(null, { status: 404 }),
    origin: "https://example.test",
  });
  const malformed = await app.request("/api/notes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://example.test",
    },
    body: "{",
  });
  assert.equal(malformed.status, 400);
  const crossOrigin = await app.request("/api/notes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://attacker.test",
    },
    body: '{"text":"x"}',
  });
  assert.equal(crossOrigin.status, 403);
  const oversized = await app.request("/api/notes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://example.test",
    },
    body: JSON.stringify({ text: "x".repeat(20000) }),
  });
  assert.equal(oversized.status, 413);
  assert.equal(writes, 0);
});

/** Public errors remain safe while the request ID connects them to diagnostic logs. */
test("dependency failures return a traceable safe error", async () => {
  const logs: Record<string, unknown>[] = [];
  const app = createApp({
    identity: {
      resolve: async () => {
        throw new Error("private database password");
      },
    },
    repository: { list: () => [], create: () => {} },
    authHandler: async () => new Response(),
    origin: "https://example.test",
    log: (record) => logs.push(record),
  });
  const response = await app.request("/api/notes");
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.error.requestId, response.headers.get("X-Request-Id"));
  assert.ok(
    logs.some(
      (record) =>
        record.requestId === body.error.requestId &&
        record.error === "internal_error",
    ),
  );
  assert.ok(
    !JSON.stringify([body, logs]).includes("private database password"),
  );
});
