import { resolve } from "node:path";
/** Validate deployment settings before opening resources. */
export function readSettings(defaultOrigin: string) {
  const origin = new URL(process.env.APP_ORIGIN ?? defaultOrigin);
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32 || secret.startsWith("replace-with-"))
    throw new Error("AUTH_SECRET must contain at least 32 random characters");
  if (
    origin.protocol !== "https:" &&
    !(
      origin.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(origin.hostname)
    )
  )
    throw new Error("Remote origins require HTTPS");
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("APP_ORIGIN must be a plain origin");
  const port = Number(process.env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT");
  return {
    origin: origin.origin,
    secret,
    port,
    data: resolve(process.env.DATA_DIR ?? ".data"),
  };
}
