import { repositorySetup } from './repository-setup.ts';
const result = await repositorySetup();
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ready ? 0 : 1;
