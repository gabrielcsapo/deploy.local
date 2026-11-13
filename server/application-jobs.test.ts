import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planApplicationExecution, type ActualComponentInstance } from './application-execution.ts';
import { jobExecutionKey, planApplicationJobs } from './application-jobs.ts';
import { compileApplicationManifest } from './application-spec.ts';

const spec = compileApplicationManifest({
  apiVersion: 'deploy.local/v1',
  kind: 'Application',
  components: { web: { image: 'example/web:1', instances: 2 } },
  jobs: {
    migrate: { component: 'web', command: ['npm', 'run', 'migrate'], beforeTraffic: true },
    warm: { component: 'web', command: ['npm', 'run', 'warm'], execution: 'perInstance' },
    compact: { component: 'web', command: ['npm', 'run', 'compact'], execution: 'writerSite' },
  },
}).spec;
const execution = planApplicationExecution('notes', spec);
const instances: ActualComponentInstance[] = ['one', 'two'].map((id, index) => ({
  id,
  component: 'web',
  slot: `notes/web/${index + 1}`,
  releaseDigest: execution.specDigest,
  configurationDigest: 'sha256:config',
  status: 'ready',
  endpoints: [],
}));

describe('scoped application lifecycle jobs', () => {
  it('plans per-site, per-instance, and writer-site work with stable idempotency keys', () => {
    const plan = planApplicationJobs(execution, spec, instances, {
      siteId: 'home',
      writerSiteId: 'home',
      configurationDigest: 'sha256:config',
    });
    assert.equal(plan.executions.length, 4);
    assert.equal(plan.executions.filter((item) => item.scope === 'perInstance').length, 2);
    assert.equal(plan.executions.filter((item) => item.scope === 'perSite').length, 1);
    assert.equal(plan.executions.filter((item) => item.scope === 'writerSite').length, 1);
    assert.equal(plan.trafficGates.web, false);
    assert.equal(plan.executions[0].key, plan.executions[0].key);
  });

  it('does not rerun completed work and does not claim writer work on a reader site', () => {
    const migrateKey = jobExecutionKey({
      applicationId: 'notes',
      releaseDigest: execution.specDigest,
      configurationDigest: 'sha256:config',
      jobName: 'migrate',
      siteId: 'suitcase',
    });
    const plan = planApplicationJobs(execution, spec, instances, {
      siteId: 'suitcase',
      writerSiteId: 'home',
      configurationDigest: 'sha256:config',
      records: [{ key: migrateKey, status: 'succeeded', attempts: 1 }],
    });
    assert.equal(
      plan.executions.some((item) => item.job === 'migrate'),
      false,
    );
    assert.equal(
      plan.executions.some((item) => item.job === 'compact'),
      false,
    );
    assert.equal(plan.trafficGates.web, true);
  });

  it('leaves a writer-site job with no record to an owner action when unattended', () => {
    const plan = planApplicationJobs(execution, spec, instances, {
      siteId: 'home',
      writerSiteId: 'home',
      configurationDigest: 'sha256:config',
      unattended: true,
    });
    assert.deepEqual(plan.held, ['compact']);
    assert.equal(
      plan.executions.some((item) => item.job === 'compact'),
      false,
    );
    assert.equal(
      plan.executions.some((item) => item.job === 'migrate'),
      true,
      'per-site jobs keep running unattended, as they always have',
    );
  });

  it('never retries a failed job when unattended, and retries it for an owner action', () => {
    const key = jobExecutionKey({
      applicationId: 'notes',
      releaseDigest: execution.specDigest,
      configurationDigest: 'sha256:config',
      jobName: 'compact',
      siteId: 'home',
    });
    const options = {
      siteId: 'home',
      writerSiteId: 'home',
      configurationDigest: 'sha256:config',
      retryFailed: true,
      records: [{ key, status: 'failed' as const, attempts: 1 }],
    };
    const unattended = planApplicationJobs(execution, spec, instances, {
      ...options,
      unattended: true,
    });
    assert.deepEqual(unattended.failed, ['compact']);
    assert.equal(
      unattended.executions.some((item) => item.job === 'compact'),
      false,
    );
    const attended = planApplicationJobs(execution, spec, instances, options);
    assert.deepEqual(attended.failed, []);
    assert.equal(attended.executions.find((item) => item.job === 'compact')?.attempt, 2);
  });

  it('blocks writer-site jobs until writer authority is known', () => {
    const plan = planApplicationJobs(execution, spec, instances, {
      siteId: 'home',
      configurationDigest: 'sha256:config',
    });
    assert.equal(plan.blocked, true);
    assert.ok(plan.findings.some((item) => item.code === 'WRITER_SITE_UNRESOLVED'));
  });
});
