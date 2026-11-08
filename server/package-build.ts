// Worker-safe: no database or enrollment credential enters Docker's build environment.
import {
  preparePackageInstall,
  registryPing,
  secretOutput,
  type InstallConfig,
} from '../shared/package-install.mjs';
import type { AgentGraphDocker } from './agent-graph-runtime.ts';

export function buildSecretsUnsupported(output: string) {
  return /unknown (?:flag|option):?[^\n]*--secret|(?:buildx|buildkit)[^\n]*(?:not (?:a docker )?command|not supported|unavailable)|--secret[^\n]*(?:not supported|requires buildkit)/i.test(
    output,
  );
}

export const buildRegistryUnavailable = 'The package registry was not available for this build.';

/** Decorate only builds; runtime commands and saved graph/job payloads never contain install keys. */
export function registryBuildDocker(
  docker: AgentGraphDocker,
  options: {
    root: string;
    config(): Promise<InstallConfig | null>;
    log(line: string): void;
    ping?: typeof registryPing;
    registryArgs?: (
      install: Awaited<ReturnType<typeof preparePackageInstall>>,
    ) => Promise<string[]>;
  },
): AgentGraphDocker {
  return {
    async run(args, execution = {}) {
      if (args[0] !== 'build') return docker.run(args, execution);
      let supported = false;
      try {
        const version = await docker.run(['buildx', 'version']);
        if (version.exitCode === 0) {
          const help = await docker.run(['buildx', 'build', '--help']);
          supported = help.exitCode === 0 && help.stdout.includes('--secret');
        }
      } catch {
        /* Keep the existing builder when buildx is unavailable. */
      }
      if (!supported) {
        options.log(buildRegistryUnavailable);
        return docker.run(args, execution);
      }
      const config = await options.config().catch(() => null);
      if (!config) {
        options.log(buildRegistryUnavailable);
        return docker.run(args, execution);
      }
      const install = await preparePackageInstall(config, {
        cwd: args.at(-1)!,
        root: options.root,
        container: true,
        ping: options.ping,
        log: options.log,
      });
      try {
        const registryArgs = options.registryArgs
          ? await options.registryArgs(install)
          : install.npmrc
            ? [
                '--secret',
                `id=npmrc,src=${install.npmrc}`,
                '--secret',
                `id=ca,src=${install.ca}`,
                ...(install.args.includes('--add-host')
                  ? ['--add-host', install.args[install.args.indexOf('--add-host') + 1]]
                  : []),
              ]
            : [];
        // preparePackageInstall resolves deploy.local on this host, not inside Colima/BuildKit.
        const buildArgs = ['buildx', 'build', '--load', ...registryArgs, ...args.slice(1)];
        const output = secretOutput(install.secrets, (text) => execution.onOutput?.(text));
        const redact = (text: string) => {
          let result = '';
          const filter = secretOutput(install.secrets, (chunk) => {
            result += chunk;
          });
          filter.write(text);
          filter.end();
          return result;
        };
        try {
          let result = await docker.run(buildArgs, { onOutput: output.write });
          if (
            result.exitCode !== 0 &&
            buildSecretsUnsupported(result.stdout + '\n' + result.stderr)
          ) {
            output.end();
            options.log(buildRegistryUnavailable);
            result = await docker.run(args, { onOutput: output.write });
          }
          return { ...result, stdout: redact(result.stdout), stderr: redact(result.stderr) };
        } catch (error) {
          // Never propagate a Docker error object carrying unfiltered stdout/stderr.
          throw new Error(redact(error instanceof Error ? error.message : String(error)));
        } finally {
          output.end();
        }
      } finally {
        await install.cleanup();
      }
    },
  };
}
