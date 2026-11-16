import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { root } from './test-import-graph.ts';

// A split leaves the rest of the old module in place and re-exports what moved. Every moved
// binding must be the same singleton through both paths, never a second evaluation.
test('every split keeps the moved bindings on the old path', async () => {
  const data = mkdtempSync(join(tmpdir(), 'feature-splits-'));
  process.env.DEPLOY_DATA_DIR = data;
  try {
    for (const [oldPath, newPath, names] of [
      [
        'workspace/managed-worker.ts',
        'features/tasks/managed-worker-root.ts',
        ['managedWorkerRoot', 'workerIdentity'],
      ],
      [
        'v2/releases-api.ts',
        'features/releases/project-release-service.ts',
        ['projectReleaseService', 'requestWorkerRollback'],
      ],
      [
        'v2/attachments.ts',
        'features/agents/agent-chat.ts',
        [
          'attachmentBytes',
          'attachmentRecord',
          'chatModel',
          'ownedAttachments',
          'sendAgentMessage',
        ],
      ],
      ['v2/attachments.ts', 'features/agents/media-event.ts', ['mapMediaEvent']],
      ['v2/events.ts', 'features/agents/conversation-events.ts', ['mapConversationEvent']],
    ] as const) {
      const oldModule = await import(pathToFileURL(join(root, 'server', oldPath)).href);
      const newModule = await import(pathToFileURL(join(root, 'server', newPath)).href);
      assert.deepEqual(Object.keys(newModule), [...names], newPath);
      for (const name of names) {
        assert.notEqual(newModule[name], undefined, `${newPath}: ${name}`);
        assert.equal(oldModule[name], newModule[name], `${oldPath}: ${name}`);
      }
    }
  } finally {
    const workspace = await import('./workspace/store.ts');
    const engine = await import('./store.ts');
    workspace.db.close();
    engine._resetDb();
    rmSync(data, { recursive: true, force: true });
  }
});
