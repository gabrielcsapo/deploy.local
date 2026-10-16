import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeVoiceWav } from './voice-audio.ts';

test('voice WAV has valid mono PCM headers and clips samples without integer overflow', () => {
  const encoded = encodeVoiceWav(new Float32Array([-2, -1, 0, 1, 2]));
  const bytes = Buffer.from(encoded);
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.readUInt32LE(4), encoded.byteLength - 8);
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  assert.equal(bytes.readUInt16LE(20), 1);
  assert.equal(bytes.readUInt16LE(22), 1);
  assert.equal(bytes.readUInt32LE(24), 16000);
  assert.equal(bytes.readUInt32LE(28), 32000);
  assert.equal(bytes.readUInt16LE(34), 16);
  assert.equal(bytes.readUInt32LE(40), 10);
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((i) => bytes.readInt16LE(44 + 2 * i)),
    [-32768, -32768, 0, 32767, 32767],
  );
});
