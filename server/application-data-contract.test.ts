import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

let root: string;
let store: typeof import('./store.ts');
let specs: typeof import('./application-spec.ts');
let contract: typeof import('./application-data-contract.ts');

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'deploy-application-data-contract-'));
  process.env.DEPLOY_DATA_DIR = root;
  store = await import(`./store.ts?data-contract=${Date.now()}`);
  specs = await import(`./application-spec.ts?data-contract=${Date.now()}`);
  contract = await import(`./application-data-contract.ts?data-contract=${Date.now()}`);
  store.saveDeployment({ name: 'contracted', username: 'admin' });
  store
    .getSqlite()!
    .prepare("UPDATE deployments SET app_id = 'app-contracted' WHERE name = 'contracted'")
    .run();
  const compiled = specs.compileDeployYaml(`apiVersion: deploy.local/v1
kind: Application
components:
  web:
    image: example/web:1
resources:
  database:
    type: volume
    suitcase:
      allowedDataModes: [follows-one-site]
  uploads:
    type: volume
    suitcase:
      allowedDataModes: [follows-one-site, site-local]
`);
  store.saveDesiredApplicationSpec({
    digest: compiled.digest,
    deploymentName: 'contracted',
    apiVersion: compiled.spec.apiVersion,
    source: 'repository',
    manifestFormat: 'deploy.yaml',
    normalizedSpec: compiled.canonicalJson,
    createdBy: 'admin',
  });
});

after(() => {
  store._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe('application Suitcase data-mode contract', () => {
  it('admits only modes allowed by every declared resource', () => {
    assert.ok(contract.assertApplicationSuitcaseDataMode('app-contracted', 'follows-one-site'));
    assert.throws(
      () => contract.assertApplicationSuitcaseDataMode('app-contracted', 'site-local'),
      (error: unknown) =>
        error instanceof contract.SuitcaseDataModeContractError &&
        error.code === 'suitcase_data_mode_not_allowed' &&
        error.mode === 'site-local' &&
        error.resources.join(',') === 'database' &&
        /resources: database$/.test(error.message),
    );
    assert.throws(
      () => contract.assertApplicationSuitcaseDataMode('app-contracted', 'syncs-across-sites'),
      (error: unknown) =>
        error instanceof contract.SuitcaseDataModeContractError &&
        error.resources.join(',') === 'database,uploads',
    );
  });

  it('fails closed when a graph deployment has no immutable desired revision', () => {
    store.saveDeployment({ name: 'missing-contract', username: 'admin' });
    store
      .getSqlite()!
      .prepare(
        `UPDATE deployments
            SET app_id = 'app-missing-contract', desired_spec_digest = 'sha256:missing',
                spec_source = 'repository'
          WHERE name = 'missing-contract'`,
      )
      .run();
    assert.throws(
      () => contract.assertApplicationSuitcaseDataMode('app-missing-contract', 'site-local'),
      (error: unknown) =>
        error instanceof contract.SuitcaseDataModeContractError &&
        error.code === 'suitcase_data_contract_unavailable' &&
        /immutable graph is unavailable/.test(error.message),
    );
  });
});
