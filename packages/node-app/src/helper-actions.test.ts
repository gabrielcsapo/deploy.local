import assert from 'node:assert/strict';
import test from 'node:test';
import { runPermissionAction } from './helper-actions.ts';
import type { NodeSetupStatus } from './bridge.ts';

test('reversals confirm before changing the helper; input reversal never keeps input allowed', async () => {
  for (const action of [
    'capture',
    'capture-stop',
    'input',
    'input-stop',
    'lock-off',
    'lock-restore',
  ]) {
    const calls: { command: string; options?: Record<string, unknown> }[] = [];
    let confirmed = false;
    let allow = false;
    const dependencies = {
      confirm: async () => {
        confirmed = true;
        return allow;
      },
      status: async () =>
        ({ node: { capabilities: { input: { state: 'ok' } } } }) as NodeSetupStatus,
      runDesktopHelper: async (command: string, options?: Record<string, unknown>) => {
        assert.equal(confirmed, true);
        calls.push({ command, options });
        return JSON.stringify({ available: true, sessionType: 'x11' });
      },
      source: () => 'bundled Linux helper',
      inspect: async () => {},
    };
    await runPermissionAction(action, dependencies);
    assert.equal(calls.length, 0, 'cancel must leave the helper untouched');
    allow = true;
    await runPermissionAction(action, dependencies);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].command,
      action.startsWith('lock-')
        ? 'screen-lock'
        : action === 'capture-stop'
          ? 'uninstall'
          : 'install',
    );
    if (['input', 'input-stop', 'capture'].includes(action))
      assert.equal(calls[0].options?.allowInput, action !== 'input-stop');
    if (action.startsWith('lock-'))
      assert.equal(calls[0].options?.action, action === 'lock-off' ? 'off' : 'restore');
  }
});
