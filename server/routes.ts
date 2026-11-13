import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * A feature's HTTP routes as a table: method, path pattern, optional input parsing and a handler.
 *
 * Patterns are literal paths with `:name` for one segment (`[^/]+`) and `:name*` for one or more
 * segments (`.+?`). Parameters arrive raw, exactly as they appear in the path, so a handler decodes
 * them where it needs to and a bad escape fails where it always did.
 *
 * Routes are tried in order. A handler writes its own response; returning `false` means "not
 * mine" and dispatch goes on to the next route. Method `'*'` matches any method, which is how a
 * table ends a path with its own 405.
 */
export type Method = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

type SegmentParam<S extends string> = S extends `:${infer Name}*`
  ? { [K in Name]: string }
  : S extends `:${infer Name}`
    ? { [K in Name]: string }
    : {};

/** `'/a/:id/files/:rest*'` → `{ id: string; rest: string }`. */
export type PathParams<P extends string> = P extends `${infer Head}/${infer Tail}`
  ? SegmentParam<Head> & PathParams<Tail>
  : SegmentParam<P>;

export interface RouteRequest<C, P = Record<string, string>, I = undefined> {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** The path the table matched against (see `DispatchOptions.path`). */
  path: string;
  params: P;
  input: I;
  context: C;
}

export interface RouteSpec<C, P extends string, I> {
  method: Method | readonly Method[] | '*';
  path: P;
  /** Reads the request's input before the handler runs, e.g. a JSON body. */
  input?: (req: IncomingMessage, request: RouteRequest<C, PathParams<P>, undefined>) => I;
  handler: (request: RouteRequest<C, PathParams<P>, Awaited<I>>) => unknown;
}

export interface Route<C> {
  readonly method: Method | readonly Method[] | '*';
  readonly path: string;
  match(path: string): Record<string, string> | null;
  run(request: RouteRequest<C, any, undefined>): Promise<unknown>;
}

function escape(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function compilePath(pattern: string) {
  const names: string[] = [];
  const source = pattern
    .split('/')
    .map((segment) => {
      const param = segment.match(/^:([A-Za-z_][A-Za-z0-9_]*)(\*)?$/);
      if (!param) return escape(segment);
      names.push(param[1]);
      return param[2] ? '(.+?)' : '([^/]+)';
    })
    .join('/');
  const regex = new RegExp(`^${source}$`);
  return (path: string) => {
    const found = regex.exec(path);
    if (!found) return null;
    const params: Record<string, string> = {};
    names.forEach((name, index) => (params[name] = found[index + 1]));
    return params;
  };
}

/** Typed route constructor for a feature's context: `const route = routes<Ctx>();`. */
export function routes<C>() {
  return function route<const P extends string, I = undefined>(spec: RouteSpec<C, P, I>): Route<C> {
    const match = compilePath(spec.path);
    return {
      method: spec.method,
      path: spec.path,
      match,
      async run(request) {
        const input = spec.input ? await spec.input(request.req, request as any) : undefined;
        return spec.handler({ ...request, input } as any);
      },
    };
  };
}

function allows(method: Route<unknown>['method'], actual: string | undefined) {
  if (method === '*') return true;
  return typeof method === 'string' ? method === actual : method.includes(actual as Method);
}

export interface DispatchOptions<C> {
  /** Requests outside this prefix or pattern are not this feature's: dispatch returns false. */
  scope?: string | RegExp | ((path: string) => boolean);
  /** The path routes match against. Defaults to the URL's pathname. */
  path?: (url: URL, req: IncomingMessage) => string;
  /** Runs when the request is in scope but no route took it. Without it, dispatch returns false. */
  notFound?: (request: RouteRequest<C, {}, undefined>) => unknown;
}

/**
 * Turns a table into the `(req, res, context) => handled` shape `server/v2/api.ts` chains, so a
 * converted feature drops into the same place in the dispatch order.
 */
export function dispatch<C>(table: readonly Route<C>[], options: DispatchOptions<C> = {}) {
  const inScope =
    options.scope === undefined
      ? () => true
      : typeof options.scope === 'string'
        ? (path: string) => path.startsWith(options.scope as string)
        : options.scope instanceof RegExp
          ? (path: string) => (options.scope as RegExp).test(path)
          : options.scope;
  return async (req: IncomingMessage, res: ServerResponse, context: C): Promise<boolean> => {
    const url = new URL(req.url!, 'http://localhost');
    const path = options.path ? options.path(url, req) : url.pathname;
    if (!inScope(path)) return false;
    for (const route of table) {
      if (!allows(route.method, req.method)) continue;
      const params = route.match(path);
      if (!params) continue;
      const handled = await route.run({ req, res, url, path, params, input: undefined, context });
      if (handled !== false) return true;
    }
    if (!options.notFound) return false;
    await options.notFound({ req, res, url, path, params: {}, input: undefined, context });
    return true;
  };
}
