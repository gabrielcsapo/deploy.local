type Body = Record<string, unknown>;
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;

export class WorkspaceRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'WorkspaceRequestError';
  }
}

export function workspaceConnectionMessage(error: unknown) {
  return error instanceof WorkspaceRequestError && error.status === 401
    ? 'Your session has expired. Sign in again to continue. Your conversation and draft are preserved.'
    : 'Connection interrupted. Showing the last received state; reconnecting…';
}

/** Persist before dispatch. A retry after reconnect must use the original revision too. */
export function prepareCommand(storage: Storage, username: string, path: string, body: Body) {
  const identity = { ...body };
  if (/^\/tasks\/[^/]+\/messages$/.test(path)) delete identity.revision;
  const key = 'workspace-command-v2:' + JSON.stringify([username, path, identity]);
  const saved = storage.getItem(key);
  if (saved !== null) {
    const payload = JSON.parse(saved);
    if (!payload || typeof payload.operationId !== 'string')
      throw new Error('The saved send could not be read. It has been preserved for recovery.');
    return { key, payload };
  }
  const payload = { ...body, operationId: crypto.randomUUID() };
  storage.setItem(key, JSON.stringify(payload));
  return { key, payload };
}

export async function workspaceRequest(
  path: string,
  body: Body | undefined,
  auth: { username: string; token: string } | null,
  storage: Storage,
  request: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  const pending = body ? prepareCommand(storage, auth?.username || '', path, body) : null;
  const res = await request('/api/workspace' + path, {
    signal,
    method: body ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { 'x-deploy-username': auth.username, 'x-deploy-token': auth.token } : {}),
    },
    ...(pending ? { body: JSON.stringify(pending.payload) } : {}),
  });
  const data = await res.json();
  if (!res.ok) {
    // Only definitive command rejection releases the ID; transport/auth/rate limits retain it.
    if (pending && [400, 409, 422].includes(res.status)) storage.removeItem(pending.key);
    throw new WorkspaceRequestError(res.status, data.error || 'Request failed');
  }
  if (pending) storage.removeItem(pending.key);
  return data;
}
