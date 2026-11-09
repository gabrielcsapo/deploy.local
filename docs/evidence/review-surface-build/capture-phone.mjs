// A booted iPhone 13 simulator gives the approved 390 × 844 point viewport.
// Usage: node docs/evidence/review-surface-build/capture-phone.mjs <udid> <Board> [wait-seconds]
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
const [device, board = 'DesignReviewPhone', seconds = '2'] = process.argv.slice(2);
if (!device || !/^DesignReview\w*Phone$/.test(board))
  throw new Error('Pass a simulator UDID and review phone board.');
const sim = (...args) => execFileSync('xcrun', ['simctl', ...args], { stdio: 'inherit' });
await fetch(`http://127.0.0.1:5180/__fixture?state=${board}`, { redirect: 'manual' });
try {
  sim('terminate', device, 'local.deploy.workspace.ios');
} catch {
  /* First launch. */
}
sim(
  'launch',
  device,
  'local.deploy.workspace.ios',
  '--v2-fixture',
  'http://127.0.0.1:5180',
  '--v2-board',
  board,
);
const deadline = Date.now() + 120000;
while (true) {
  const ready = await (await fetch('http://127.0.0.1:5180/__fixture/native-status')).json();
  if (ready?.board === board) {
    if (ready.failed) throw new Error(`${ready.failed} preview loads failed`);
    break;
  }
  if (Date.now() > deadline) throw new Error('Native review did not become ready within 120 s');
  await new Promise((resolve) => setTimeout(resolve, 500));
}
await new Promise((resolve) =>
  setTimeout(resolve, Math.min(45, Math.max(1, Number(seconds))) * 1000),
);
mkdirSync('output/review-surface', { recursive: true });
const path = `output/review-surface/${board}-runtime.png`;
sim('io', device, 'screenshot', path);
execFileSync('sips', ['-Z', '844', path, '--out', `output/review-surface/${board}-390.png`], {
  stdio: 'inherit',
});
