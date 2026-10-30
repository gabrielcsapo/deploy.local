import { randomBytes, X509Certificate } from 'node:crypto';
import { hostname } from 'node:os';
import { readFileSync } from 'node:fs';
import { deployDataPath } from '../data-directory.ts';
import { registerUser, getDiscoverableDeployments, getNodes } from '../store.ts';
import { authDb, consume, grant, updatePreferences } from './auth-store.ts';
import { fail } from './inbox.ts';
import { list } from '../workspace/store.ts';
import { supportedBlueprintContents } from '../catalog/supported-blueprints.ts';
import { validationBlueprintContents } from '../catalog/validation-blueprints.ts';

export function hasOwner() {
  return !!authDb().prepare('SELECT 1 FROM users LIMIT 1').get();
}
// Local installer only. Never issue ownership codes from a public HTTP route.
export function issueSetupCode() {
  return authDb()
    .transaction(() => {
      if (hasOwner()) fail('An account already exists. Sign in with your password.', 409);
      authDb().prepare("DELETE FROM v2_auth_grants WHERE kind='setup'").run();
      const code = randomBytes(8).toString('hex').toUpperCase().match(/.{4}/g)!.join('-');
      grant('setup', '', {}, 30 * 60_000, code);
      return { code, expiresAt: Date.now() + 30 * 60_000 };
    })
    .immediate();
}
export function setupAccount(input: {
  code?: unknown;
  username?: unknown;
  password?: unknown;
  name?: unknown;
}) {
  const { code, username, password } = input;
  if (
    typeof code !== 'string' ||
    typeof username !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(username)
  )
    fail('Enter the setup code and a username using letters, numbers, hyphens or underscores.');
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024)
    fail('Use a password with at least 12 characters (at most 1024).');
  return authDb()
    .transaction(() => {
      if (hasOwner()) fail('An account already exists. Sign in with your password.', 409);
      consume('setup', code.trim().toUpperCase());
      const result = registerUser(username, password);
      if ('error' in result) fail(result.error!, result.status);
      updatePreferences(username, {
        name: typeof input.name === 'string' ? input.name.slice(0, 100) : username,
      });
      return { username, token: result.token! };
    })
    .immediate();
}
export function serverIdentity() {
  let fingerprint: string | null = null;
  try {
    fingerprint = new X509Certificate(readFileSync(deployDataPath('certs', 'ca.crt')))
      .fingerprint256;
  } catch {
    /* Certificate not created yet. */
  }
  return {
    name: hostname(),
    origin: process.env.DEPLOY_PUBLIC_ORIGIN || 'https://deploy.local',
    fingerprint,
  };
}
/** What a household member sees on an app card: nothing while it serves, otherwise why it doesn't. */
export type HomeAppState = 'running' | 'updating' | 'stopped' | 'failing';
const inProgress = new Set([
  'queued',
  'uploading',
  'building',
  'deploying',
  'starting',
  'restarting',
  'recreating',
  'reconfiguring',
  'restoring',
  'backing-up',
]);
export function homeAppState(status: string | null | undefined): HomeAppState {
  if (status && inProgress.has(status)) return 'updating';
  if (status === 'stopped' || status === 'stopping') return 'stopped';
  if (status && ['failed', 'crashed', 'error', 'degraded', 'down'].includes(status))
    return 'failing';
  return 'running';
}

const blueprintNames = new Map(
  [...supportedBlueprintContents, ...validationBlueprintContents].map((blueprint) => [
    blueprint.id,
    blueprint.metadata.name,
  ]),
);

/**
 * Says what an app is: the Discover app it was installed from, else the project it belongs to.
 * Left out when it would only repeat the app's name. Labels only; never paths or settings.
 */
function homeAppSources(names: string[]) {
  const database = authDb();
  const sources = new Map<string, string>();
  if (!names.length) return sources;
  const marks = names.map(() => '?').join(',');
  const installed = database
    .prepare(
      `SELECT application_name AS app, blueprint_id AS blueprint FROM catalog_installations WHERE application_name IN (${marks})`,
    )
    .all(...names) as { app: string; blueprint: string }[];
  for (const row of installed)
    sources.set(row.app, blueprintNames.get(row.blueprint) || row.blueprint);
  const members = database
    .prepare(
      `SELECT application AS app, owner, project_id AS project FROM project_applications WHERE application IN (${marks})`,
    )
    .all(...names) as { app: string; owner: string; project: string }[];
  const projects = new Map<string, Map<string, string>>();
  for (const row of members) {
    // `app:<name>` is a standalone app's own project; its name is the app's name.
    if (sources.has(row.app) || row.project.startsWith('app:')) continue;
    if (!projects.has(row.owner))
      projects.set(
        row.owner,
        new Map(list('project', row.owner).map((project) => [project.id, project.name])),
      );
    const name = projects.get(row.owner)!.get(row.project);
    if (name) sources.set(row.app, name);
  }
  return sources;
}

export function appsAtHome() {
  const apps = getDiscoverableDeployments();
  const sources = homeAppSources(apps.map((app) => app.name));
  return apps.map((app) => {
    const source = sources.get(app.name);
    return {
      name: app.name,
      type: app.type,
      status: app.status,
      state: homeAppState(app.status),
      address: `https://${app.name}.local`,
      ...(source && source.toLowerCase() !== app.name.toLowerCase() ? { source } : {}),
    };
  });
}

/** The computers Apps at home runs on, coordinator first, for "Running on SER and bazzite." */
export function homeComputers(coordinator = serverIdentity().name) {
  const names = new Map(getNodes().map((node) => [node.id, node.name]));
  const hosts = new Set<string>();
  for (const app of getDiscoverableDeployments()) {
    const nodeId = app.activeNodeId || 'coordinator';
    hosts.add(nodeId === 'coordinator' ? coordinator : (names.get(nodeId) ?? nodeId));
  }
  return [...hosts].sort((a, b) => Number(b === coordinator) - Number(a === coordinator));
}

export function recoveryProgress() {
  try {
    return JSON.parse(readFileSync(deployDataPath('v2-recovery.json'), 'utf8'));
  } catch {
    return { state: 'idle', projects: [] };
  }
}
