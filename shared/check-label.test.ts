import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkCommandLabel,
  checkCommandText,
  checkPathText,
  workspaceRelativePath,
} from './check-label.ts';

/** A Mac keeps its tasks under a root with a space in it, which is what defeated the generic
 * path rule and left `Application Support/deploy.local/worker/tasks/<id>` in a check label. */
const macRoot =
  '/Users/gabrielcsapo/Library/Application Support/deploy.local/worker/tasks/807f8ec3-1111-2222-3333-444455556666';
const task = {
  id: '807f8ec3-1111-2222-3333-444455556666',
  workspacePath: macRoot,
  remoteWorkspacePath: '/home/bazzite/.local/share/deploy.local/task-workers/node-a/tasks/807f8ec3',
};

test('the command forms from task 807f8ec3 read as the checks they ran', () => {
  const label = checkCommandLabel(
    `cd "${macRoot}" && node --import tsx --test --test-name-pattern="never claims" app/routes/dashboard/task-first-load.test.mjs 2>&1 | tail -40`,
    task,
  );
  assert.equal(
    label,
    'node --test --test-name-pattern="never claims" app/routes/dashboard/task-first-load.test.mjs',
  );
  // Nothing of the worker's own directory layout survives anywhere in the label.
  for (const fragment of ['cd ', '/Users', 'Application Support', 'worker/tasks', 'tail', '2>&1'])
    assert.ok(!label.includes(fragment), fragment);
  assert.equal(
    checkCommandLabel('set -o pipefail && pnpm typecheck 2>&1 | tail -60', task),
    'pnpm typecheck',
  );
  assert.equal(
    checkCommandLabel(
      `cd "${macRoot}" && echo "=== TYPES ===" && pnpm typecheck && echo "=== LINT ===" && pnpm lint`,
      task,
    ),
    'pnpm typecheck · pnpm lint',
  );
  assert.equal(
    checkCommandLabel(`node --import=tsx --test "${macRoot}/server/edge/edge.test.ts"`, task),
    'node --test server/edge/edge.test.ts',
  );
  // The remote worker's own root is the same workspace, and so is a path only the id places.
  assert.equal(
    checkCommandLabel(`cd ${task.remoteWorkspacePath} && pnpm test | tail -n 20`, task),
    'pnpm test',
  );
  assert.equal(
    checkCommandLabel('cd /srv/agent/tasks/807f8ec3-1111-2222-3333-444455556666/app && pnpm test', {
      id: task.id,
    }),
    'cd app · pnpm test',
  );
});

test('a directory inside the workspace is kept as the repository path it names', () => {
  assert.equal(
    checkCommandLabel(`cd "${macRoot}/native/Apple/Packages/DeployKit" && swift test`, task),
    'cd native/Apple/Packages/DeployKit · swift test',
  );
  assert.equal(
    checkCommandLabel('cd native/Apple && swift test', task),
    'cd native/Apple · swift test',
  );
  // A directory on a worker's disk that is no task workspace cannot be shown relative to one,
  // and names nothing a reviewer can use.
  assert.equal(checkCommandLabel('cd /Users/someone/other-repo && pnpm test', task), 'pnpm test');
});

test('only a bounded tail is plumbing; any other pipeline is shown as it was written', () => {
  assert.equal(
    checkCommandLabel('pnpm test | grep -c failing', task),
    'pnpm test | grep -c failing',
  );
  assert.equal(checkCommandLabel('pnpm test | head -20', task), 'pnpm test');
  // A command that was nothing but plumbing still has to read as something.
  assert.equal(checkCommandLabel('set -o pipefail', task), 'set -o pipefail');
  assert.equal(checkCommandLabel(''), '');
  assert.equal(checkCommandLabel(undefined), '');
});

test('the full command keeps its plumbing and loses only the worker paths', () => {
  assert.equal(
    checkCommandText(`cd "${macRoot}" && pnpm test 2>&1 | tail -40`, task),
    'cd . && pnpm test 2>&1 | tail -40',
  );
  assert.equal(
    checkCommandText(`npx oxfmt --check "${macRoot}/shared/check-label.ts"`, task),
    'npx oxfmt --check shared/check-label.ts',
  );
  // Outside every known workspace, a worker path keeps its file name, as task views show it.
  assert.equal(
    checkCommandText('node --test /home/other/worker/tasks/abcd/app/a.test.mjs', task),
    'node --test a.test.mjs',
  );
  // Paths that mean the same thing on every computer are left exactly as written.
  assert.equal(
    checkCommandText('/usr/local/bin/pytest tests/unit', task),
    '/usr/local/bin/pytest tests/unit',
  );
});

test('workspace paths resolve against both roots, the task id, and nothing else', () => {
  assert.equal(workspaceRelativePath(macRoot, task), '');
  assert.equal(workspaceRelativePath(`${macRoot}/app/a.ts`, task), 'app/a.ts');
  assert.equal(workspaceRelativePath(`"${macRoot}/app"`, task), 'app');
  assert.equal(workspaceRelativePath(`file://${macRoot}/app/`, task), 'app');
  assert.equal(
    workspaceRelativePath('/srv/tasks/807f8ec3-1111-2222-3333-444455556666/a', task),
    'a',
  );
  // A task whose id is only a prefix of this one is a different task.
  assert.equal(workspaceRelativePath('/srv/tasks/807f8ec3-other/a', task), null);
  assert.equal(workspaceRelativePath('app/a.ts', task), null);
  assert.equal(checkPathText('/etc/hosts', task), '/etc/hosts');
  assert.equal(checkPathText('/Users/someone/notes.md', task), 'notes.md');
});
