import { repositoryChanged } from '../../git-changes.ts';
import { spawn } from 'node:child_process';
import { createServer, type Socket } from 'node:net';
import ssh2, { type Connection, type ServerChannel } from 'ssh2';
const { Server, utils } = ssh2;
import { findRepository } from './repositories.ts';
import { gitEnvironment } from '../../workspace/repository-git.ts';
import { PushResult } from '../../workspace/pipeline-triggers.ts';
import { findSshKey, sshFingerprint, verifySshSignature } from './ssh-keys.ts';
import { configuredSshPort, setSshServerState, sshHostKey } from './ssh-host.ts';
import { now, save } from '../../workspace/store.ts';

/** No shell parsing: one Git service and one simple repository identifier. */
export function parseGitCommand(command: string) {
  const match = command.match(
    /^git(?:-| )(upload-pack|receive-pack) (?:'([^']+)'|"([^"\n]+)"|([^\s'"]+))$/,
  );
  if (!match) return null;
  const path = (match[2] || match[3] || match[4]).replace(/^(?:~\/|\/)/, '').replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(path)) return null;
  return { service: match[1], path };
}

/**
 * ssh2 1.16's public end() omits the SSH disconnect description. Authentication has
 * no stderr channel yet. Send a standard SSH_MSG_DISCONNECT with the failure text
 * so OpenSSH prints it on stderr, without a login banner. Keep this pinned-version
 * adapter isolated; the real OpenSSH integration test exercises its wire format.
 */
function authenticationFailure(client: Connection, socket: Socket, message: string) {
  const protocol = (client as any)._protocol;
  const writer = protocol._packetRW.write;
  const description = Buffer.from(message);
  let offset = writer.allocStartKEX;
  const packet = writer.alloc(1 + 4 + 4 + description.length + 4, true);
  packet[offset++] = 1; // SSH_MSG_DISCONNECT
  packet.writeUInt32BE(14, offset); // SSH_DISCONNECT_NO_MORE_AUTH_METHODS_AVAILABLE
  offset += 4;
  packet.writeUInt32BE(description.length, offset);
  offset += 4;
  description.copy(packet, offset);
  packet.writeUInt32BE(0, offset + description.length); // language tag
  protocol._cipher.encrypt(writer.finalize(packet, true));
  socket.end();
}

/** Transport separate from the TCP listener so protocol tests can use an in-memory socket pair. */
export function createGitSshTransport(privateKey: Buffer) {
  const sockets = new Set<Socket>();
  let sessions = 0;
  const ssh = new Server({
    hostKeys: [privateKey],
    ident: 'deploy.local',
    keepaliveInterval: 15000,
    keepaliveCountMax: 3,
  });
  // Owning the sockets gives us handshake/idle deadlines, a connection cap, and clean shutdown.
  const attach = (socket: Socket) => {
    if (sockets.size >= 64) return void socket.destroy();
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(30000, () => socket.destroy());
    ssh.injectSocket(socket);
  };
  ssh.on('connection', (client: Connection) => {
    const socket = (client as any)._sock as Socket;
    let owner = '';
    let attempts = 0;
    let clientSessions = 0;
    const deadline = setTimeout(() => socket.destroy(), 30000);
    client.on('error', () => socket.destroy());
    client.on('close', () => clearTimeout(deadline));
    client.on('authentication', (context) => {
      if (++attempts > 8)
        return authenticationFailure(client, socket, 'Too many SSH authentication attempts');
      if (context.username !== 'git' || context.method !== 'publickey')
        return context.reject(['publickey']);
      const found = findSshKey(sshFingerprint(context.key.data));
      if (!found)
        return authenticationFailure(
          client,
          socket,
          "Add this computer's SSH key in deploy.local Settings → SSH keys",
        );
      const key = utils.parseKey(found.key.publicKey);
      if (key instanceof Error || Array.isArray(key)) return context.reject(['publickey']);
      if (!context.signature) return context.accept(); // Public-key probe; not authenticated yet.
      const principal = verifySshSignature(
        found,
        key,
        context.blob,
        context.signature,
        context.hashAlgo,
      );
      if (!principal) return context.reject(['publickey']);
      owner = principal.owner;
      save('ssh-key', owner, { ...found.key, lastUsedAt: now() });
      context.accept();
    });
    client.on('ready', () => {
      clearTimeout(deadline);
      socket.setTimeout(120000);
    });
    // Unhandled channel/global requests are rejected by ssh2, including forwarding.
    client.on('session', (accept, reject) => {
      if (!owner || sessions >= 32 || clientSessions >= 4) return reject();
      sessions++;
      clientSessions++;
      const session = accept();
      let protocol = '';
      let started = false;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        client.removeListener('close', release);
        sessions--;
        clientSessions--;
      };
      session.once('close', release);
      client.once('close', release);
      session.on('env', (acceptEnv, rejectEnv, info) => {
        if (!started && info.key === 'GIT_PROTOCOL' && info.val === 'version=2') {
          protocol = info.val;
          acceptEnv?.();
        } else rejectEnv?.();
      });
      const fail = (channel: ServerChannel, message: string) => {
        channel.stderr.write(message + '\n');
        channel.exit(1);
        channel.end();
      };
      session.on('shell', (acceptShell) => {
        started = true;
        fail(
          acceptShell(),
          'deploy.local supports Git over SSH only; interactive shells are disabled.',
        );
      });
      session.on('exec', (acceptExec, rejectExec, info) => {
        if (started) return rejectExec();
        started = true;
        const channel = acceptExec();
        channel.on('error', () => channel.destroy());
        const command = parseGitCommand(info.command);
        if (!command)
          return fail(channel, 'Only git-upload-pack and git-receive-pack are supported.');
        let project;
        try {
          project = findRepository(owner, command.path);
        } catch (error: any) {
          return fail(channel, error.status === 409 ? error.message : 'repository not found');
        }
        const child = spawn(
          'git',
          ['-c', 'core.hooksPath=/dev/null', command.service, project.repositoryPath],
          {
            env: { ...gitEnvironment(), ...(protocol ? { GIT_PROTOCOL: protocol } : {}) },
            detached: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );
        const push = command.service === 'receive-pack' ? new PushResult() : null;
        let completed = false;
        const kill = () => {
          if (completed) return;
          try {
            process.kill(-child.pid!, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        };
        const timeout = setTimeout(() => {
          fail(channel, 'Git transfer timed out');
          kill();
        }, 600000);
        channel.once('close', () => {
          clearTimeout(timeout);
          kill();
        });
        socket.once('close', kill);
        child.stdin.on('error', () => {});
        if (push) {
          channel.on('data', (chunk: Buffer) => push.commands.feed(chunk));
          child.stdout.on('data', (chunk: Buffer) => push.feed(chunk));
        }
        channel.pipe(child.stdin);
        child.stdout.pipe(channel, { end: false });
        child.stderr.pipe(channel.stderr, { end: false });
        child.once('error', () => fail(channel, 'Git unavailable'));
        child.once('close', (code) => {
          if (push) repositoryChanged(project.repositoryPath);
          clearTimeout(timeout);
          socket.removeListener('close', kill);
          completed = true;
          if (code === 0) push?.queue(owner, project.id);
          if (!channel.destroyed) {
            channel.exit(code ?? 1);
            channel.end();
          }
        });
      });
    });
  });
  return {
    attach,
    close() {
      for (const socket of sockets) socket.destroy();
    },
  };
}

export async function startGitSshServer(
  options: { port?: number; host?: string; log?: (message: string) => void } = {},
) {
  const log = options.log ?? console.error;
  let port: number;
  let host: ReturnType<typeof sshHostKey>;
  try {
    port = options.port ?? configuredSshPort();
    if (options.port === undefined && port === 0) {
      setSshServerState(null);
      return null;
    }
    host = sshHostKey();
  } catch (error) {
    log(`[ssh] Cannot start Git SSH server: ${(error as Error).message}`);
    setSshServerState(null);
    return null;
  }
  const transport = createGitSshTransport(host.privateKey);
  const listener = createServer(transport.attach);
  listener.on('error', (error) => log(`[ssh] Git SSH listener failed: ${error.message}`));
  const listening = await new Promise<boolean>((resolve) => {
    listener.once('error', () => resolve(false));
    listener.listen(port, options.host ?? '0.0.0.0', () => resolve(true));
  });
  if (!listening) {
    setSshServerState(null);
    return null;
  }
  const boundPort = (listener.address() as import('node:net').AddressInfo).port;
  setSshServerState(boundPort, host);
  log(`[ssh] Git SSH listening on ${options.host ?? '0.0.0.0'}:${boundPort}`);
  return {
    port: boundPort,
    async close() {
      setSshServerState(null);
      transport.close();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    },
  };
}
