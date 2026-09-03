import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { selectServiceBackend, ServiceEndpointPool } from './service-routing.ts';

describe('health-aware service endpoint pools', () => {
  it('selects only ready endpoints, supports affinity, and drains without new traffic', () => {
    const pool = new ServiceEndpointPool();
    pool.replace('notes/web/http', [
      {
        id: 'one',
        serviceId: 'notes/web/http',
        instanceId: 'instance-1',
        host: '10.0.0.1',
        port: 3000,
        releaseDigest: 'sha256:new',
        readiness: 'ready',
      },
      {
        id: 'two',
        serviceId: 'notes/web/http',
        instanceId: 'instance-2',
        host: '10.0.0.2',
        port: 3000,
        releaseDigest: 'sha256:new',
        readiness: 'unready',
      },
    ]);

    const first = pool.select('notes/web/http');
    assert.equal(first?.endpoint.id, 'one');
    pool.setReadiness('notes/web/http', 'two', 'ready');
    const affinityA = pool.select('notes/web/http', { affinityKey: 'alice' });
    const affinityB = pool.select('notes/web/http', { affinityKey: 'alice' });
    assert.equal(affinityA?.endpoint.id, affinityB?.endpoint.id);

    pool.beginDrain('notes/web/http', 'one', 5_000);
    assert.equal(pool.select('notes/web/http')?.endpoint.id, 'two');
    assert.equal(pool.drainComplete('notes/web/http', 'one', 1_000), false);
    first?.release();
    assert.equal(pool.drainComplete('notes/web/http', 'one', 1_000), true);
    assert.deepEqual(pool.removeDrained('notes/web/http', 1_000), ['one']);

    affinityA?.release();
    affinityB?.release();

    const backend = selectServiceBackend(pool, 'notes/web/http');
    assert.deepEqual(
      backend && { host: backend.host, port: backend.port, endpointId: backend.endpointId },
      { host: '10.0.0.2', port: 3000, endpointId: 'two' },
    );
    backend?.release();
  });

  it('atomically replaces membership and preserves in-flight accounting for retained endpoints', () => {
    const pool = new ServiceEndpointPool();
    pool.replace('service', [
      {
        id: 'one',
        serviceId: 'service',
        instanceId: 'instance-1',
        host: '127.0.0.1',
        port: 3000,
        releaseDigest: 'sha256:one',
        readiness: 'ready',
      },
    ]);
    const lease = pool.select('service')!;
    pool.replace('service', [
      {
        id: 'one',
        serviceId: 'service',
        instanceId: 'instance-1',
        host: '127.0.0.1',
        port: 3000,
        releaseDigest: 'sha256:one',
        readiness: 'draining',
      },
    ]);
    assert.equal(pool.snapshot('service')[0].inFlight, 1);
    assert.equal(pool.select('service'), null);
    lease.release();
    assert.equal(pool.snapshot('service')[0].inFlight, 0);
  });
});
