// Shared by workers and the out-of-release updater. No enrollment credentials enter here.
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { lookup } from 'node:dns/promises';
import { homedir } from 'node:os';

export const registryFallback =
  'deploy.local’s package registry is unreachable; installing from npmjs.org.';
export function registryPing({ registry, key, ca }, timeout = 1500) {
  return new Promise((done) => {
    const url = new URL('-/ping', registry);
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        ca: ca || undefined,
        headers: { Authorization: 'Bearer ' + key },
      },
      (response) => {
        response.resume();
        done(response.statusCode === 200);
      },
    );
    const timer = setTimeout(() => {
      request.destroy();
      done(false);
    }, timeout);
    request.on('error', () => done(false));
    request.on('close', () => clearTimeout(timer));
    request.end();
  });
}
const optional = (path) => readFile(path, 'utf8').catch(() => '');
export async function projectRegistry(cwd) {
  const [npm, yarn, bun] = await Promise.all(
    ['.npmrc', '.yarnrc.yml', 'bunfig.toml'].map((file) => optional(join(cwd, file))),
  );
  // Environment has higher precedence in Berry. Leave explicitly configured projects alone,
  // including scoped registries, so their credentials never receive our install key.
  return (
    /^\s*(?:@[^\s=]+:)?registry\s*=/m.test(npm) ||
    /npm(?:RegistryServer|Scopes|Registries)\s*:/m.test(yarn) ||
    /^\s*registry\s*=/m.test(bun)
  );
}
export async function preparePackageInstall(
  config,
  {
    cwd,
    root,
    container = false,
    log = () => {},
    ping = registryPing,
    environment = process.env,
  } = {},
) {
  const empty = { env: {}, args: [], key: '', secrets: [], cleanup: async () => {} };
  let reported = false;
  const fallback = () => {
    if (!reported) log(registryFallback);
    reported = true;
  };
  if (!config || (await projectRegistry(cwd))) return empty;
  if (config.key && !(await ping(config).catch(() => false))) {
    fallback();
    config = {
      registry: config.fallbackRegistry || 'https://registry.npmjs.org/',
      key: '',
      ca: '',
      public: true,
    };
  }
  let address = config.address;
  if (container && config.key && !address) {
    try {
      address = (await lookup(new URL(config.registry).hostname)).address;
    } catch {
      fallback();
      config = { registry: 'https://registry.npmjs.org/', key: '', ca: '', public: true };
    }
  }
  let directory;
  const cleanup = () =>
    directory ? rm(directory, { recursive: true, force: true }) : Promise.resolve();
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    directory = await mkdtemp(join(root, 'package-install-'));
    const target = container ? '/run/deploy-packages' : directory;
    const url = new URL(config.registry);
    const ca = join(directory, 'ca.crt');
    const npmrc = join(directory, 'npmrc');
    await writeFile(ca, config.ca || '', { mode: 0o600, flag: 'wx' });
    // Host jobs retain personal scoped registries and credentials. Containers never do.
    const userConfig = container
      ? ''
      : await optional(
          environment.NPM_CONFIG_USERCONFIG ||
            environment.npm_config_userconfig ||
            join(environment.HOME || homedir(), '.npmrc'),
        );
    const inherited = userConfig
      .split('\n')
      .filter((line) => !/^\s*(registry|cafile)\s*=/i.test(line))
      .join('\n');
    await writeFile(
      npmrc,
      `${inherited ? inherited.replace(/\n?$/, '\n') : ''}registry=${url.href}\n${config.key ? `//${url.host}${url.pathname}:_authToken=${config.key}\n` : ''}${config.ca ? `cafile=${target}/ca.crt\n` : ''}`,
      { mode: 0o600, flag: 'wx' },
    );
    const env = { NPM_CONFIG_USERCONFIG: `${target}/npmrc` };
    const [manifest, lock, yarnrc] = await Promise.all([
      optional(join(cwd, 'package.json')),
      optional(join(cwd, 'yarn.lock')),
      optional(join(cwd, '.yarnrc.yml')),
    ]);
    const berry =
      /"packageManager"\s*:\s*"yarn@(?:[2-9]|\d{2,})\./.test(manifest) ||
      /^__metadata:/m.test(lock) ||
      Boolean(yarnrc.trim());
    if (berry) {
      env.YARN_NPM_REGISTRY_SERVER = url.href;
      if (config.key) {
        env.YARN_NPM_AUTH_TOKEN = config.key;
        env.YARN_NPM_ALWAYS_AUTH = 'true';
      }
      if (config.ca) env.YARN_HTTPS_CA_FILE_PATH = `${target}/ca.crt`;
    }
    const args = container
      ? [
          '--volume',
          `${directory}:${target}:ro`,
          ...(config.key ? ['--add-host', `deploy.local:${address}`] : []),
          ...Object.keys(env).flatMap((key) => ['--env', key]),
        ]
      : [];
    const secrets = [
      config.key,
      ...inherited.matchAll(/(?:_authToken|_auth|_password)\s*=\s*(.+)/g),
    ]
      .map((value) => (typeof value === 'string' ? value : value[1]))
      .filter(Boolean);
    return { env, args, key: config.key, secrets, npmrc, ca, directory, cleanup };
  } catch {
    await cleanup().catch(() => {});
    fallback();
    return { ...empty, env: { NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/' } };
  }
}
/** Withhold an incomplete credential suffix across chunks. Never persist a partial token. */
export function secretOutput(secrets, append) {
  let pending = '';
  const values = secrets.filter(Boolean);
  return {
    write(chunk) {
      pending += chunk.toString();
      for (const value of values) pending = pending.split(value).join('[redacted]');
      let keep = 0;
      for (const value of values)
        for (let n = 1; n < value.length; n++) {
          if (pending.endsWith(value.slice(0, n))) keep = Math.max(keep, n);
        }
      append(pending.slice(0, pending.length - keep));
      pending = pending.slice(pending.length - keep);
    },
    end() {
      if (pending)
        append(pending.length <= 4 && 'dlp_'.startsWith(pending) ? pending : '[redacted]');
      pending = '';
    },
  };
}
