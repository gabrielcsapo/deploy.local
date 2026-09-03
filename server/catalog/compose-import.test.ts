import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { importDockerCompose } from './compose-import.ts';

const PINNED_IMAGE = `example.invalid/app@sha256:${'a'.repeat(64)}`;

describe('strict Docker Compose importer', () => {
  it('translates its supported subset and records every ignored field', () => {
    const result = importDockerCompose(`
name: example
services:
  web:
    image: ${PINNED_IMAGE}
    command: ["node", "server.js"]
    environment:
      MODE: \${MODE}
    volumes:
      - data:/data:ro
    depends_on: [worker]
    networks: [private]
    restart: unless-stopped
    x-owner: team
  worker:
    image: ${PINNED_IMAGE}
volumes:
  data: {}
networks:
  private:
    driver: bridge
`);
    assert.equal(result.status, 'ready');
    assert.ok(result.spec);
    assert.equal(result.plan?.source, 'compose-import');
    assert.deepEqual(result.plan?.impacts.capacity, {
      currentInstances: 0,
      desiredInstances: 2,
      addedInstances: 2,
      removedInstances: 0,
      rollingSurgeInstances: 0,
      peakInstances: 2,
      revalidationRequired: true,
    });
    assert.deepEqual(result.plan?.impacts.data.createdResources, ['data']);
    assert.equal(result.spec.components.web.mounts['/data'].readOnly, true);
    assert.equal(result.spec.configuration.MODE.required, true);
    assert.deepEqual(result.spec.components.web.dependsOn, ['worker']);
    assert.ok(
      result.findings.some(
        (finding) => finding.path === '$.services.web.restart' && finding.disposition === 'ignored',
      ),
    );
    assert.ok(
      result.findings.some(
        (finding) => finding.path === '$.services.web.x-owner' && finding.disposition === 'ignored',
      ),
    );
  });

  it('reports security-sensitive and unsupported semantics instead of dropping them', () => {
    const result = importDockerCompose(`
services:
  web:
    image: ${PINNED_IMAGE}
    ports: ["8080:80"]
    volumes: ["./host:/data"]
    privileged: true
    network_mode: host
    deploy:
      resources:
        limits:
          memory: 1G
`);
    assert.equal(result.status, 'blocked');
    const byPath = new Map(result.findings.map((finding) => [finding.path, finding]));
    assert.equal(byPath.get('$.services.web.ports[0]')?.disposition, 'review-required');
    assert.equal(byPath.get('$.services.web.volumes[0]')?.disposition, 'review-required');
    assert.equal(byPath.get('$.services.web.privileged')?.securitySensitive, true);
    assert.equal(byPath.get('$.services.web.network_mode')?.disposition, 'review-required');
    assert.equal(byPath.get('$.services.web.deploy')?.disposition, 'blocking');
  });

  it('blocks literal environment values, aliases, and unknown fields', () => {
    const literal = importDockerCompose(`
services:
  web:
    image: ${PINNED_IMAGE}
    environment:
      TOKEN: plaintext
    mystery: true
`);
    assert.equal(literal.status, 'blocked');
    assert.ok(
      literal.findings.some(
        (finding) =>
          finding.path === '$.services.web.environment.TOKEN' && finding.securitySensitive,
      ),
    );
    assert.ok(literal.findings.some((finding) => finding.path === '$.services.web.mystery'));

    const aliases = importDockerCompose(`
x-base: &base
  image: ${PINNED_IMAGE}
services:
  web: *base
`);
    assert.equal(aliases.status, 'blocked');
    assert.equal(aliases.plan, null);
    assert.match(aliases.findings[0].summary, /anchors and aliases/);
  });
});
