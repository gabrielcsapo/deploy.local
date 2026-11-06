import { setPackageHooks } from '../workspace/package-hooks.ts';
import { computerInstallConfig } from './builds.ts';
import { finishJobPins } from './copies.ts';
import { revokeComputerPackageKey } from './keys.ts';

setPackageHooks({
  installConfig: computerInstallConfig,
  revokeComputer: revokeComputerPackageKey,
  finishJob: finishJobPins,
});
