/** Real OpenSSH/Git transport tests over a ProxyCommand pipe, without opening a network port. */
import { Duplex, Readable, Writable } from 'node:stream';
import type { Socket } from 'node:net';
import { createGitSshTransport } from '../git-ssh.ts';
import { sshHostKey } from '../ssh-host.ts';
const socket = Object.assign(
  Duplex.from({
    readable: Readable.toWeb(process.stdin),
    writable: Writable.toWeb(process.stdout),
  }),
  {
    setTimeout() {
      return this;
    },
    setNoDelay() {
      return this;
    },
  },
);
const transport = createGitSshTransport(sshHostKey().privateKey);
socket.once('close', () => {
  transport.close();
  process.exit(0);
});
transport.attach(socket as unknown as Socket);
