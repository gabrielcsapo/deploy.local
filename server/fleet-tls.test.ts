import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { FetchLike } from '../lib/suitcase-sync-client.ts';

const roots: string[] = [];

after(() => {
  delete process.env.DEPLOY_DATA_DIR;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test('pairing delegates a constrained issuer and the suitcase serves a root-verifiable chain', async () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), 'deploy-fleet-tls-home-'));
  const targetDirectory = mkdtempSync(join(tmpdir(), 'deploy-fleet-tls-target-'));
  const suitcaseDirectory = mkdtempSync(join(tmpdir(), 'deploy-fleet-tls-suitcase-'));
  roots.push(homeDirectory, targetDirectory, suitcaseDirectory);

  process.env.DEPLOY_DATA_DIR = homeDirectory;
  const homeCerts = await import(`./certs.ts?fleet-tls-home=${Date.now()}`);
  homeCerts.ensureCerts(['home-only']);
  const homeRoot = readFileSync(join(homeDirectory, 'certs', 'ca.crt'), 'utf8');
  const homeRootPrivateKey = readFileSync(join(homeDirectory, 'certs', 'ca.key'), 'utf8');
  const homeIdentity = generateKeyPairSync('ed25519')
    .publicKey.export({ type: 'spki', format: 'pem' })
    .toString();

  const syncClient = await import(`../lib/suitcase-sync-client.ts?fleet-tls=${Date.now()}`);
  let pairingRequest: Record<string, unknown> | undefined;
  const fetcher: FetchLike = async (_input, init = {}) => {
    pairingRequest = JSON.parse(String(init.body || '{}')) as Record<string, unknown>;
    const delegated = homeCerts.signSuitcaseIntermediateCertificate(
      String(pairingRequest.intermediateCsr || ''),
    );
    return Response.json(
      {
        siteId: 'site_suitcase_tls',
        fleetId: 'fleet_tls',
        homeSiteId: 'site_home_tls',
        credential: 'site_secret_tls',
        name: 'TLS Suitcase',
        defaultDataPolicy: 'none',
        accessMode: 'existing-lan',
        securityProfile: 'isolated',
        protocolVersion: 1,
        rootPublicIdentity: homeIdentity,
        ...delegated,
      },
      { status: 201 },
    );
  };

  await syncClient.pairSuitcase(
    {
      coordinatorUrl: 'https://home.test',
      code: 'CASE-TLS',
      targetId: 'target-tls',
    },
    { directory: targetDirectory, fetch: fetcher },
  );
  assert.match(String(pairingRequest?.intermediateCsr), /BEGIN CERTIFICATE REQUEST/);
  assert.equal('privateKey' in (pairingRequest || {}), false);

  const membership = syncClient.readSuitcaseMembership(targetDirectory)!;
  assert.ok(membership.tls);
  assert.equal(membership.tls.rootCertificate, homeRoot);
  assert.equal(JSON.stringify(membership).includes(homeRootPrivateKey.trim()), false);
  assert.equal(JSON.stringify(membership.tls).includes('ca.key'), false);

  process.env.DEPLOY_DATA_DIR = suitcaseDirectory;
  execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      `const { initializeSuitcaseMembershipState } = await import('./server/suitcase-bootstrap.ts');
       if (!initializeSuitcaseMembershipState({ membershipFile: ${JSON.stringify(join(targetDirectory, 'fleet-membership.json'))} })) process.exit(2);`,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, DEPLOY_DATA_DIR: suitcaseDirectory, DEPLOY_SUITCASE: '1' },
      stdio: 'pipe',
    },
  );
  const placement = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        `const store = await import('./server/store.ts');
         process.stdout.write(JSON.stringify(store.getFleetPlacementState()));`,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, DEPLOY_DATA_DIR: suitcaseDirectory, DEPLOY_SUITCASE: '1' },
        encoding: 'utf8',
      },
    ),
  ) as { ready: boolean; defaultNodeId: string | null; defaultNode: { kind: string } | null };
  assert.deepEqual(
    {
      ready: placement.ready,
      defaultNodeId: placement.defaultNodeId,
      kind: placement.defaultNode?.kind,
    },
    { ready: true, defaultNodeId: 'coordinator', kind: 'coordinator' },
  );
  const suitcaseCerts = await import(`./certs.ts?fleet-tls-suitcase=${Date.now()}`);
  suitcaseCerts.ensureCerts(['travel-notes']);

  const certificateDirectory = join(suitcaseDirectory, 'certs');
  assert.equal(readFileSync(join(certificateDirectory, 'ca.crt'), 'utf8'), homeRoot);
  assert.equal(existsSync(join(certificateDirectory, 'ca.key')), false);
  assert.equal(existsSync(join(certificateDirectory, 'issuer.key')), true);
  const chain = readFileSync(join(certificateDirectory, 'server.crt'), 'utf8');
  assert.equal(chain.match(/-----BEGIN CERTIFICATE-----/g)?.length, 2);

  const leaf = join(certificateDirectory, 'server-leaf-for-verification.crt');
  writeFileSync(leaf, `${chain.split('-----END CERTIFICATE-----')[0]}-----END CERTIFICATE-----\n`);
  const verification = execFileSync(
    'openssl',
    [
      'verify',
      '-CAfile',
      join(certificateDirectory, 'ca.crt'),
      '-untrusted',
      join(certificateDirectory, 'issuer.crt'),
      leaf,
    ],
    { encoding: 'utf8' },
  );
  assert.match(verification, /: OK/);

  const unrelatedKeyDirectory = mkdtempSync(join(tmpdir(), 'deploy-fleet-tls-wrong-key-'));
  roots.push(unrelatedKeyDirectory);
  const unrelatedKey = join(unrelatedKeyDirectory, 'wrong.key');
  execFileSync('openssl', ['genrsa', '-out', unrelatedKey, '2048'], { stdio: 'pipe' });
  assert.throws(
    () =>
      suitcaseCerts.installDelegatedCertificateMaterial({
        privateKey: readFileSync(unrelatedKey, 'utf8'),
        intermediateCertificate: membership.tls!.intermediateCertificate,
        rootCertificate: membership.tls!.rootCertificate,
      }),
    /does not match/,
  );
  assert.throws(() => homeCerts.validateSuitcaseIntermediateCsr('not a CSR'), /not a valid PEM/);
});
