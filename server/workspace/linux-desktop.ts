import { connect, type Socket } from 'node:net';
import { hostname } from 'node:os';
import { join } from 'node:path';

export type DesktopStatus = {
  available: boolean;
  reason: string;
  sessionType?: string;
  desktop?: string;
  portalAvailable?: boolean | null;
  portalVersion?: number;
  grantStored?: boolean | null;
  socketPath: string;
  viewOnly: true;
};

export function desktopSocketPath(env = process.env, uid = process.getuid?.()) {
  // Managed workers do not inherit the graphical session environment. The per-uid
  // runtime path is sufficient; never discover or borrow another user's session.
  return join(env.XDG_RUNTIME_DIR || `/run/user/${uid}`, 'deploy-desktop.sock');
}

export function desktopRequest(
  type: 'status' | 'inspect',
  socketPath = desktopSocketPath(),
  open: (path: string) => Socket = connect,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = open(socketPath);
    let data = '';
    const timeout = setTimeout(
      () => finish(new Error('Desktop helper timed out')),
      type === 'inspect' ? 150000 : 2000,
    );
    function finish(error?: Error, result?: any) {
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    }
    socket.on('connect', () => socket.write(JSON.stringify({ type }) + '\n'));
    socket.on('error', (error) => finish(error));
    socket.on('end', () => finish(new Error('Desktop helper disconnected before replying')));
    socket.on('data', (chunk) => {
      data += chunk.toString();
      if (data.length > 1500000) return finish(new Error('Desktop helper response too large'));
      if (!data.includes('\n')) return;
      try {
        const result = JSON.parse(data);
        if (!result || typeof result !== 'object' || Array.isArray(result))
          throw new Error('Invalid desktop helper response');
        finish(result.error ? new Error(String(result.error)) : undefined, result);
      } catch (error) {
        finish(error as Error);
      }
    });
  });
}

export async function linuxDesktopTarget(
  request = desktopRequest,
  socketPath = desktopSocketPath(),
  name = hostname(),
) {
  let status: DesktopStatus;
  try {
    const result = await request('status', socketPath);
    if (typeof result.available !== 'boolean' || typeof result.reason !== 'string')
      throw new Error('Invalid desktop helper status');
    status = { ...result, socketPath, viewOnly: true };
  } catch (error: any) {
    status = {
      available: false,
      reason: `Desktop helper unavailable: ${error.message}. Run deploy desktop-helper install in your graphical session.`,
      socketPath,
      viewOnly: true,
    };
  }
  return {
    id: 'desktop',
    kind: 'computer',
    label: `${name} desktop`,
    available: status.available,
    reason: status.reason,
    viewOnly: true,
    desktopStatus: status,
  };
}
