import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const directory = mkdtempSync(join(tmpdir(), 'deploy-media-ports-'));
process.env.DEPLOY_DATA_DIR = directory;
after(() => rmSync(directory, { recursive: true, force: true }));

const ports = await import('./workspace/media-ports.ts');

test('unwired media ports identify the dependency and calling process', () => {
  assert.throws(() => ports.requireScreenshotWorker('unwired screenshot process'), {
    message: 'ScreenshotWorker is not wired in unwired screenshot process',
  });
  assert.throws(() => ports.requireAttachmentBytesSource('unwired attachment process'), {
    message: 'AttachmentBytesSource is not wired in unwired attachment process',
  });
});

test('local wiring supplies the exact product functions and their results', async () => {
  const { wireLocalWorkerMedia } = await import('./main/local-worker-media.ts');
  const { screenshotWorker } = await import('./v2/screenshots.ts');
  const { attachmentBytes, storeAttachment } = await import('./v2/attachments.ts');
  wireLocalWorkerMedia();
  const screenshotPort = ports.requireScreenshotWorker('local worker');
  const attachmentPort = ports.requireAttachmentBytesSource('local worker');
  assert.equal(screenshotPort, screenshotWorker);
  assert.equal(attachmentPort, attachmentBytes);
  assert.deepEqual(
    screenshotPort('media-owner', 'local', 'poll', {}),
    screenshotWorker('media-owner', 'local', 'poll', {}),
  );
  const attachment = storeAttachment(
    'media-owner',
    Buffer.from('port bytes'),
    'text/plain',
    'input.txt',
  );
  assert.deepEqual(
    await attachmentPort('media-owner', attachment.ref),
    await attachmentBytes('media-owner', attachment.ref),
  );
  assert.throws(() => attachmentPort('another-owner', attachment.ref), /Not found/);
});
