import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
test('durable reservation survives separate controller processes and blocks shared SQL mutations by name/appID', () => {
  const root = mkdtempSync(join(tmpdir(), 'wander-restart-'));
  const file = join(root, 'driver.mjs');
  const url = (name: string) => new URL('./' + name, import.meta.url).href;
  writeFileSync(
    file,
    `import assert from 'node:assert/strict';import * as store from ${JSON.stringify(url('store.ts'))};import {withApplicationMutation,withCiMutation} from ${JSON.stringify(url('ci-fence.ts'))};import {newWanderJournal} from ${JSON.stringify(url('wander-adoption.ts'))};import {readWanderJournal,writeWanderJournal,releaseWanderWorker,WANDER_MANAGED_DIGEST} from ${JSON.stringify(url('wander-adoption-fence.ts'))};import {registerApplicationIdentity} from ${JSON.stringify(url('local-site.ts'))};
if(process.argv[2]==='reserve'){store.registerUser('fixture-owner','synthetic-only-password');store.saveDeployment({name:'wander',username:'fixture-owner'});const appId=registerApplicationIdentity('wander');const j=newWanderJournal({applicationId:appId,expectedContainer:'fixture-original',expectedImage:'fixture-image',expectedRuntimeSettings:'fixture-settings',expectedSource:'fixture-source',expectedParent:'fixture-parent',sourceCommit:'a'.repeat(40),sourceDigest:'fixture-source-new',sourceArchiveDigest:'fixture-archive',requestKey:'fixture',specDigest:WANDER_MANAGED_DIGEST,sourceDirectory:'/tmp/fixture'},'fixture-owner',{},'fixture-baseline','fixture-root');j.activePid=process.pid;j.activeThread=9;writeWanderJournal(j,true);releaseWanderWorker(process.pid,8);assert.equal(readWanderJournal().activePid,process.pid);releaseWanderWorker(process.pid,9);assert.equal(readWanderJournal().activePid,null);}else{const j=readWanderJournal();assert.equal(j.phase,'reserved');for(const key of ['wander',j.applicationId])await assert.rejects(()=>withApplicationMutation(key,async()=>store.updateDeploymentStatus('wander','stopped')),{status:409});withCiMutation(j.id,()=>store.updateDeploymentStatus('wander','running'));assert.equal(store.getDeployment('wander').status,'running');}store._resetDb();console.log('verified');process.exit(0);`,
  );
  const env = { ...process.env, DEPLOY_DATA_DIR: root };
  try {
    for (const mode of ['reserve', 'restart'])
      assert.match(
        execFileSync(process.execPath, [file, mode], { env, encoding: 'utf8' }),
        /verified/,
      );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
