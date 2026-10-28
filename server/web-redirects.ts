import type { IncomingMessage, ServerResponse } from 'node:http';
import { permanentRedirectResponse } from '../app/routes/dashboard/v2-redirects.ts';

type ProjectResolver = (
  request: Request,
  application: string,
) => Promise<string | null | undefined>;

async function projectForApplication(request: Request, application: string) {
  let username = request.headers.get('x-deploy-username') || undefined;
  let token = request.headers.get('x-deploy-token') || undefined;
  if (!username || !token) {
    const cookie = request.headers
      .get('cookie')
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('deploy-sh-auth='));
    try {
      const decoded = decodeURIComponent(cookie?.slice('deploy-sh-auth='.length) || '');
      const separator = decoded.indexOf(':');
      if (separator >= 0) {
        username = decoded.slice(0, separator);
        token = decoded.slice(separator + 1);
      }
    } catch {
      return undefined;
    }
  }
  // Browser-local credentials are unavailable to SSR. Let the client fallback resolve them.
  if (!username || !token) return undefined;
  const { authenticate } = await import('./store.ts');
  if (!authenticate(username, token)) return undefined;
  const { list } = await import('./workspace/store.ts');
  const { repositoryInfo } = await import('./workspace/repositories.ts');
  for (const project of list('project', username)) {
    const repository = await repositoryInfo(username, project.id);
    if ('deployment' in repository && repository.deployment.application === application)
      return project.id as string;
  }
  return null;
}

/** Runs after API/proxy routing and before either Vite or production RSC/SSR. */
export async function handleWebRedirect(
  req: IncomingMessage,
  res: ServerResponse,
  resolveProject: ProjectResolver = projectForApplication,
): Promise<boolean> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value && !name.startsWith(':'))
      headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  const request = new Request(new URL(req.url || '/', 'http://deploy.local'), {
    method: req.method || 'GET',
    headers,
  });
  let clientFallback = false;
  const redirect = await permanentRedirectResponse(request, async (application) => {
    try {
      const project = await resolveProject(request, application);
      if (project === undefined) clientFallback = true;
      return project ?? null;
    } catch {
      clientFallback = true;
      return null;
    }
  });
  if (!redirect || clientFallback) return false;
  res.writeHead(redirect.status, {
    Location: redirect.headers.get('Location')!,
    'Cache-Control': 'private, no-store',
  });
  res.end();
  return true;
}
