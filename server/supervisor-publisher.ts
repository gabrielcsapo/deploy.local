import { createConnection, type Socket } from 'node:net';
import { deployDataPath } from './kernel/files/data-directory.ts';

// Fleet samples and deployment notices share one best-effort connection. Only queue
// while dialing; failures drop notices so reconnecting never replays old deploys.
let socket: Socket | null = null;
let pending: string[] = [];

export function publishSupervisorLine(line: string) {
  if (socket && !socket.destroyed) {
    if (socket.connecting) {
      if (pending.length < 128) pending.push(line);
    } else if (socket.writableLength < 65_536) socket.write(line);
    return;
  }
  pending = [line];
  const connection = (socket = createConnection(deployDataPath('supervisor.sock')));
  connection.unref();
  connection.on('data', () => {});
  connection.on('connect', () => {
    for (const queued of pending) connection.write(queued);
    pending = [];
  });
  connection.on('error', () => connection.destroy());
  connection.on('close', () => {
    if (socket === connection) {
      socket = null;
      pending = [];
    }
  });
}
