import { queueCodeIndex } from '../code-index/service.ts';
import { queueCopies } from '../../packages/copies.ts';
import { createHash } from 'node:crypto';
import { get, save, now } from '../../workspace/store.ts';
export function queuePushTrigger(
  owner: string,
  projectId: string,
  ref: string,
  commit: string,
  previousCommit?: string,
) {
  if (
    !ref.startsWith('refs/heads/') ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit) ||
    /^0+$/.test(commit)
  )
    return;
  if (previousCommit !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(previousCommit))
    throw new Error('Invalid previous push commit');
  const branch = (() => {
    try {
      return get('project', owner, projectId).defaultBranch || 'main';
    } catch {
      return 'main';
    }
  })();
  if (ref === `refs/heads/${branch}`) {
    queueCopies(owner, projectId);
    queueCodeIndex(owner, projectId);
  }
  save('pipeline-trigger-request', owner, {
    id: createHash('sha256')
      .update(JSON.stringify([projectId, ref, commit]))
      .digest('hex'),
    projectId,
    ref,
    commit,
    ...(previousCommit !== undefined ? { previousCommit } : {}),
    createdAt: now(),
  });
}
// Receive-pack sends a bounded list of ref commands before the packfile. Never buffer the pack.
export class PushCommands {
  private buffer = Buffer.alloc(0);
  private done = false;
  readonly updates: { ref: string; commit: string; previousCommit: string }[] = [];
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
      const match = command.match(
        /^([a-f0-9]{40,64}) ([a-f0-9]{40,64}) (refs\/(?:heads|tags)\/[^\s]+)$/,
      );
      if (match && this.updates.length < 1000)
        this.updates.push({ previousCommit: match[1], commit: match[2], ref: match[3] });
      this.buffer = this.buffer.subarray(length);
    }
    if (this.done || this.buffer.length > 65536) {
      this.done = true;
      this.buffer = Buffer.alloc(0);
    }
  }
}

/** Shared bounded receive-pack report handling for HTTP and SSH. */
export class PushResult {
  readonly commands = new PushCommands();
  private report = '';
  feed(chunk: Buffer) {
    this.report = (this.report + chunk.toString()).slice(-131072);
  }
  /** The branch and tag updates receive-pack reported as done. */
  accepted() {
    return this.commands.updates.filter((update) => this.report.includes(`ok ${update.ref}\n`));
  }
  queue(owner: string, projectId: string) {
    for (const update of this.accepted())
      queuePushTrigger(owner, projectId, update.ref, update.commit, update.previousCommit);
  }
}
