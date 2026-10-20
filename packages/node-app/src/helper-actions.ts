import type { NodeSetupStatus } from './bridge.ts';

/** All desktop grants and reversals pass through the same native confirmation path. */
export async function runPermissionAction(
  action: string,
  {
    confirm,
    status,
    runDesktopHelper,
    source,
    inspect,
  }: {
    confirm: (message: string, detail: string, label: string) => Promise<boolean>;
    status: () => Promise<NodeSetupStatus>;
    runDesktopHelper: (command: string, options?: Record<string, unknown>) => Promise<string>;
    source: () => string;
    inspect: (socket: string) => Promise<unknown>;
  },
) {
  if (
    !['capture', 'capture-stop', 'input', 'input-stop', 'lock-off', 'lock-restore'].includes(action)
  )
    throw new Error('Unknown permission action');
  if (action.startsWith('lock-')) {
    const off = action === 'lock-off';
    if (
      !(await confirm(
        off ? 'Turn off automatic screen lock?' : 'Restore automatic screen lock?',
        off
          ? 'Anyone with physical access to this computer can use its desktop without a password. Captures work unattended. Restore the lock from setup at any time.'
          : 'Restore the settings saved before Deploy turned off the lock. Captures show nothing while the screen is locked.',
        off ? 'Keep unlocked' : 'Restore lock',
      ))
    )
      return;
    await runDesktopHelper('screen-lock', { action: off ? 'off' : 'restore' });
  } else {
    const stopping = action === 'capture-stop' || action === 'input-stop';
    if (
      !(await confirm(
        action === 'capture-stop'
          ? 'Stop screen capture?'
          : action === 'input-stop'
            ? 'Make this computer view-only?'
            : action === 'input'
              ? 'Allow clicking and typing?'
              : 'Allow screen capture?',
        action === 'capture-stop'
          ? 'Agents will no longer be able to capture or control this desktop.'
          : action === 'input-stop'
            ? 'Approved agents can still see the screen, but cannot click or type.'
            : action === 'input'
              ? 'Agents approved in a conversation can click and type on this desktop.'
              : 'Agents approved in a conversation can see this desktop. Approve the screen-sharing dialog on this computer.',
        stopping ? 'Turn off' : 'Allow',
      ))
    )
      return;
    if (action === 'capture-stop') {
      await runDesktopHelper('uninstall');
      return;
    }
    const result = JSON.parse(
      await runDesktopHelper('install', {
        allowInput:
          action === 'input' ||
          (action !== 'input-stop' && (await status()).node.capabilities.input.state === 'ok'),
        json: true,
        source: source(),
      }),
    );
    if (!result.available)
      throw new Error(
        'The desktop helper is unavailable. Run deploy desktop-helper status for the dependency or session fix.',
      );
    if (result.sessionType === 'wayland') await inspect(result.socketPath);
  }
}
