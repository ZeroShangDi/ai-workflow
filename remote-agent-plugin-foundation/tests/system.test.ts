import plugin from "../plugin.config.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openStorage } from "../src/server/notes/index.js";
import { createIdentity } from "../foundation/auth/index.js";
import { createApp } from "../src/server/index.js";

const origin = "http://localhost:8787";

/** Create a protocol requester for the in-process HTTP handler. */
function requester(app: ReturnType<typeof createApp>) {
  return async (path: string, body?: unknown, token?: string) =>
    app.request(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

/** Exercise real auth, persistence and HTTP together without external credentials. */
test("device grant, isolated notes, invalid input and revocation", async () => {
  const storage = openStorage(":memory:");
  try {
    const auth = await createIdentity(
      storage.database,
      origin,
      "test-only-strong-secret-with-at-least-32-characters",
      plugin.auth,
    );
    const app = createApp({
      identity: auth.identity,
      authHandler: auth.handler,
      repository: storage.repository,
      origin,
    });
    const call = requester(app);
    assert.equal((await call("/api/notes")).status, 401);
    const signup = await call("/api/auth/sign-up/email", {
      name: "Alice",
      email: "alice@example.test",
      password: "correct-horse-battery",
    });
    assert.equal(signup.status, 200, await signup.clone().text());
    const alice = (await signup.json()).token;
    const bobSignup = await call("/api/auth/sign-up/email", {
      name: "Bob",
      email: "bob@example.test",
      password: "correct-horse-battery",
    });
    const bob = (await bobSignup.json()).token;
    assert.equal(
      (await call("/api/notes", { text: "Private note" }, alice)).status,
      201,
    );
    assert.deepEqual(
      (await (await call("/api/notes", undefined, bob)).json()).notes,
      [],
    );
    assert.equal((await call("/api/notes", { text: " " }, alice)).status, 400);
    assert.equal(
      (await call("/api/notes", { text: "x", owner: "someone-else" }, alice))
        .status,
      400,
    );
    const grantResponse = await call("/api/auth/device/code", {
      client_id: plugin.auth.deviceClientId,
    });
    assert.equal(grantResponse.status, 200, await grantResponse.clone().text());
    const grant = await grantResponse.json();
    const verify = await call(
      `/api/auth/device?user_code=${grant.user_code}`,
      undefined,
      alice,
    );
    assert.equal(verify.status, 200, await verify.clone().text());
    assert.equal(
      (
        await call(
          "/api/auth/device/approve",
          { userCode: grant.user_code },
          bob,
        )
      ).status,
      403,
    );
    const approve = await call(
      "/api/auth/device/approve",
      { userCode: grant.user_code },
      alice,
    );
    assert.equal(approve.status, 200, await approve.clone().text());
    const tokenBody = {
      client_id: plugin.auth.deviceClientId,
      device_code: grant.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    };
    const redemption = await call("/api/auth/device/token", tokenBody);
    assert.equal(redemption.status, 200, await redemption.clone().text());
    const device = (await redemption.json()).access_token;
    assert.equal(
      (await (await call("/api/notes", undefined, device)).json()).notes.length,
      1,
    );
    assert.notEqual(
      (await call("/api/auth/device/token", tokenBody)).status,
      200,
    );
    assert.equal((await call("/api/auth/sign-out", {}, device)).status, 200);
    assert.equal((await call("/api/notes", undefined, device)).status, 401);
    assert.equal((await call("/api/notes", undefined, alice)).status, 200);
  } finally {
    storage.close();
  }
});
