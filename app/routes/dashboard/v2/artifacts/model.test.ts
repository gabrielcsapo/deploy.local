import test from 'node:test';
import assert from 'node:assert/strict';
import type { ArtifactSummary } from '../../../../../shared/v2/artifacts';
import { artifactHref, artifactMeta, createNote, createdHref, galleryTab, shown } from './model';

const entry = (over: Partial<ArtifactSummary>): ArtifactSummary => ({
  projectId: 'forma',
  project: 'forma',
  artifact: null,
  kind: 'design',
  name: 'App design',
  boards: 24,
  updatedAt: new Date(2026, 10, 14, 9).toISOString(),
  branch: null,
  state: null,
  ...over,
});

test('cards open a design on its canvas and a document on its page', () => {
  assert.equal(artifactHref(entry({})), '/dashboard/design?project=forma&view=canvas');
  assert.equal(
    artifactHref(entry({ artifact: 'podcasts-page', branch: 'artifact/podcasts-page' })),
    '/dashboard/design?project=forma&artifact=podcasts-page&view=canvas&ref=artifact%2Fpodcasts-page',
  );
  assert.equal(
    artifactHref(entry({ kind: 'document', artifact: 'one-server-plan' })),
    '/dashboard/artifacts/forma/one-server-plan',
  );
  assert.equal(
    createdHref({
      projectId: 'forma',
      artifact: 'onboarding-flow',
      kind: 'design',
      branch: 'artifact/onboarding-flow',
    }),
    '/dashboard/design?project=forma&artifact=onboarding-flow&view=canvas&ref=artifact%2Fonboarding-flow',
  );
});

test('a card says its project, boards and when it changed', () => {
  const now = new Date(2026, 10, 14, 12);
  assert.equal(artifactMeta(entry({}), now), 'forma · 24 boards · today');
  assert.equal(artifactMeta(entry({ boards: 1 }), now), 'forma · 1 board · today');
  assert.equal(
    artifactMeta(entry({ kind: 'document', boards: undefined, project: 'deploy.local' }), now),
    'deploy.local · today',
  );
});

test('the tabs filter by kind', () => {
  const all = [entry({}), entry({ kind: 'document', artifact: 'plan' })];
  assert.equal(galleryTab('nope'), 'all');
  assert.equal(shown(all, 'all').length, 2);
  assert.deepEqual(
    shown(all, 'documents').map((item) => item.artifact),
    ['plan'],
  );
  assert.equal(shown(all, 'designs').length, 1);
});

test('the dialog says where the files go', () => {
  assert.equal(
    createNote('Onboarding flow', 'forma'),
    'deploy.local adds artifacts/onboarding-flow to forma on a new branch, artifact/onboarding-flow. It reaches main when you approve it.',
  );
  assert.equal(createNote('  ', 'forma'), '');
});
