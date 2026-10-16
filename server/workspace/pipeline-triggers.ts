import { createHash } from 'node:crypto';
import { save, now } from './store.ts';
export function queuePushTrigger(owner: string, projectId: string, ref: string, commit: string) {
  if (
    !ref.startsWith('refs/heads/') ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit) ||
    /^0+$/.test(commit)
  )
    return;
  save('pipeline-trigger-request', owner, {
    id: createHash('sha256')
      .update(JSON.stringify([projectId, ref, commit]))
      .digest('hex'),
    projectId,
    ref,
    commit,
    createdAt: now(),
  });
}
// Receive-pack sends a bounded list of ref commands before the packfile. Never buffer the pack.
export class PushCommands {
  private buffer = Buffer.alloc(0);
  private done = false;
  readonly updates: { ref: string; commit: string }[] = [];
  feed(chunk: Buffer) {
    if (this.done) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const header = this.buffer.subarray(0, 4).toString();
      if (!/^[a-f0-9]{4}$/i.test(header)) {
        this.done = true;
        break;
      }
      const length = parseInt(header, 16);
      if (length === 0) {
        this.done = true;
        break;
      }
      if (length < 4 || length > 65520) {
        this.done = true;
        break;
      }
      if (this.buffer.length < length) break;
      const command = this.buffer.subarray(4, length).toString().split('\0')[0].trimEnd();
      const match = command.match(/^[a-f0-9]{40,64} ([a-f0-9]{40,64}) (refs\/heads\/[^\s]+)$/);
      if (match && this.updates.length < 1000)
        this.updates.push({ commit: match[1], ref: match[2] });
      this.buffer = this.buffer.subarray(length);
    }
    if (this.done || this.buffer.length > 65536) {
      this.done = true;
      this.buffer = Buffer.alloc(0);
    }
  }
}
