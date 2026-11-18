import { coordinationApi } from '../workspace/coordination-api.ts';
import { workerAuthentication } from '../workspace/credentials.ts';
import { workspaceApi } from '../workspace/api.ts';
import { lfsCredential } from '../features/repositories/lfs-ssh-credential.ts';
import { requireAuth, error } from './shared.ts';
import { RequestBodyTooLargeError } from '../kernel/http.ts';
import { type ApiRouteContext } from './context.ts';

export const workspaceRoutes = async (ctx: ApiRouteContext): Promise<boolean> => {
  const { req, res, workspacePath } = ctx;
  try {
    await (async () => {
      if (req.headers['x-deploy-agent-token']) return coordinationApi(req, res);
      const worker = workerAuthentication(req);
      if (worker) return workspaceApi(req, res, worker.owner, worker.workerId);
      // Git LFS over an SSH remote: the RemoteAuth credential git-lfs-authenticate minted.
      // workspaceApi limits it to that repository's /info/lfs/ routes.
      const lfs = workspacePath.startsWith('/api/git/')
        ? lfsCredential(req.headers.authorization)
        : null;
      if (lfs) return workspaceApi(req, res, lfs.owner, undefined, lfs);
      // Git's standard Basic password is the existing deploy session token.
      const basic = req.headers.authorization;
      if (basic?.startsWith('Basic ')) {
        const decoded = Buffer.from(basic.slice(6), 'base64').toString();
        const split = decoded.indexOf(':');
        req.headers['x-deploy-username'] = decoded.slice(0, split);
        req.headers['x-deploy-token'] = decoded.slice(split + 1);
      }
      if (workspacePath.startsWith('/api/git/'))
        res.setHeader('WWW-Authenticate', 'Basic realm="deploy.local Git"');
      const auth = requireAuth(req, res);
      if (!auth) return;
      return workspaceApi(req, res, auth.username);
    })();
    return true;
  } catch (err: unknown) {
    console.error(err);
    error(
      res,
      (err as Error).message || 'Internal server error',
      err instanceof RequestBodyTooLargeError
        ? 413
        : (err as Error & { status?: number }).status || 500,
    );
    return true;
  }
};
