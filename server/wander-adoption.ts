import { randomUUID } from 'node:crypto';
import { ciMutationActive, withCiMutation } from './ci-fence.ts';
import {
  readWanderJournal,
  writeWanderJournal,
  wanderOwnerAlive,
  type WanderJournal,
  type WanderSnapshot,
} from './wander-adoption-fence.ts';

export interface WanderIntent {
  applicationId: string;
  expectedContainer: string;
  expectedImage: string;
  expectedRuntimeSettings: string;
  expectedSource: string;
  expectedParent: string;
  sourceCommit: string;
  sourceDigest: string;
  sourceArchiveDigest: string;
  requestKey: string;
  specDigest: string;
  sourceDirectory: string;
}
export interface WanderAdoptionAdapter {
  acquire(j: WanderJournal): Promise<void>;
  claim(j: WanderJournal): WanderJournal;
  release(j: WanderJournal): void;
  reserve(intent: WanderIntent, owner: string): WanderJournal;
  checkBaseline(j: WanderJournal, stopped: boolean): Promise<void>;
  build(j: WanderJournal): Promise<string>;
  stopLegacy(j: WanderJournal): Promise<void>;
  snapshot(j: WanderJournal): Promise<WanderSnapshot>;
  seed(j: WanderJournal, resource: 'data' | 'uploads'): Promise<void>;
  verifySeed(j: WanderJournal): Promise<void>;
  activate(j: WanderJournal): Promise<string>;
  verifyCandidate(j: WanderJournal): Promise<void>;
  commit(j: WanderJournal): Promise<void>;
  fenceHelpers(j: WanderJournal): Promise<void>;
  resumeOriginal(j: WanderJournal): Promise<void>;
}
const error = (message: string): never => {
  throw Object.assign(new Error(message), { status: 409 });
};
/** Exactly one Wander cold-copy transaction. Failures never restore or rewind data. */
export class WanderAdoption {
  private owner: string;
  private adapter: WanderAdoptionAdapter;
  constructor(owner: string, adapter: WanderAdoptionAdapter) {
    this.owner = owner;
    this.adapter = adapter;
  }
  status() {
    const j = readWanderJournal();
    if (j && j.owner !== this.owner) throw Object.assign(new Error('Not found'), { status: 404 });
    return j ? this.receipt(j) : { application: 'wander', status: 'not-started' };
  }
  private receipt(j: WanderJournal) {
    return {
      operationId: j.id,
      application: j.application,
      applicationId: j.applicationId,
      sourceCommit: j.sourceCommit,
      sourceDigest: j.sourceDigest,
      sourceArchiveDigest: j.sourceArchiveDigest,
      specDigest: j.specDigest,
      status: j.phase,
      imageDigest: j.image,
      containerId: j.candidateContainer,
      backupVerified: !!j.snapshot,
      requiresOwnerRecovery: !['committed', 'cancelled'].includes(j.phase) && !wanderOwnerAlive(j),
      failure: j.failure,
    };
  }
  async adopt(intent: WanderIntent) {
    const prior = readWanderJournal();
    if (prior) {
      if (prior.owner !== this.owner) throw Object.assign(new Error('Not found'), { status: 404 });
      for (const [k, v] of Object.entries({
        applicationId: intent.applicationId,
        baselineContainer: intent.expectedContainer,
        baselineImage: intent.expectedImage,
        baselineRuntimeSettings: intent.expectedRuntimeSettings,
        baselineSource: intent.expectedSource,
        baselineParent: intent.expectedParent,
        sourceCommit: intent.sourceCommit,
        sourceDigest: intent.sourceDigest,
        sourceArchiveDigest: intent.sourceArchiveDigest,
        requestKey: intent.requestKey,
        specDigest: intent.specDigest,
      }))
        if ((prior as unknown as Record<string, unknown>)[k] !== v)
          error('Adoption intent conflicts with durable reservation');
      return this.receipt(prior);
    }
    if (ciMutationActive('wander') || ciMutationActive(intent.applicationId))
      error('Application mutation in progress');
    const j = this.adapter.reserve(intent, this.owner);
    return this.execute(j);
  }
  async recover(id: string, cancel = false) {
    const j = readWanderJournal();
    if (!j || j.id !== id || j.owner !== this.owner)
      throw Object.assign(new Error('Not found'), { status: 404 });
    if (wanderOwnerAlive(j)) error('Live process owns adoption; wait for completion');
    if (j.phase === 'cancelled') return this.receipt(j);
    // Claim before stopping helpers or restarting any writer. The adapter serializes
    // this with normal mutation admission in the shared SQLite transaction.
    const claimed = this.adapter.claim(j);
    if (!cancel) return this.execute(claimed, true);
    return withCiMutation(claimed.id, async () => {
      try {
        await this.adapter.acquire(claimed);
        if (
          ['starting', 'publishing', 'committed'].includes(claimed.phase) ||
          claimed.candidateContainer
        )
          error('Candidate may have written managed data; automatic rollback is forbidden');
        await this.adapter.fenceHelpers(claimed);
        await this.adapter.checkBaseline(claimed, false);
        await this.adapter.resumeOriginal(claimed);
        claimed.failure = null;
        this.phase(claimed, 'cancelled');
        return this.receipt(claimed);
      } finally {
        this.adapter.release(claimed);
      }
    });
  }

  private phase(j: WanderJournal, phase: WanderJournal['phase']) {
    j.phase = phase;
    j.updatedAt = Date.now();
    writeWanderJournal(j);
  }
  private async execute(j: WanderJournal, alreadyClaimed = false) {
    if (!alreadyClaimed) j = this.adapter.claim(j);
    j.failure = null;
    writeWanderJournal(j);
    return withCiMutation(j.id, async () => {
      try {
        await this.adapter.acquire(j);
        await this.adapter.fenceHelpers(j);
        if (j.phase === 'committed') {
          await this.adapter.verifyCandidate(j);
          return this.receipt(j);
        }
        if (!j.image) {
          await this.adapter.checkBaseline(j, false);
          this.phase(j, 'building');
          j.image = await this.adapter.build(j);
          this.phase(j, 'built');
        }
        if (!['starting', 'publishing'].includes(j.phase)) {
          this.phase(j, 'stopping');
          await this.adapter.stopLegacy(j);
          await this.adapter.checkBaseline(j, true);
          this.phase(j, 'stopped');
          if (!j.snapshot) {
            j.snapshot = await this.adapter.snapshot(j);
            this.phase(j, 'snapshot');
          }
          for (const resource of ['data', 'uploads'] as const) {
            if (!j.providers[resource]?.seeded) {
              this.phase(j, 'seeding');
              await this.adapter.seed(j, resource);
              j.providers[resource].seeded = true;
              writeWanderJournal(j);
            }
          }
          await this.adapter.verifySeed(j);
          this.phase(j, 'seeded');
          this.phase(j, 'starting');
        }
        await this.adapter.checkBaseline(j, true);
        j.candidateContainer = await this.adapter.activate(j);
        writeWanderJournal(j);
        await this.adapter.verifyCandidate(j);
        this.phase(j, 'publishing');
        await this.adapter.commit(j);
        this.phase(j, 'committed');
        return this.receipt(j);
      } catch (e) {
        j.failure = 'Adoption interrupted; inspect owner logs and use explicit recovery';
        writeWanderJournal(j);
        throw e;
      } finally {
        this.adapter.release(j);
      }
    });
  }
}
export function newWanderJournal(
  intent: WanderIntent,
  owner: string,
  baselineDeployment: Record<string, unknown>,
  baselineFingerprint: string,
  rootIdentity: string,
): WanderJournal {
  return {
    version: 1,
    id: randomUUID(),
    application: 'wander',
    applicationId: intent.applicationId,
    owner,
    requestKey: intent.requestKey,
    phase: 'reserved',
    activePid: null,
    activeThread: null,
    failure: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sourceCommit: intent.sourceCommit,
    sourceDigest: intent.sourceDigest,
    sourceArchiveDigest: intent.sourceArchiveDigest,
    specDigest: intent.specDigest,
    sourceDirectory: intent.sourceDirectory,
    baselineFingerprint,
    baselineRuntimeSettings: intent.expectedRuntimeSettings,
    baselineContainer: intent.expectedContainer,
    baselineImage: intent.expectedImage,
    baselineSource: intent.expectedSource,
    baselineParent: intent.expectedParent,
    baselineDeployment,
    rootIdentity,
    image: null,
    snapshot: null,
    providers: {},
    candidateContainer: null,
    candidateName: null,
    helper: null,
  };
}
