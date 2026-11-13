import { issuePipelinePackageToken } from './pipeline-auth.ts';
import { readFile } from 'node:fs/promises';
import { deployDataPath } from '../kernel/files/data-directory.ts';
import { setPackageHooks } from '../workspace/package-hooks.ts';
import { computerInstallConfig, applicationInstallConfig } from './builds.ts';
import { finishJobPins } from './copies.ts';
import { revokeComputerPackageKey } from './keys.ts';

setPackageHooks({
  publishConfig: async (owner, job) => ({
    registry: 'https://deploy.local/npm/',
    key: issuePipelinePackageToken(owner, job),
    // A project with its install switch off has no CA from its install config.
    ca: await readFile(deployDataPath('certs', 'ca.crt'), 'utf8').catch(() => ''),
  }),
  installConfig: computerInstallConfig,
  applicationInstallConfig,
  revokeComputer: revokeComputerPackageKey,
  finishJob: finishJobPins,
});
