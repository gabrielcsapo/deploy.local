import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'node-ports-test-'));
process.env.DEPLOY_DATA_DIR = root;
const {
  saveDeployment,
  updateDeploymentStatus,
  getDeployment,
  createNodeEnrollment,
  redeemNodeEnrollment,
  reconcileNodeRuntimePorts,
  _resetDb,
} = await import('../store.ts');

after(() => {
  _resetDb();
  rmSync(root, { recursive: true, force: true });
});

const node = redeemNodeEnrollment({ code: createNodeEnrollment('imac', 'gabriel').code });

function remoteApp(name: string, port: number, container: string, status = 'running') {
  saveDeployment({
    name,
    username: 'gabriel',
    type: 'application-graph',
    activeNodeId: node.nodeId,
    port,
    containerName: container,
  });
  updateDeploymentStatus(name, status);
}

test('an exited container never becomes the app address', () => {
  remoteApp('shelf', 50000, 'deploy-sh-shelf-new');
  reconcileNodeRuntimePorts(node.nodeId!, [
    {
      name: 'shelf',
      relayPort: 64500,
      id: 'old',
      containerName: 'deploy-sh-shelf-old',
      status: 'exited',
    },
  ]);
  const shelf = getDeployment('shelf')!;
  assert.equal(shelf.port, 50000);
  assert.equal(shelf.containerName, 'deploy-sh-shelf-new');
});

test('a running container updates the recorded port and container', () => {
  remoteApp('reader', 50001, 'deploy-sh-reader-old');
  reconcileNodeRuntimePorts(node.nodeId!, [
    {
      name: 'reader',
      relayPort: 50002,
      id: 'new',
      containerName: 'deploy-sh-reader-new',
      status: 'running',
    },
  ]);
  const reader = getDeployment('reader')!;
  assert.equal(reader.port, 50002);
  assert.equal(reader.containerName, 'deploy-sh-reader-new');
  assert.equal(reader.status, 'running');
});

test('a running container on the recorded port restores an unknown status', () => {
  remoteApp('album', 50003, 'deploy-sh-album-1', 'unknown');
  reconcileNodeRuntimePorts(node.nodeId!, [
    {
      name: 'album',
      relayPort: 50003,
      id: 'one',
      containerName: 'deploy-sh-album-1',
      status: 'running',
    },
  ]);
  assert.equal(getDeployment('album')!.status, 'running');
});

test('a stopped app keeps its status when the agent reports it exited', () => {
  remoteApp('stopped', 50004, 'deploy-sh-stopped-1', 'stopped');
  reconcileNodeRuntimePorts(node.nodeId!, [
    {
      name: 'stopped',
      relayPort: 50004,
      id: 'one',
      containerName: 'deploy-sh-stopped-1',
      status: 'exited',
    },
  ]);
  assert.equal(getDeployment('stopped')!.status, 'stopped');
});
