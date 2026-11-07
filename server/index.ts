// `pnpm server` and `pnpm dev`. Everything is bootServer's; this file adds only what dev needs.
import { bootServer } from './boot.ts';
import { forwardToDevUi } from './dev-ui.ts';
import { notFoundPage } from './error-page.ts';

const VITE_PORT = parseInt(process.env.VITE_PORT || '5173', 10);

// Production holds 2222. A dev server on the same machine must not take it first, or the
// installed server starts without Git SSH.
const DEV_GIT_SSH_PORT = 2223;

void bootServer({
  role: 'single',
  createClient: () => (req, res) =>
    forwardToDevUi(req, res, { hostname: '127.0.0.1', port: VITE_PORT }, () => notFoundPage(res)),
  gitSshPort: process.env.DEPLOY_SSH_PORT ? undefined : DEV_GIT_SSH_PORT,
});
