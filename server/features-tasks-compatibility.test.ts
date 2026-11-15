import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { root } from './test-import-graph.ts';

// Namespace wrappers are distinct objects; every exported binding must be the original
// singleton (including mutable caches and registered ports), never a second evaluation.
test('every task compatibility path exposes the same module bindings', async () => {
  const data = mkdtempSync(join(tmpdir(), 'task-compatibility-'));
  process.env.DEPLOY_DATA_DIR = data;
  try {
    for (const [oldPath, newPath] of [
      ['workspace/activity.ts', 'features/tasks/activity.ts'],
      ['workspace/application-continuation.ts', 'features/tasks/application-continuation.ts'],
      ['workspace/attachment-input.ts', 'features/tasks/attachment-input.ts'],
      ['workspace/checkpoint.ts', 'features/tasks/checkpoint.ts'],
      ['workspace/checkpoint-metadata.ts', 'features/tasks/checkpoint-metadata.ts'],
      ['workspace/checkpoint-publish.ts', 'features/tasks/checkpoint-publish.ts'],
      ['workspace/checkpoint-retention.ts', 'features/tasks/checkpoint-retention.ts'],
      ['workspace/checkpoint-storage.ts', 'features/tasks/checkpoint-storage.ts'],
      ['workspace/checkpoint-tree.ts', 'features/tasks/checkpoint-tree.ts'],
      ['workspace/checks.ts', 'features/tasks/checks.ts'],
      ['workspace/commit-baseline.ts', 'features/tasks/commit-baseline.ts'],
      ['workspace/completion-stream.ts', 'features/tasks/completion-stream.ts'],
      ['workspace/follow-up.ts', 'features/tasks/follow-up.ts'],
      ['workspace/interactive.ts', 'features/tasks/interactive.ts'],
      ['workspace/interactive-runtime.ts', 'features/tasks/interactive-runtime.ts'],
      ['workspace/job-artifact-collect.ts', 'features/tasks/job-artifact-collect.ts'],
      ['workspace/job-artifact-spec.ts', 'features/tasks/job-artifact-spec.ts'],
      ['workspace/job-artifacts.ts', 'features/tasks/job-artifacts.ts'],
      ['workspace/job-output.ts', 'features/tasks/job-output.ts'],
      ['workspace/job-placement.ts', 'features/tasks/job-placement.ts'],
      ['workspace/job-runner.ts', 'features/tasks/job-runner.ts'],
      ['workspace/media-files.ts', 'features/tasks/media-files.ts'],
      ['workspace/message-search.ts', 'features/tasks/message-search.ts'],
      ['workspace/publish.ts', 'features/tasks/publish.ts'],
      ['workspace/queued-message.ts', 'features/tasks/queued-message.ts'],
      ['workspace/read-state.ts', 'features/tasks/read-state.ts'],
      ['workspace/restart-recovery.ts', 'features/tasks/restart-recovery.ts'],
      ['workspace/run-recovery.ts', 'features/tasks/run-recovery.ts'],
      ['workspace/scratch.ts', 'features/tasks/scratch.ts'],
      ['workspace/screenshot-runtime.ts', 'features/tasks/screenshot-runtime.ts'],
      ['workspace/task-clone.ts', 'features/tasks/task-clone.ts'],
      ['workspace/task-delete.ts', 'features/tasks/task-delete.ts'],
      ['workspace/task-files.ts', 'features/tasks/task-files.ts'],
      ['workspace/task-presentation.ts', 'features/tasks/task-presentation.ts'],
      ['workspace/task-shell.ts', 'features/tasks/task-shell.ts'],
      ['workspace/task-workspace.ts', 'features/tasks/task-workspace.ts'],
      ['workspace/terminal-pty.ts', 'features/tasks/terminal-pty.ts'],
      ['workspace/terminal-relay.ts', 'features/tasks/terminal-relay.ts'],
      ['workspace/terminal-service.ts', 'features/tasks/terminal-service.ts'],
      ['workspace/transcription.ts', 'features/tasks/transcription.ts'],
      ['workspace/turn-checkpoint.ts', 'features/tasks/turn-checkpoint.ts'],
      ['workspace/update-base.ts', 'features/tasks/update-base.ts'],
      ['workspace/verification-output.ts', 'features/tasks/verification-output.ts'],
      ['workspace/video-files.ts', 'features/tasks/video-files.ts'],
      ['workspace/workspace-checks.ts', 'features/tasks/workspace-checks.ts'],
      ['workspace/workspace-verification.ts', 'features/tasks/workspace-verification.ts'],
    ]) {
      const oldModule = await import(pathToFileURL(join(root, 'server', oldPath)).href);
      const newModule = await import(pathToFileURL(join(root, 'server', newPath)).href);
      assert.deepEqual(Object.keys(oldModule), Object.keys(newModule), oldPath);
      for (const name of Object.keys(newModule))
        assert.equal(oldModule[name], newModule[name], `${oldPath}: ${name}`);
    }
  } finally {
    const workspace = await import('./workspace/store.ts');
    const engine = await import('./store.ts');
    workspace.db.close();
    engine._resetDb();
    rmSync(data, { recursive: true, force: true });
  }
});
