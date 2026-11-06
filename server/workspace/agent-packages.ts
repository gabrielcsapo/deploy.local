import { preparePackageInstall } from '../../shared/package-install.mjs';
import { shellEnvironment } from './shell-environment.ts';

/** A new worker asks separately: old coordinators reject the request, and old workers never ask. */
export async function prepareAgentInstall(
  request: () => Promise<any>,
  options: { cwd: string; root: string; log?: (line: string) => void },
) {
  return preparePackageInstall(await request().catch(() => null), options);
}

export const packageEnvironmentNames = [
  'NPM_CONFIG_USERCONFIG',
  'NPM_CONFIG_REGISTRY',
  'YARN_NPM_REGISTRY_SERVER',
  'YARN_NPM_AUTH_TOKEN',
  'YARN_NPM_ALWAYS_AUTH',
  'YARN_HTTPS_CA_FILE_PATH',
];
export function packageEnvironment(source: NodeJS.ProcessEnv = process.env) {
  return Object.fromEntries(
    packageEnvironmentNames
      .filter((key) => source[key] !== undefined)
      .map((key) => [key, source[key]]),
  );
}
export function agentEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  install: NodeJS.ProcessEnv = {},
) {
  const configured = Object.keys(install).length > 0;
  // Provider credentials belong to the agent, but enrollment credentials never do.
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key]) =>
        !/^DEPLOY_(WORKER|WORKSPACE|PACKAGE)_/.test(key) &&
        (!configured ||
          !/^(?:npm_config_(?:registry|userconfig|cafile|token)|bun_config_(?:registry|token)|yarn_(?:npm_registry_server|npm_auth_token|npm_always_auth|https_ca_file_path))$/i.test(
            key,
          )),
    ),
  );
}
export function agentShellEnvironment(source: NodeJS.ProcessEnv = process.env) {
  return { ...shellEnvironment(source), ...packageEnvironment(source) };
}
