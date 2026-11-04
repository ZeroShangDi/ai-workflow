import type { Credentials } from "../contracts/index.js";
export { fileCredentials } from "./credentials.js";

/** Validate a credential destination before sending any authentication material. */
export function serverOrigin(value: string) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Use a plain server origin");
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname)
    )
  )
    throw new Error("Remote servers require HTTPS");
  return url.origin;
}

/** Represent a safe remote failure without exposing response bodies or credentials. */
export class RemoteError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(`Remote request failed: ${code} (${status})`);
  }
}

/** Build a bounded API client. Redirects and implicit write retries are deliberately disabled. */
export function createClient(
  base: string,
  credentials: Credentials,
  transport: typeof fetch = fetch,
) {
  const origin = serverOrigin(base);
  /** Call one fixed-origin endpoint, optionally with the locally stored session. */
  async function request(
    path: string,
    body?: unknown,
    authenticated = true,
    signal?: AbortSignal,
  ) {
    const token = authenticated ? await credentials.read(origin) : null;
    if (authenticated && !token) throw new RemoteError(401, "login_required");
    const response = await transport(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
      const candidate =
        typeof data.error === "string" ? data.error : data.error?.code;
      const code =
        typeof candidate === "string" && /^[a-z_]{1,64}$/.test(candidate)
          ? candidate
          : "request_failed";
      throw new RemoteError(response.status, code);
    }
    return data;
  }
  return { origin, request };
}
