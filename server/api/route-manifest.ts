// The coordinator's leaf registry. Each entry selects an existing handler and its own
// credential boundary. No family-wide mount may consume another feature's request.
// Transport wildcards are resource-scoped and dispatched after concrete leaves.
import type { Method } from '../kernel/routes.ts';
export const apiRouteManifest: { method: Method | '*'; path: string; handler: string }[] = [
  {
    method: 'POST',
    path: '/api/agent/enroll',
    handler: 'fleet',
  },
  {
    method: 'GET',
    path: '/api/agent/events',
    handler: 'fleet',
  },
  {
    method: 'POST',
    path: '/api/agent/exec/:part1/exit',
    handler: 'fleet',
  },
  {
    method: 'POST',
    path: '/api/agent/exec/:part1/output',
    handler: 'fleet',
  },
  {
    method: 'POST',
    path: '/api/agent/exec/:part1/poll',
    handler: 'fleet',
  },
  {
    method: 'POST',
    path: '/api/agent/exec/claim',
    handler: 'fleet',
  },
  {
    method: 'POST',
    path: '/api/agent/heartbeat',
    handler: 'fleet',
  },
  {
    method: 'GET',
    path: '/api/agent/jobs/:part1/artifact',
    handler: 'fleet',
  },
  {
    method: 'PUT',
    path: '/api/agent/jobs/:part1/backup',
    handler: 'fleet',
  },
  {
    method: 'POST',
    path: '/api/agent/jobs/:part1/complete',
    handler: 'fleet',
  },
  {
    method: 'POST',
    path: '/api/agent/jobs/:part1/packages',
    handler: 'fleet',
  },
  {
    method: 'POST',
    path: '/api/agent/jobs/:part1/progress',
    handler: 'fleet',
  },
  {
    method: 'POST',
    path: '/api/agent/jobs/claim',
    handler: 'fleet',
  },
  {
    method: 'GET',
    path: '/api/agent/status',
    handler: 'fleet',
  },
  {
    method: 'POST',
    path: '/api/agent/supervisor-swap',
    handler: 'fleet',
  },
  {
    method: 'POST',
    path: '/api/agent/telemetry/v1/server',
    handler: 'fleet',
  },
  {
    method: 'GET',
    path: '/api/catalog',
    handler: 'catalog',
  },
  {
    method: 'GET',
    path: '/api/catalog/releases/:id/:release',
    handler: 'catalog',
  },
  {
    method: 'POST',
    path: '/api/catalog/releases/:id/:release/install',
    handler: 'catalog',
  },
  {
    method: 'POST',
    path: '/api/catalog/releases/:id/:release/install-plan',
    handler: 'catalog',
  },
  {
    method: 'POST',
    path: '/api/catalog/releases/:id/:release/preflight',
    handler: 'catalog',
  },
  {
    method: 'POST',
    path: '/api/catalog/compose-import',
    handler: 'catalog',
  },
  {
    method: 'GET',
    path: '/api/catalog/installations',
    handler: 'catalog',
  },
  {
    method: 'GET',
    path: '/api/catalog/installations/:id',
    handler: 'catalog',
  },
  {
    method: 'POST',
    path: '/api/catalog/installations/:id/derive',
    handler: 'catalog',
  },
  {
    method: 'POST',
    path: '/api/catalog/installations/:id/derive-plan',
    handler: 'catalog',
  },
  {
    method: 'POST',
    path: '/api/catalog/installations/:id/detach',
    handler: 'catalog',
  },
  {
    method: 'POST',
    path: '/api/catalog/installations/:id/detach-plan',
    handler: 'catalog',
  },
  {
    method: 'POST',
    path: '/api/catalog/installations/:id/recovery-points',
    handler: 'catalog',
  },
  {
    method: 'POST',
    path: '/api/catalog/installations/:id/retry',
    handler: 'catalog',
  },
  {
    method: 'POST',
    path: '/api/catalog/installations/:id/rollback',
    handler: 'catalog',
  },
  {
    method: 'POST',
    path: '/api/catalog/installations/:id/rollback-plan',
    handler: 'catalog',
  },
  {
    method: 'POST',
    path: '/api/catalog/installations/:id/uninstall',
    handler: 'catalog',
  },
  {
    method: 'POST',
    path: '/api/catalog/installations/:id/uninstall-plan',
    handler: 'catalog',
  },
  {
    method: 'POST',
    path: '/api/catalog/installations/:id/upgrade',
    handler: 'catalog',
  },
  {
    method: 'POST',
    path: '/api/catalog/installations/:id/upgrade-plan',
    handler: 'catalog',
  },
  {
    method: 'GET',
    path: '/api/catalog/targets',
    handler: 'catalog',
  },
  {
    method: '*',
    path: '/api/ci/credentials',
    handler: 'upload',
  },
  {
    method: 'POST',
    path: '/api/ci/credentials',
    handler: 'upload',
  },
  {
    method: '*',
    path: '/api/ci/credentials/:id([a-f0-9-]+)',
    handler: 'upload',
  },
  {
    method: 'DELETE',
    path: '/api/ci/credentials/:id([a-f0-9-]+)',
    handler: 'upload',
  },
  {
    method: '*',
    path: '/api/ci/owner/releases/:id([a-f0-9-]+)',
    handler: 'upload',
  },
  {
    method: 'GET',
    path: '/api/ci/owner/releases/:id([a-f0-9-]+)',
    handler: 'upload',
  },
  {
    method: '*',
    path: '/api/ci/owner/releases/:id([a-f0-9-]+)/:action(recover|cancel)',
    handler: 'upload',
  },
  {
    method: 'POST',
    path: '/api/ci/owner/releases/:id([a-f0-9-]+)/:action(recover|cancel)',
    handler: 'upload',
  },
  {
    method: 'POST',
    path: '/api/ci/releases',
    handler: 'upload',
  },
  {
    method: 'GET',
    path: '/api/ci/releases/:id([a-f0-9-]+)',
    handler: 'upload',
  },
  {
    method: 'POST',
    path: '/api/ci/releases/:id([a-f0-9-]+)/upload',
    handler: 'upload',
  },
  {
    method: '*',
    path: '/api/ci/releases/:rest*',
    handler: 'upload',
  },
  {
    method: 'GET',
    path: '/api/ci/releases/head',
    handler: 'upload',
  },
  {
    method: 'GET',
    path: '/api/ci/releases/head/upload',
    handler: 'upload',
  },
  {
    method: 'GET',
    path: '/api/computer-roles',
    handler: 'fleet',
  },
  {
    method: 'PATCH',
    path: '/api/computers/:part1/roles',
    handler: 'fleet',
  },
  {
    method: 'GET',
    path: '/api/deploy-admission',
    handler: 'deployments',
  },
  {
    method: 'DELETE',
    path: '/api/deploy-admission/:part1',
    handler: 'deployments',
  },
  {
    method: 'GET',
    path: '/api/deploy-admission/:part1',
    handler: 'deployments',
  },
  {
    method: 'GET',
    path: '/api/deployments',
    handler: 'deployments',
  },
  {
    method: 'POST',
    path: '/api/deployments/:name/components/:component/:action(restart|scale)',
    handler: 'deployments',
  },
  {
    method: 'PUT',
    path: '/api/deployments/:name/components/:component/:action(restart|scale)',
    handler: 'deployments',
  },
  {
    method: 'POST',
    path: '/api/deployments/:name/components/:component/instances/:instance/replace',
    handler: 'deployments',
  },
  {
    method: 'PUT',
    path: '/api/deployments/:name/components/:component/instances/:instance/replace',
    handler: 'deployments',
  },
  {
    method: 'GET',
    path: '/api/deployments/:name/configuration',
    handler: 'deployments',
  },
  {
    method: 'PUT',
    path: '/api/deployments/:name/configuration',
    handler: 'deployments',
  },
  {
    method: 'GET',
    path: '/api/deployments/:name/configuration/:key',
    handler: 'deployments',
  },
  {
    method: 'PUT',
    path: '/api/deployments/:name/configuration/:key',
    handler: 'deployments',
  },
  {
    method: 'DELETE',
    path: '/api/deployments/:part1',
    handler: 'deployments',
  },
  {
    method: 'GET',
    path: '/api/deployments/:part1',
    handler: 'deployments',
  },
  {
    method: 'PATCH',
    path: '/api/deployments/:part1',
    handler: 'deployments',
  },
  {
    method: 'POST',
    path: '/api/deployments/:part1/application-apply',
    handler: 'deployments',
  },
  {
    method: 'POST',
    path: '/api/deployments/:part1/application-plan',
    handler: 'deployments',
  },
  {
    method: 'POST',
    path: '/api/deployments/:part1/application-rebase',
    handler: 'deployments',
  },
  {
    method: 'GET',
    path: '/api/deployments/:part1/application-runtime',
    handler: 'deployments',
  },
  {
    method: 'GET',
    path: '/api/deployments/:part1/application-spec',
    handler: 'deployments',
  },
  {
    method: 'PUT',
    path: '/api/deployments/:part1/application-spec',
    handler: 'deployments',
  },
  {
    method: 'GET',
    path: '/api/deployments/:part1/backups',
    handler: 'backups',
  },
  {
    method: 'POST',
    path: '/api/deployments/:part1/backups',
    handler: 'backups',
  },
  {
    method: 'DELETE',
    path: '/api/deployments/:part1/backups/:part2',
    handler: 'backups',
  },
  {
    method: 'POST',
    path: '/api/deployments/:part1/backups/:part2/restore',
    handler: 'backups',
  },
  {
    method: 'GET',
    path: '/api/deployments/:part1/build-logs',
    handler: 'build-logs',
  },
  {
    method: 'POST',
    path: '/api/deployments/:part1/components/:part2/operations/:part3',
    handler: 'deployments',
  },
  {
    method: 'GET',
    path: '/api/deployments/:part1/deploy.yaml',
    handler: 'deployments',
  },
  {
    method: 'GET',
    path: '/api/deployments/:part1/health',
    handler: 'health',
  },
  {
    method: 'GET',
    path: '/api/deployments/:part1/history',
    handler: 'containers',
  },
  {
    method: 'GET',
    path: '/api/deployments/:part1/inspect',
    handler: 'containers',
  },
  {
    method: 'GET',
    path: '/api/deployments/:part1/logs',
    handler: 'deployments',
  },
  {
    method: 'GET',
    path: '/api/deployments/:part1/migration-progress',
    handler: 'deployments',
  },
  {
    method: 'POST',
    path: '/api/deployments/:part1/node',
    handler: 'deployments',
  },
  {
    method: 'PUT',
    path: '/api/deployments/:part1/node',
    handler: 'deployments',
  },
  {
    method: 'POST',
    path: '/api/deployments/:part1/recreate',
    handler: 'containers',
  },
  {
    method: 'GET',
    path: '/api/deployments/:part1/requests',
    handler: 'requests',
  },
  {
    method: 'POST',
    path: '/api/deployments/:part1/restart',
    handler: 'containers',
  },
  {
    method: 'GET',
    path: '/api/deployments/:part1/stats',
    handler: 'containers',
  },
  {
    method: 'POST',
    path: '/api/login',
    handler: 'auth',
  },
  {
    method: 'GET',
    path: '/api/logout',
    handler: 'auth',
  },
  {
    method: 'GET',
    path: '/api/nodes',
    handler: 'fleet',
  },
  {
    method: 'DELETE',
    path: '/api/nodes/:part1',
    handler: 'fleet',
  },
  {
    method: 'PUT',
    path: '/api/nodes/default',
    handler: 'fleet',
  },
  {
    method: 'POST',
    path: '/api/nodes/enrollment',
    handler: 'fleet',
  },
  {
    method: 'GET',
    path: '/api/operations/recovery-bundles',
    handler: 'auth',
  },
  {
    method: 'POST',
    path: '/api/operations/recovery-bundles',
    handler: 'auth',
  },
  {
    method: 'POST',
    path: '/api/operations/recovery-bundles/:id/rehearsal',
    handler: 'auth',
  },
  {
    method: 'POST',
    path: '/api/operations/recovery-bundles/restore',
    handler: 'auth',
  },
  {
    method: 'POST',
    path: '/api/operations/recovery-bundles/verify',
    handler: 'auth',
  },
  {
    method: 'GET',
    path: '/api/operations/release-readiness',
    handler: 'auth',
  },
  {
    method: 'POST',
    path: '/api/operations/support-bundles',
    handler: 'auth',
  },
  {
    method: 'POST',
    path: '/api/register',
    handler: 'auth',
  },
  {
    method: 'GET',
    path: '/api/search',
    handler: 'v2:v2/search',
  },
  {
    method: 'GET',
    path: '/api/search/code',
    handler: 'v2:v2/search',
  },
  {
    method: 'POST',
    path: '/api/upload',
    handler: 'upload',
  },
  {
    method: 'GET',
    path: '/api/user',
    handler: 'auth',
  },
  {
    method: 'POST',
    path: '/api/user/password',
    handler: 'auth',
  },
  {
    method: 'GET',
    path: '/api/agents',
    handler: 'v2:v2/agents',
  },
  {
    method: 'POST',
    path: '/api/agents',
    handler: 'v2:v2/agents',
  },
  {
    method: 'DELETE',
    path: '/api/agents/:agent',
    handler: 'v2:v2/agents',
  },
  {
    method: 'PATCH',
    path: '/api/agents/:agent',
    handler: 'v2:v2/agents',
  },
  {
    method: 'GET',
    path: '/api/agents/:agent/control',
    handler: 'v2:v2/agents',
  },
  {
    method: 'PATCH',
    path: '/api/agents/:agent/control',
    handler: 'v2:v2/agents',
  },
  {
    method: 'DELETE',
    path: '/api/agents/:agent/conversation',
    handler: 'v2:v2/agents',
  },
  {
    method: 'GET',
    path: '/api/agents/:agent/conversation',
    handler: 'v2:v2/agents',
  },
  {
    method: 'POST',
    path: '/api/agents/:agent/conversation',
    handler: 'v2:v2/agents',
  },
  {
    method: 'POST',
    path: '/api/agents/:agent/items/:item/confirm',
    handler: 'v2:v2/agents',
  },
  {
    method: 'POST',
    path: '/api/agents/:agent/items/:item/run',
    handler: 'v2:v2/agents',
  },
  {
    method: 'GET',
    path: '/api/agents/:agent/items/:item/runs',
    handler: 'v2:v2/agents',
  },
  {
    method: 'POST',
    path: '/api/agents/:agent/run',
    handler: 'v2:v2/agents',
  },
  {
    method: 'POST',
    path: '/api/agents/draft',
    handler: 'v2:v2/agents',
  },
  {
    method: 'GET',
    path: '/api/approvals',
    handler: 'v2:v2/agents',
  },
  {
    method: 'GET',
    path: '/api/release-approval-rules',
    handler: 'v2:v2/releases-api',
  },
  {
    method: 'PUT',
    path: '/api/approvals',
    handler: 'v2:v2/agents',
  },
  {
    method: 'PUT',
    path: '/api/release-approval-rules',
    handler: 'v2:v2/releases-api',
  },
  {
    method: 'GET',
    path: '/api/apps-home',
    handler: 'v2:v2/auth',
  },
  {
    method: 'GET',
    path: '/api/apps/:app/performance',
    handler: 'v2:v2/performance',
  },
  {
    method: 'GET',
    path: '/api/apps/:app/requests',
    handler: 'v2:v2/requests',
  },
  {
    method: 'GET',
    path: '/api/apps/:app/requests/:which(summary|\\d+)',
    handler: 'v2:v2/requests',
  },
  {
    method: 'POST',
    path: '/api/conversation-attachments',
    handler: 'v2:v2/attachments',
  },
  {
    method: 'GET',
    path: '/api/conversation-attachments/:id([a-f0-9-]+)',
    handler: 'v2:v2/attachments',
  },
  {
    method: 'GET',
    path: '/api/conversation-attachments/projects/:project',
    handler: 'v2:v2/attachments',
  },
  {
    method: 'POST',
    path: '/api/conversation-attachments/projects/:project',
    handler: 'v2:v2/attachments',
  },
  {
    method: 'GET',
    path: '/api/auth/account',
    handler: 'v2:v2/auth',
  },
  {
    method: 'POST',
    path: '/api/auth/account',
    handler: 'v2:v2/auth',
  },
  {
    method: 'POST',
    path: '/api/auth/cli/approve',
    handler: 'v2:v2/auth',
  },
  {
    method: 'POST',
    path: '/api/auth/cli/poll',
    handler: 'v2:v2/auth',
  },
  {
    method: 'POST',
    path: '/api/auth/cli/start',
    handler: 'v2:v2/auth',
  },
  {
    method: 'GET',
    path: '/api/auth/methods',
    handler: 'v2:v2/auth',
  },
  {
    method: 'POST',
    path: '/api/auth/passkey/login/options',
    handler: 'v2:v2/auth',
  },
  {
    method: 'POST',
    path: '/api/auth/passkey/login/verify',
    handler: 'v2:v2/auth',
  },
  {
    method: 'POST',
    path: '/api/auth/passkey/register/options',
    handler: 'v2:v2/auth',
  },
  {
    method: 'POST',
    path: '/api/auth/passkey/register/verify',
    handler: 'v2:v2/auth',
  },
  {
    method: 'DELETE',
    path: '/api/auth/session',
    handler: 'v2:v2/auth',
  },
  {
    method: 'POST',
    path: '/api/auth/session',
    handler: 'v2:v2/auth',
  },
  {
    method: 'GET',
    path: '/api/auth/trust',
    handler: 'v2:v2/auth',
  },
  {
    method: 'GET',
    path: '/api/backups',
    handler: 'v2:v2/backups',
  },
  {
    method: 'POST',
    path: '/api/backups/:backup/:action(restore|test)',
    handler: 'v2:v2/backups',
  },
  {
    method: 'POST',
    path: '/api/backups/:backup/restore/:restore/:step(switch|cancel)',
    handler: 'v2:v2/backups',
  },
  {
    method: 'POST',
    path: '/api/backups/run',
    handler: 'v2:v2/backups',
  },
  {
    method: 'POST',
    path: '/api/composer/agents/:agent/messages',
    handler: 'v2:v2/screenshots',
  },
  {
    method: 'POST',
    path: '/api/composer/messages',
    handler: 'v2:v2/screenshots',
  },
  {
    method: 'GET',
    path: '/api/computers',
    handler: 'v2:v2/computers',
  },
  {
    method: 'DELETE',
    path: '/api/computers/:id',
    handler: 'v2:v2/computers',
  },
  {
    method: 'GET',
    path: '/api/computers/:id',
    handler: 'v2:v2/computers',
  },
  {
    method: 'PATCH',
    path: '/api/computers/:id',
    handler: 'v2:v2/computers',
  },
  {
    method: 'GET',
    path: '/api/computers/:id/removal',
    handler: 'v2:v2/computers',
  },
  {
    method: 'POST',
    path: '/api/computers/enrollment',
    handler: 'v2:v2/computers',
  },
  {
    method: 'GET',
    path: '/api/model-settings',
    handler: 'v2:v2/computers',
  },
  {
    method: 'PUT',
    path: '/api/model-settings',
    handler: 'v2:v2/computers',
  },
  {
    method: 'GET',
    path: '/api/artifacts',
    handler: 'v2:v2/artifacts',
  },
  {
    method: 'POST',
    path: '/api/artifacts',
    handler: 'v2:v2/artifacts',
  },
  {
    method: 'GET',
    path: '/api/design/projects',
    handler: 'v2:v2/design',
  },
  {
    method: 'GET',
    path: '/api/design/reviews',
    handler: 'v2:v2/design',
  },
  {
    method: 'DELETE',
    path: '/api/devices',
    handler: 'v2:v2/push',
  },
  {
    method: 'GET',
    path: '/api/devices',
    handler: 'v2:v2/auth',
  },
  {
    method: 'POST',
    path: '/api/devices',
    handler: 'v2:v2/push',
  },
  {
    method: 'DELETE',
    path: '/api/devices/:id',
    handler: 'v2:v2/auth',
  },
  {
    method: 'POST',
    path: '/api/devices/exchange',
    handler: 'v2:v2/auth',
  },
  {
    method: 'POST',
    path: '/api/devices/pair',
    handler: 'v2:v2/auth',
  },
  {
    method: 'POST',
    path: '/api/diagnostics/profile',
    handler: 'v2:v2/diagnostics',
  },
  {
    method: 'GET',
    path: '/api/activity-events',
    handler: 'v2:v2/api',
  },
  {
    method: 'POST',
    path: '/api/health/report',
    handler: 'v2:v2/live',
  },
  {
    method: 'GET',
    path: '/api/inbox',
    handler: 'v2:v2/api',
  },
  {
    method: 'POST',
    path: '/api/inbox/:id/answer',
    handler: 'v2:v2/api',
  },
  {
    method: 'GET',
    path: '/api/live',
    handler: 'v2:v2/live',
  },
  {
    method: 'GET',
    path: '/api/live/',
    handler: 'v2:v2/live',
  },
  {
    method: 'GET',
    path: '/api/live/:app*',
    handler: 'v2:v2/live',
  },
  {
    method: 'GET',
    path: '/api/notifications',
    handler: 'v2:v2/push',
  },
  {
    method: 'PATCH',
    path: '/api/notifications',
    handler: 'v2:v2/push',
  },
  {
    method: 'DELETE',
    path: '/api/package-keys',
    handler: 'v2:packages/api',
  },
  {
    method: 'GET',
    path: '/api/package-keys',
    handler: 'v2:packages/api',
  },
  {
    method: 'POST',
    path: '/api/package-keys',
    handler: 'v2:packages/api',
  },
  {
    method: 'GET',
    path: '/api/packages',
    handler: 'v2:packages/api',
  },
  {
    method: 'GET',
    path: '/api/packages/npm-login/:id',
    handler: 'v2:packages/api',
  },
  {
    method: 'POST',
    path: '/api/packages/npm-login/:id',
    handler: 'v2:packages/api',
  },
  {
    method: 'GET',
    path: '/api/packages/cache',
    handler: 'v2:packages/api',
  },
  {
    method: 'POST',
    path: '/api/packages/cache/warm',
    handler: 'v2:packages/api',
  },
  {
    method: 'GET',
    path: '/api/packages/npm/:name*',
    handler: 'v2:packages/api',
  },
  {
    method: 'POST',
    path: '/api/packages/npm/:name*/versions/:version/deprecate',
    handler: 'v2:packages/api',
  },
  {
    method: 'GET',
    path: '/api/projects',
    handler: 'v2:v2/releases-api',
  },
  {
    method: 'POST',
    path: '/api/projects',
    handler: 'v2:v2/projects-api',
  },
  {
    method: 'DELETE',
    path: '/api/projects/:project',
    handler: 'v2:v2/project-removal',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/apps',
    handler: 'v2:v2/settings',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/artifacts/:artifact/design',
    handler: 'v2:v2/design',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/artifacts/:artifact/design/accept',
    handler: 'v2:v2/design',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/artifacts/:artifact/design/ask',
    handler: 'v2:v2/design',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/artifacts/:artifact/design/asks',
    handler: 'v2:v2/design',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/artifacts/:artifact/design/branches',
    handler: 'v2:v2/design',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/artifacts/:artifact/design/canvas',
    handler: 'v2:v2/design',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/artifacts/:artifact/design/changes',
    handler: 'v2:v2/design',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/artifacts/:artifact/design/comments',
    handler: 'v2:v2/design',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/artifacts/:artifact/design/comments',
    handler: 'v2:v2/design',
  },
  {
    method: 'PATCH',
    path: '/api/projects/:project/artifacts/:artifact/design/comments/:id([A-Za-z0-9-]+)',
    handler: 'v2:v2/design',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/artifacts/:artifact/design/components',
    handler: 'v2:v2/design',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/artifacts/:artifact/design/edit',
    handler: 'v2:v2/design',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/artifacts/:artifact/design/files/:commit([0-9a-f]+)/:kind(boards|ds)/:file*',
    handler: 'v2:v2/design',
  },
  {
    method: 'HEAD',
    path: '/api/projects/:project/artifacts/:artifact/design/files/:commit([0-9a-f]+)/:kind(boards|ds)/:file*',
    handler: 'v2:v2/design',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/artifacts/:artifact/design/links',
    handler: 'v2:v2/design',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/artifacts/:artifact/design/presence',
    handler: 'v2:v2/design',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/artifacts/:artifact/design/proposals',
    handler: 'v2:v2/design',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/artifacts/:artifact/design/propose',
    handler: 'v2:v2/design',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/artifacts/:artifact/design/render',
    handler: 'v2:v2/design',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/artifacts/:artifact/design/review',
    handler: 'v2:v2/design',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/artifacts/:artifact/design/review/build',
    handler: 'v2:v2/design',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/artifacts/:artifact/design/review/choice',
    handler: 'v2:v2/design',
  },
  {
    method: 'DELETE',
    path: '/api/projects/:project/artifacts/:artifact/design/review/pins',
    handler: 'v2:v2/design',
  },
  {
    method: 'PATCH',
    path: '/api/projects/:project/artifacts/:artifact/design/review/pins',
    handler: 'v2:v2/design',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/artifacts/:artifact/design/review/pins',
    handler: 'v2:v2/design',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/artifacts/:artifact/design/review/preview',
    handler: 'v2:v2/design',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/artifacts/:artifact/design/review/seen',
    handler: 'v2:v2/design',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/artifacts/:artifact/design/review/undo',
    handler: 'v2:v2/design',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/artifacts/:artifact/document',
    handler: 'v2:v2/artifacts',
  },
  {
    method: 'PUT',
    path: '/api/projects/:project/artifacts/:artifact/document',
    handler: 'v2:v2/artifacts',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/design',
    handler: 'v2:v2/design',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/design/accept',
    handler: 'v2:v2/design',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/design/ask',
    handler: 'v2:v2/design',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/design/asks',
    handler: 'v2:v2/design',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/design/branches',
    handler: 'v2:v2/design',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/design/canvas',
    handler: 'v2:v2/design',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/design/changes',
    handler: 'v2:v2/design',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/design/comments',
    handler: 'v2:v2/design',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/design/comments',
    handler: 'v2:v2/design',
  },
  {
    method: 'PATCH',
    path: '/api/projects/:project/design/comments/:id([A-Za-z0-9-]+)',
    handler: 'v2:v2/design',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/design/components',
    handler: 'v2:v2/design',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/design/edit',
    handler: 'v2:v2/design',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/design/files/:commit([0-9a-f]+)/:kind(boards|ds)/:file*',
    handler: 'v2:v2/design',
  },
  {
    method: 'HEAD',
    path: '/api/projects/:project/design/files/:commit([0-9a-f]+)/:kind(boards|ds)/:file*',
    handler: 'v2:v2/design',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/design/links',
    handler: 'v2:v2/design',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/design/presence',
    handler: 'v2:v2/design',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/design/proposals',
    handler: 'v2:v2/design',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/design/propose',
    handler: 'v2:v2/design',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/design/render',
    handler: 'v2:v2/design',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/design/review',
    handler: 'v2:v2/design',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/design/review/build',
    handler: 'v2:v2/design',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/design/review/choice',
    handler: 'v2:v2/design',
  },
  {
    method: 'DELETE',
    path: '/api/projects/:project/design/review/pins',
    handler: 'v2:v2/design',
  },
  {
    method: 'PATCH',
    path: '/api/projects/:project/design/review/pins',
    handler: 'v2:v2/design',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/design/review/pins',
    handler: 'v2:v2/design',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/design/review/preview',
    handler: 'v2:v2/design',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/design/review/seen',
    handler: 'v2:v2/design',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/design/review/undo',
    handler: 'v2:v2/design',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/logs',
    handler: 'v2:v2/logs',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/overview',
    handler: 'v2:v2/settings',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/releases',
    handler: 'v2:v2/releases-api',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/releases',
    handler: 'v2:v2/releases-api',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/releases/plan',
    handler: 'v2:v2/releases-api',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/repository',
    handler: 'v2:v2/projects-api',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/rollback',
    handler: 'v2:v2/releases-api',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/rollbacks',
    handler: 'v2:v2/releases-api',
  },
  {
    method: 'DELETE',
    path: '/api/projects/:project/secrets/:key',
    handler: 'v2:v2/settings',
  },
  {
    method: 'PUT',
    path: '/api/projects/:project/secrets/:key',
    handler: 'v2:v2/settings',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/settings',
    handler: 'v2:v2/settings',
  },
  {
    method: 'PATCH',
    path: '/api/projects/:project/settings',
    handler: 'v2:v2/settings',
  },
  {
    method: 'PUT',
    path: '/api/projects/:project/settings',
    handler: 'v2:v2/settings',
  },
  {
    method: 'GET',
    path: '/api/removed-projects',
    handler: 'v2:v2/project-removal',
  },
  {
    method: 'GET',
    path: '/api/removed-projects/:id/backup',
    handler: 'v2:v2/project-removal',
  },
  {
    method: 'GET',
    path: '/api/projects/unlinked-apps',
    handler: 'v2:v2/projects-api',
  },
  {
    method: 'GET',
    path: '/api/pulls/:pull/files',
    handler: 'v2:v2/pull-files',
  },
  {
    method: 'POST',
    path: '/api/pulls/:pull/files',
    handler: 'v2:v2/pull-files',
  },
  {
    method: 'GET',
    path: '/api/pulls/:pull/files/:file([a-f0-9-]+)',
    handler: 'v2:v2/pull-files',
  },
  {
    method: 'HEAD',
    path: '/api/pulls/:pull/files/:file([a-f0-9-]+)',
    handler: 'v2:v2/pull-files',
  },
  {
    method: 'GET',
    path: '/api/releases/:release',
    handler: 'v2:v2/releases-api',
  },
  {
    method: 'GET',
    path: '/api/releases/:release/output',
    handler: 'v2:v2/releases-api',
  },
  {
    method: 'GET',
    path: '/api/releases/uploads/:id([0-9]+)',
    handler: 'v2:v2/releases-api',
  },
  {
    method: 'GET',
    path: '/api/screenshots/:id',
    handler: 'v2:v2/screenshots',
  },
  {
    method: 'PATCH',
    path: '/api/screenshots/:id',
    handler: 'v2:v2/screenshots',
  },
  {
    method: 'POST',
    path: '/api/screenshots/worker/:action(poll|complete|attachments)',
    handler: 'v2:v2/screenshots',
  },
  {
    method: 'GET',
    path: '/api/self-update',
    handler: 'v2:v2/self-update',
  },
  {
    method: 'POST',
    path: '/api/self-update',
    handler: 'v2:v2/self-update',
  },
  {
    method: 'GET',
    path: '/api/self-update/log',
    handler: 'v2:v2/self-update',
  },
  {
    method: 'GET',
    path: '/api/setup',
    handler: 'v2:v2/auth',
  },
  {
    method: 'POST',
    path: '/api/setup',
    handler: 'v2:v2/auth',
  },
  {
    method: 'GET',
    path: '/api/setup/recovery',
    handler: 'v2:v2/auth',
  },
  {
    method: 'POST',
    path: '/api/start/inspect',
    handler: 'v2:v2/start',
  },
  {
    method: 'GET',
    path: '/api/task-snapshots/:task',
    handler: 'v2:v2/tasks',
  },
  {
    method: 'GET',
    path: '/api/tasks/:task/screenshots',
    handler: 'v2:v2/screenshots',
  },
  {
    method: 'POST',
    path: '/api/tasks/:task/screenshots',
    handler: 'v2:v2/screenshots',
  },
  {
    method: 'GET',
    path: '/api/updates',
    handler: 'v2:v2/computers',
  },
  {
    method: 'PUT',
    path: '/api/updates',
    handler: 'v2:v2/computers',
  },
  {
    method: 'POST',
    path: '/api/agent/attachments',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/agent/tools',
    handler: 'workspace',
  },
  {
    method: 'GET',
    path: '/api/application-repositories',
    handler: 'workspace',
  },
  {
    method: 'GET',
    path: '/api/attachments/:attachment',
    handler: 'workspace',
  },
  {
    method: 'HEAD',
    path: '/api/attachments/:attachment',
    handler: 'workspace',
  },
  {
    method: 'GET',
    path: '/api/attachments/:attachment/thumbnail',
    handler: 'workspace',
  },
  {
    method: 'HEAD',
    path: '/api/attachments/:attachment/thumbnail',
    handler: 'workspace',
  },
  {
    method: 'GET',
    path: '/api/worker-permissions',
    handler: 'workspace',
  },
  {
    method: 'GET',
    path: '/api/computers/:computer/permissions',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/computers/:computer/revoke',
    handler: 'workspace',
  },
  {
    method: 'GET',
    path: '/api/computers/:computer/terminal',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/computers/:computer/terminal',
    handler: 'workspace',
  },
  {
    method: 'GET',
    path: '/api/events',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/git/:repository/:name(.+\\.git)/git-receive-pack',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/git/:repository/:name(.+\\.git)/git-upload-pack',
    handler: 'workspace',
  },
  {
    method: 'GET',
    path: '/api/git/:repository/:name(.+\\.git)/info/lfs/objects/:oid([a-f0-9]{64})',
    handler: 'workspace',
  },
  {
    method: 'PUT',
    path: '/api/git/:repository/:name(.+\\.git)/info/lfs/objects/:oid([a-f0-9]{64})',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/git/:repository/:name(.+\\.git)/info/lfs/objects/batch',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/git/:repository/:name(.+\\.git)/info/lfs/verify',
    handler: 'workspace',
  },
  {
    method: 'GET',
    path: '/api/git/:repository/:name(.+\\.git)/info/refs',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/git/:repository/git-receive-pack',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/git/:repository/git-upload-pack',
    handler: 'workspace',
  },
  {
    method: 'GET',
    path: '/api/git/:repository/info/lfs/objects/:oid([a-f0-9]{64})',
    handler: 'workspace',
  },
  {
    method: 'PUT',
    path: '/api/git/:repository/info/lfs/objects/:oid([a-f0-9]{64})',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/git/:repository/info/lfs/objects/batch',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/git/:repository/info/lfs/verify',
    handler: 'workspace',
  },
  {
    method: 'GET',
    path: '/api/git/:repository/info/refs',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/repository-projects',
    handler: 'workspace',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/:kind(issues|pulls)',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/:kind(issues|pulls)',
    handler: 'workspace',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/:kind(issues|pulls)/:item',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/:kind(issues|pulls)/:item',
    handler: 'workspace',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/:kind(issues|pulls)/:item/:action(diff|update|close|reopen|comments|merge|retry-merge|task)',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/:kind(issues|pulls)/:item/:action(diff|update|close|reopen|comments|merge|retry-merge|task)',
    handler: 'workspace',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/pipelines',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/pipelines',
    handler: 'workspace',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/pipelines/:pipeline',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/pipelines/:pipeline/:action(cancel)',
    handler: 'workspace',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/repository',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/repository/:action(fetch|retry|cancel)',
    handler: 'workspace',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/repository/archive',
    handler: 'workspace',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/repository/branches',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/repository/default-branch',
    handler: 'workspace',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/repository/:action(tree|blob|history|diff|files|entry)',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/repository/remote',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/repository/remote-pull',
    handler: 'workspace',
  },
  {
    method: 'GET',
    path: '/api/projects/:project/metadata',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/settings',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/projects/:project/settings/control',
    handler: 'workspace',
  },
  {
    method: 'GET',
    path: '/api/provider-connections',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/provider-connections',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/provider-connections/login',
    handler: 'workspace',
  },
  {
    method: 'GET',
    path: '/api/repositories/setup',
    handler: 'workspace',
  },
  {
    method: 'GET',
    path: '/api/ssh-keys',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/ssh-keys',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/ssh-keys/:key/delete',
    handler: 'workspace',
  },
  {
    method: 'GET',
    path: '/api/state',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/tasks',
    handler: 'workspace',
  },
  {
    method: 'GET',
    path: '/api/tasks/:task',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/tasks/:task/:action(messages|stop|mark-stopped|check|close|reopen|delete)',
    handler: 'workspace',
  },
  {
    method: 'GET',
    path: '/api/tasks/:task/:diff(diff)',
    handler: 'workspace',
  },
  {
    method: 'GET',
    path: '/api/tasks/:task/deletion',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/tasks/:task/attachments',
    handler: 'workspace',
  },
  {
    method: 'GET',
    path: '/api/tasks/:task/controls',
    handler: 'workspace',
  },
  {
    method: 'GET',
    path: '/api/tasks/:task/controls/:control',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/tasks/:task/controls/:control',
    handler: 'workspace',
  },
  {
    method: 'GET',
    path: '/api/tasks/:task/diff/:kind(file|patch)',
    handler: 'workspace',
  },
  {
    method: 'GET',
    path: '/api/tasks/:task/files',
    handler: 'workspace',
  },
  {
    method: 'GET',
    path: '/api/tasks/:task/files/:content(content)',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/tasks/:task/jobs/:job/cancel',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/tasks/:task/move',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/tasks/:task/publish',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/tasks/:task/questions/:question/answer',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/tasks/:task/queue',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/tasks/:task/queue/:cancel(cancel)',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/tasks/:task/shell',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/tasks/:task/update-base',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/tasks/:task/workspace/:action(retry|cancel)',
    handler: 'workspace',
  },
  {
    method: 'GET',
    path: '/api/transcription',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/transcription',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/workers/:worker/:action(poll|events|complete)',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/workers/:worker/:action(provider-config|provider-login)',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/workers/:worker/base-updates/:action(poll|prepare|complete|fail)',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/workers/:worker/controls/:action(poll|claim|complete|fail|recording-error)',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/workers/:worker/controls/:control/recording',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/workers/:worker/jobs/:action(poll|update|complete|packages|package-publish)',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/workers/:worker/jobs/:job/artifacts',
    handler: 'workspace',
  },
  {
    method: 'GET',
    path: '/api/workers/:worker/terminals',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/workers/enroll',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/workers/managed/start',
    handler: 'workspace',
  },
  {
    method: 'POST',
    path: '/api/workers/register',
    handler: 'workspace',
  },
  {
    method: '*',
    path: '/api/git/:rest*',
    handler: 'workspace',
  },
];
