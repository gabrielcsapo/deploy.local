import type { Plugin, ViteDevServer } from "vite";

/**
 * Vite plugin that serves API routes during dev mode.
 * Intercepts /api/* requests and forwards them to the Hono app
 * via ssrLoadModule (so HMR works for API code too).
 *
 * Must be added BEFORE flightRouter() in the plugins array so it
 * runs before the flight router's catch-all middleware.
 */
export function apiPlugin(): Plugin {
  return {
    name: "example:api-middleware",
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? "/";

        if (!url.startsWith("/api/")) {
          return next();
        }

        try {
          const mod = await server.ssrLoadModule("./app/api.ts");
          const apiApp = mod.app;

          if (!apiApp) {
            console.error("[api-plugin] Could not load API app");
            return next();
          }

          const protocol = req.headers["x-forwarded-proto"] || "http";
          const host = req.headers.host || "localhost:5173";
          const fullUrl = `${protocol}://${host}${url}`;

          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (value) {
              headers.set(key, Array.isArray(value) ? value.join(", ") : value);
            }
          }

          let body: ReadableStream<Uint8Array> | null = null;
          if (req.method !== "GET" && req.method !== "HEAD") {
            body = new ReadableStream({
              start(controller) {
                req.on("data", (chunk: Buffer) => {
                  controller.enqueue(new Uint8Array(chunk));
                });
                req.on("end", () => {
                  controller.close();
                });
                req.on("error", (err) => {
                  controller.error(err);
                });
              },
            });
          }

          const request = new Request(fullUrl, {
            method: req.method ?? "GET",
            headers,
            body,
            // @ts-expect-error - Node.js duplex option needed for streaming body
            duplex: body ? "half" : undefined,
          });

          const response = await apiApp.fetch(request);

          res.statusCode = response.status;
          response.headers.forEach((value: string, key: string) => {
            if (key.toLowerCase() !== "transfer-encoding") {
              res.setHeader(key, value);
            }
          });

          if (response.body) {
            const reader = response.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                res.end();
                break;
              }
              res.write(value);
            }
          } else {
            const text = await response.text();
            res.end(text);
          }
        } catch (err) {
          console.error("[api-plugin] Error handling request:", err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end("Internal Server Error");
          }
        }
      });
    },
  };
}
