import { serve } from "@hono/node-server";
/** Run a server and release application resources after connections close. */
export function startServer(
  handler: (request: Request) => Response | Promise<Response>,
  config: { port: number; origin: string },
  close: () => void,
) {
  const server = serve({
    fetch: handler,
    hostname: process.env.HOST ?? "127.0.0.1",
    port: config.port,
  });
  console.error(`Listening at ${config.origin}`);
  let stopping = false;
  /** Stop accepting connections before closing the database. */
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close(() => {
      close();
    });
    if ("closeIdleConnections" in server) server.closeIdleConnections();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
