import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Credentials } from "../contracts/index.js";
import { createClient, RemoteError } from "./api.js";

const grantSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string().url(),
  expires_in: z.number().positive(),
  interval: z.number().positive().default(5),
});

/** Run first-party device authorization; secrets are never passed to the display callback. */
export async function login(
  base: string,
  credentials: Credentials,
  display: (url: string, code: string) => void,
  signal?: AbortSignal,
  clientId = "foundation-cli",
) {
  const client = createClient(base, credentials);
  const grant = grantSchema.parse(
    await client.request(
      "/api/auth/device/code",
      { client_id: clientId },
      false,
      signal,
    ),
  );
  if (new URL(grant.verification_uri).origin !== client.origin)
    throw new Error("Unexpected verification origin");
  display(grant.verification_uri, grant.user_code);
  const expires = Date.now() + Math.min(grant.expires_in, 1800) * 1000;
  let interval = Math.max(grant.interval, 1) * 1000;
  while (Date.now() < expires) {
    await delay(interval, undefined, { signal });
    try {
      const token = await client.request(
        "/api/auth/device/token",
        {
          client_id: clientId,
          device_code: grant.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        },
        false,
        signal,
      );
      const parsed = z.object({ access_token: z.string().min(1) }).parse(token);
      await credentials.write(client.origin, parsed.access_token);
      return;
    } catch (error) {
      if (
        error instanceof RemoteError &&
        error.code === "authorization_pending"
      )
        continue;
      if (error instanceof RemoteError && error.code === "slow_down") {
        interval += 5000;
        continue;
      }
      throw error;
    }
  }
  throw new Error("Authorization expired; start login again");
}
