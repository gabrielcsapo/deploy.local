import { copyFileSync, existsSync, mkdirSync, chmodSync, constants } from 'node:fs';
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { providerUsage, invalidateProviderUsage } from './provider-usage.ts';
import { modelOptions, invalidateModelOptions } from './model-options.ts';

let connections: any[] = [],
  applied = '',
  loginRequest = '',
  authenticating = false;
const executable = (provider: string) =>
  process.env[provider === 'codex' ? 'DEPLOY_CODEX_BIN' : 'DEPLOY_CLAUDE_BIN'] || provider;
function cleanEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !['DEPLOY_WORKER_TOKEN', 'DEPLOY_WORKSPACE_TOKEN', 'DEPLOY_WORKSPACE_USERNAME'].includes(
          key,
        ),
    ),
  );
}
export async function applyProviderConnections(values: any[], root: string) {
  const revision = values.map((value) => value.revision).join(':');
  if (applied === revision && connections.length) return;
  const prior = connections;
  const codex = values.find((value) => value.provider === 'codex');
  if (process.env.DEPLOY_MANAGED_WORKER === '1') {
    const home = resolve(root, 'providers/codex');
    mkdirSync(home, { recursive: true, mode: 0o700 });
    process.env.CODEX_HOME = home;
    const auth = resolve(home, 'auth.json'),
      source = process.env.DEPLOY_CODEX_AUTH_SOURCE;
    if (
      codex?.mode === 'account' &&
      source &&
      existsSync(source) &&
      (!existsSync(auth) || prior.find((value) => value.provider === 'codex')?.mode === 'api-key')
    ) {
      copyFileSync(source, auth, existsSync(auth) ? 0 : constants.COPYFILE_EXCL);
      chmodSync(auth, 0o600);
    }
    if (codex?.enabled && codex.mode === 'api-key' && codex.apiKey) {
      await new Promise<void>((done, reject) => {
        const child = spawn(executable('codex'), ['login', '--with-api-key'], {
          env: cleanEnvironment(),
          stdio: ['pipe', 'ignore', 'ignore'],
        });
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error('Codex key setup timed out'));
        }, 10000);
        child.stdin.on('error', () => {});
        child.once('error', () => {
          clearTimeout(timer);
          reject(new Error('Codex is not installed on this worker'));
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          if (code === 0) done();
          else reject(new Error('Codex key setup failed'));
        });
        child.stdin.end(codex.apiKey + '\n');
      });
    }
  } else if (codex?.mode === 'api-key' && codex.enabled) {
    throw new Error('App-managed Codex keys require an app-managed worker');
  }
  connections = values;
  applied = revision;
  invalidateProviderUsage();
  invalidateModelOptions();
}
export function providerEnvironment(provider: string): NodeJS.ProcessEnv {
  const value = connections.find((item) => item.provider === provider);
  if (!value?.enabled) return {};
  if (provider === 'claude' && value.mode === 'api-key') return { ANTHROPIC_API_KEY: value.apiKey };
  if (provider === 'compatible')
    return {
      DEPLOY_MODEL_BASE_URL: value.baseUrl,
      DEPLOY_MODEL_NAME: value.model,
      DEPLOY_MODEL_BILLING_MODE: value.billingMode,
      DEPLOY_MODEL_API_KEY: value.apiKey,
    };
  return {};
}
export function providerRuntimeState() {
  const initialized = connections.length || process.env.DEPLOY_MANAGED_WORKER !== '1';
  const usage = initialized ? providerUsage() : [];
  const reports = connections.map((value) => {
    const installed =
      value.provider === 'compatible' ||
      spawnSync(executable(value.provider), ['--version'], { stdio: 'ignore', timeout: 3000 })
        .status === 0;
    const signedIn = usage.find((item) => item.id === value.provider)?.status === 'signed-in';
    const available =
      value.enabled &&
      installed &&
      (value.provider === 'compatible'
        ? !!value.baseUrl && !!value.model
        : value.mode === 'api-key'
          ? !!value.apiKey
          : signedIn);
    return {
      provider: value.provider,
      enabled: value.enabled,
      mode: value.mode,
      revision: value.revision,
      available,
      status: !value.enabled
        ? 'disabled'
        : !installed
          ? 'not-installed'
          : available
            ? value.mode === 'api-key' || value.provider === 'compatible'
              ? 'configured'
              : 'signed-in'
            : 'signed-out',
    };
  });
  const options = (initialized ? modelOptions() : []).map((value) =>
    value.id === 'compatible'
      ? {
          ...value,
          models: connections
            .filter((c) => c.provider === 'compatible' && c.enabled && c.model)
            .map((c) => ({ id: c.model, name: c.model, efforts: [] })),
        }
      : value,
  );
  return {
    reports,
    options,
    usage,
    available: (provider: string) =>
      reports.some((value) => value.provider === provider && value.available),
  };
}
export function providerLoginActive() {
  return authenticating;
}
export function beginProviderLogin(request: any, report: (body: any) => Promise<unknown>) {
  if (
    !request ||
    request.requestId === loginRequest ||
    !['requested', 'pending'].includes(request.status) ||
    request.expiresAt < Date.now()
  )
    return;
  loginRequest = request.requestId;
  authenticating = true;
  const child = spawn(executable('codex'), ['login', '--device-auth'], {
    env: cleanEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buffer = '',
    published = false;
  const timer = setTimeout(() => child.kill(), Math.max(1, request.expiresAt - Date.now()));
  const read = (chunk: Buffer) => {
    buffer = stripVTControlCharacters(buffer + chunk.toString()).slice(-8192);
    const userCode = buffer.match(/\b[A-Z0-9]{3,8}-[A-Z0-9]{3,8}\b/)?.[0];
    if (!published && userCode && buffer.includes('https://auth.openai.com/codex/device')) {
      published = true;
      void report({
        requestId: loginRequest,
        status: 'pending',
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode,
      }).catch(() => {});
    }
  };
  child.stdout.on('data', read);
  child.stderr.on('data', read);
  child.on('error', () => {});
  child.once('close', (code) => {
    clearTimeout(timer);
    authenticating = false;
    invalidateProviderUsage();
    void report({ requestId: loginRequest, status: code === 0 ? 'succeeded' : 'failed' }).catch(
      () => {},
    );
  });
  process.once('exit', () => child.kill());
}
