import type { IncomingMessage } from 'node:http';
import { assertNoCiRelease } from '../ci-releases.ts';
import { assertCiMutation } from '../ci-fence.ts';

/** Existing request admission, called after authentication and before owner/admin checks. */
export function assertReleaseAdmission(req: IncomingMessage): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const app = new URL(req.url || '/', 'https://localhost').pathname.match(
      /^\/api\/(?:deployments|components)\/([^/]+)/,
    )?.[1];
    if (app) {
      assertNoCiRelease(decodeURIComponent(app));
      assertCiMutation(decodeURIComponent(app));
    }
  }
}
