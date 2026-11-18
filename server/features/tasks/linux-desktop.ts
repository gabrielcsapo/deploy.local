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
  /** The owner installed the helper with --allow-input, and this session supports it. */
  inputAllowed: boolean;
  viewOnly: boolean;
};

/** Fields the helper accepts for each request; anything else is dropped before the socket. */
const actionFields: Record<string, string[]> = {
  status: [],
  inspect: ['expectedBounds'],
  click: ['x', 'y', 'expectedBounds'],
  text: ['text', 'expectedBounds'],
  press: ['key', 'expectedBounds'],
  scroll: ['x', 'y', 'expectedBounds'],
};

export function desktopAction(action: Record<string, any>) {
  const fields = actionFields[action.type];
  if (!fields) throw new Error('Desktop supports inspect, click, text, press and scroll');
  return Object.fromEntries(
    ['type', ...fields].filter((key) => action[key] !== undefined).map((key) => [key, action[key]]),
  );
}

export function desktopSocketPath(env = process.env, uid = process.getuid?.()) {
  // Managed workers do not inherit the graphical session environment. The per-uid
  // runtime path is sufficient; never discover or borrow another user's session.
  return join(env.XDG_RUNTIME_DIR || `/run/user/${uid}`, 'deploy-desktop.sock');
}

export function desktopRequest(
  request: 'status' | 'inspect' | Record<string, any>,
  socketPath = desktopSocketPath(),
  open: (path: string) => Socket = connect,
): Promise<any> {
  const body = desktopAction(typeof request === 'string' ? { type: request } : request);
  return new Promise((resolve, reject) => {
    const socket = open(socketPath);
    let data = '';
    // Anything but status may wait for the on-screen approval.
    const timeout = setTimeout(
      () => finish(new Error('Desktop helper timed out')),
      body.type === 'status' ? 2000 : 150000,
    );
    function finish(error?: Error, result?: any) {
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    }
    socket.on('connect', () => socket.write(JSON.stringify(body) + '\n'));
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
    const inputAllowed = result.available && result.inputAllowed === true;
    status = { ...result, socketPath, inputAllowed, viewOnly: !inputAllowed };
  } catch (error: any) {
    status = {
      available: false,
      reason: `Desktop helper unavailable: ${error.message}. Run deploy desktop-helper install in your graphical session.`,
      socketPath,
      inputAllowed: false,
      viewOnly: true,
    };
  }
  return {
    id: 'desktop',
    kind: 'computer',
    label: `${name} desktop`,
    available: status.available,
    reason: status.reason,
    viewOnly: status.viewOnly,
    desktopStatus: status,
  };
}
