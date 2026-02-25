import type { ServerActionsManifest, RSCClientManifest, ModuleLoader } from "../shared/types.js";
import type { RouteConfig } from "../router/types.js";
import { RSC_ACTION_HEADER } from "../shared/constants.js";
import type { FlightLogger } from "../shared/logger.js";

// Types for react-server-dom-webpack/server.node
type DecodeReply = (body: string | FormData, manifest: ServerActionsManifest) => Promise<unknown[]>;
type RenderToReadableStream = (
  model: unknown,
  webpackMap: RSCClientManifest,
  options?: { onError?: (error: unknown) => void },
) => ReadableStream;

interface HandleActionOptions {
  request: Request;
  routes: RouteConfig[];
  serverActionsManifest: ServerActionsManifest;
  clientManifest: RSCClientManifest;
  loadModule: ModuleLoader;
  decodeReply: DecodeReply;
  renderToReadableStream: RenderToReadableStream;
  renderRSC: (url: URL, segments?: string[]) => Promise<ReadableStream>;
  /** Performance logger (opt-in via FLIGHT_DEBUG or debug option) */
  logger?: FlightLogger;
}

/**
 * Handle a server action request.
 *
 * Two paths:
 * 1. Programmatic (callServer): X-RSC-Action header present, body encoded via encodeReply.
 *    Returns the action's return value serialized as RSC so useActionState works.
 * 2. Progressive enhancement: native form submission, action ID in form data.
 *    Re-renders the current page after execution.
 */
export async function handleAction(opts: HandleActionOptions): Promise<Response> {
  const {
    request,
    serverActionsManifest,
    clientManifest,
    decodeReply,
    renderToReadableStream,
    renderRSC,
    logger,
  } = opts;

  const contentType = request.headers.get("content-type") ?? "";
  const referer = request.headers.get("referer") ?? "/";
  const url = new URL(referer, request.url);
  const actionId = request.headers.get(RSC_ACTION_HEADER);

  try {
    if (actionId) {
      // Programmatic call via callServer (has X-RSC-Action header)
      // Action IDs have format "moduleId#exportName"
      const hashIndex = actionId.indexOf("#");
      const moduleId = hashIndex >= 0 ? actionId.slice(0, hashIndex) : actionId;
      const exportName = hashIndex >= 0 ? actionId.slice(hashIndex + 1) : "default";

      const manifestEntry = serverActionsManifest[moduleId];
      if (!manifestEntry) {
        return new Response(`Action not found in manifest: ${actionId}`, { status: 404 });
      }

      // Decode arguments - body format depends on what encodeReply produced
      logger?.time("action:decodeArgs");
      let args: unknown[];
      if (
        contentType.includes("multipart/form-data") ||
        contentType.includes("application/x-www-form-urlencoded")
      ) {
        const formData = await request.formData();
        args = (await decodeReply(formData, serverActionsManifest)) as unknown[];
      } else {
        const text = await request.text();
        args = (await decodeReply(text, serverActionsManifest)) as unknown[];
      }
      logger?.timeEnd("action:decodeArgs");

      logger?.time(`action:loadModule(${moduleId})`);
      const mod = await opts.loadModule(manifestEntry.id);
      logger?.timeEnd(`action:loadModule(${moduleId})`);
      const actionFn = mod[exportName] as (...args: unknown[]) => Promise<unknown>;

      if (typeof actionFn !== "function") {
        return new Response(`Action export "${exportName}" is not a function in ${moduleId}`, {
          status: 404,
        });
      }

      // Execute and return the action's return value as RSC stream.
      // This allows useActionState on the client to receive the new state.
      logger?.time(`action:execute(${exportName})`);
      const result = await actionFn(...args);
      logger?.timeEnd(`action:execute(${exportName})`);

      logger?.time("action:serialize");
      let rscStream: ReadableStream = renderToReadableStream(result, clientManifest, {
        onError: (err) => console.error("[react-flight-router] Action RSC error:", err),
      });
      logger?.timeEnd("action:serialize");

      if (logger) {
        rscStream = logger.wrapStream(rscStream, `ACTION ${exportName}`);
      }

      return new Response(rscStream, {
        headers: {
          "Content-Type": "text/x-component",
          "Transfer-Encoding": "chunked",
        },
      });
    } else if (
      contentType.includes("multipart/form-data") ||
      contentType.includes("application/x-www-form-urlencoded")
    ) {
      // Progressive enhancement: native form submission without JavaScript
      const formData = await request.formData();

      // Extract action ID from React's form data encoding ($ACTION_ID_<key>)
      let formActionId: string | null = null;
      for (const [key, value] of formData.entries()) {
        if (key.startsWith("$ACTION_ID")) {
          formActionId = value as string;
          break;
        }
      }

      if (!formActionId) {
        return new Response("No action ID found in form data", { status: 400 });
      }

      const manifestEntry = serverActionsManifest[formActionId];
      if (!manifestEntry) {
        return new Response(`Action not found: ${formActionId}`, { status: 404 });
      }

      logger?.time(`action:loadModule(${formActionId})`);
      const mod = await opts.loadModule(manifestEntry.id);
      logger?.timeEnd(`action:loadModule(${formActionId})`);
      const actionFn = mod[manifestEntry.name] as (...args: unknown[]) => Promise<unknown>;

      if (typeof actionFn !== "function") {
        return new Response(`Action export is not a function: ${formActionId}`, { status: 404 });
      }

      logger?.time(`action:execute(${manifestEntry.name})`);
      await actionFn(formData);
      logger?.timeEnd(`action:execute(${manifestEntry.name})`);

      // Re-render the current page for progressive enhancement
      logger?.time("action:rerender");
      let rscStream = await renderRSC(url);
      logger?.timeEnd("action:rerender");

      if (logger) {
        rscStream = logger.wrapStream(rscStream, `ACTION ${manifestEntry.name} (form)`);
      }

      return new Response(rscStream, {
        headers: {
          "Content-Type": "text/x-component",
          "Transfer-Encoding": "chunked",
        },
      });
    } else {
      return new Response("Invalid action request", { status: 400 });
    }
  } catch (err) {
    console.error("[react-flight-router] Action error:", err);
    return new Response(err instanceof Error ? err.message : "Internal server error", {
      status: 500,
    });
  }
}
