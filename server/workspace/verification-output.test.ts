import test from 'node:test';
import assert from 'node:assert/strict';
import { verificationRun } from './workspace-verification.ts';
import { verificationOutcome, verificationResult } from './verification-output.ts';

/** The two forms Claude agents run tests in, from task 807f8ec3 (pull request #13). */
const testRun =
  'cd "/Users/worker/task" && node --import tsx --test app/routes/dashboard/*.test.ts 2>&1 | tail -60';
const typeRun =
  'cd "/Users/worker/task" && pnpm typecheck 2>&1 | tail -20 && echo "=== LINT ===" && pnpm lint 2>&1 | tail -20';

/** Real tails, with the pass/fail summary each tool prints where `tail` keeps it. */
const testsPassed = `✔ queued runs render their waiting reason (0.52ms)
ℹ tests 209
ℹ suites 0
ℹ pass 209
ℹ fail 0
ℹ cancelled 0
ℹ duration_ms 1835.2`;
const testsFailed = testsPassed.replace('ℹ pass 209', 'ℹ pass 206').replace('fail 0', 'fail 3');
const typesPassed = `$ tsc --noEmit
=== LINT ===
server/workspace/interactive.ts:413:15: warning eslint(no-shadow): 'request' is already declared.
Design literals: no local pixel type sizes or literal colors.`;
const typesFailed = `$ tsc --noEmit
server/workspace/activity.ts(21,7): error TS2345: Argument of type 'string' is not assignable.
 ELIFECYCLE  Command failed with exit code 2.`;
const lintFailed = `$ tsc --noEmit
=== LINT ===
server/workspace/activity.ts:21:7: error eslint(no-debugger): \`debugger\` statement is not allowed`;

/** A Claude tool result: no exit code, the output as content blocks, and an error flag. */
const claude = (output: string, isError = false) => ({
  type: 'tool_result',
  name: 'Bash',
  output: [{ type: 'text', text: output }],
  isError,
});
const codex = (output: string, exit: number) => ({
  type: 'command_execution',
  aggregated_output: output,
  exit_code: exit,
});
const result = (command: string, item: Record<string, any>) => {
  const run = verificationRun(command);
  assert.ok(run, command);
  return verificationResult(run, item);
};

test('a piped test run is read from its output summary, whatever the pipeline exited with', () => {
  const run = verificationRun(testRun);
  assert.deepEqual(run, { piped: true, trustedExitCode: false, silentOnSuccess: false });
  // `tail` exits 0 either way: the summary is the only honest source of the result.
  const passed = result(testRun, claude(testsPassed));
  assert.equal(passed?.status, 'succeeded');
  assert.match(passed!.evidence, /ℹ fail 0/);
  assert.equal(result(testRun, claude(testsFailed))?.status, 'failed');
  assert.equal(result(testRun, codex(testsFailed, 0))?.status, 'failed');
  assert.match(result(testRun, codex(testsFailed, 0))!.evidence, /ℹ fail 3/);
  assert.equal(result(testRun, codex(testsPassed, 0))?.status, 'succeeded');
});

test('a piped type check and lint read as passed only when no diagnostic was printed', () => {
  const run = verificationRun(typeRun);
  assert.deepEqual(run, { piped: true, trustedExitCode: false, silentOnSuccess: true });
  // tsc and oxlint print only diagnostics, so a tail with none in it is their pass.
  assert.equal(result(typeRun, claude(typesPassed))?.status, 'succeeded');
  assert.equal(result(typeRun, codex(typesPassed, 0))?.status, 'succeeded');
  const failed = result(typeRun, claude(typesFailed));
  assert.equal(failed?.status, 'failed');
  assert.match(failed!.evidence, /error TS2345/);
  assert.equal(result(typeRun, claude(lintFailed))?.status, 'failed');
  assert.match(result(typeRun, claude(lintFailed))!.evidence, /no-debugger/);
  // A silent tool that printed nothing never ran: the shell says the command failed.
  assert.equal(result(typeRun, claude('', true))?.status, 'unknown');
  assert.equal(result(typeRun, codex('', 1))?.status, 'unknown');
});

test('inconclusive piped output is unknown, and never outranks a reported failure', () => {
  const logged = 'Running 209 tests across 12 files…\nStill working on the dashboard suite';
  assert.equal(result(testRun, claude(logged))?.status, 'unknown');
  assert.equal(result(testRun, claude(logged))?.evidence, '');
  assert.equal(result(testRun, codex(logged, 0))?.status, 'unknown');
  // The summary says the tests passed, but the shell reported the command failed: a later
  // stage of the chain went wrong, so this version claims neither result.
  assert.equal(result(testRun, claude(testsPassed, true))?.status, 'unknown');
  assert.equal(result(testRun, codex(testsPassed, 1))?.status, 'unknown');
  // A command that reported nothing at all is not a result.
  assert.equal(result(testRun, { type: 'tool_result' }), null);
});

test('pipefail makes the exit code the result again, without reading the output', () => {
  const piped = `set -o pipefail && ${testRun}`;
  assert.deepEqual(verificationRun(piped), {
    piped: true,
    trustedExitCode: true,
    silentOnSuccess: false,
  });
  assert.deepEqual(result(piped, claude('whatever was printed')), {
    status: 'succeeded',
    evidence: '',
  });
  assert.equal(result(piped, claude('whatever was printed', true))?.status, 'failed');
  assert.equal(result(piped, codex(testsPassed, 1))?.status, 'failed');
  assert.deepEqual(verificationRun('set -euo pipefail && pnpm test 2>&1 | tail -n 40'), {
    piped: true,
    trustedExitCode: true,
    silentOnSuccess: false,
  });
});

test('an unpiped command keeps its own exit code, including an agent error flag', () => {
  assert.deepEqual(verificationRun('cd native && swift test'), {
    piped: false,
    trustedExitCode: true,
    silentOnSuccess: false,
  });
  assert.equal(result('pnpm test', codex('', 0))?.status, 'succeeded');
  assert.equal(result('pnpm test', codex('', 2))?.status, 'failed');
  assert.equal(result('pnpm test', claude(testsPassed))?.status, 'succeeded');
  assert.equal(result('pnpm test', claude(testsPassed, true))?.status, 'failed');
});

test('only a bounded trailing tail is accepted; other pipes, writes and reads stay rejected', () => {
  for (const command of [
    'pnpm test 2>&1 | tail -60',
    'pnpm test 2>&1 | tail -n 60',
    'pnpm test 2>&1 | head -20',
    'pnpm test | tail',
    'cd app && npx oxfmt --check a.ts 2>&1 | tail -5',
  ])
    assert.ok(verificationRun(command), command);
  for (const command of [
    'pnpm test 2>&1 | grep fail',
    'pnpm test 2>&1 | tee out.log',
    'pnpm test > out.log',
    'pnpm test 2>&1 | tail -60 > out.log',
    'pnpm test 2>&1 | tail -60 | wc -l',
    'pnpm test 2>&1 | tail -60 | head -5',
    'pnpm test 2>&1 | tail -60 && touch source.ts',
    'pnpm test 2>&1 | tail -60 & echo done',
    'pnpm test 2>&1 | sort | tail -60',
    'cat out.log | tail -60',
    'echo "=== LINT ===" && echo done',
    'pnpm test 1>out.log 2>&1',
  ])
    assert.equal(verificationRun(command), null, command);
});

test('each tool contributes the summary it prints, and a failure anywhere decides', () => {
  const cases: [string, 'succeeded' | 'failed'][] = [
    [
      'Test Suite passed\nExecuted 99 tests, with 0 failures (0 unexpected) in 1.2 seconds',
      'succeeded',
    ],
    ['Executed 99 tests, with 2 failures (0 unexpected) in 1.2 seconds', 'failed'],
    ['✔ Test run with 99 tests in 12 suites passed after 1.201 seconds.', 'succeeded'],
    ['✘ Test run with 99 tests in 12 suites failed after 1.201 seconds.', 'failed'],
    ['** TEST SUCCEEDED **', 'succeeded'],
    ['** BUILD FAILED **', 'failed'],
    ['test result: ok. 42 passed; 0 failed; 0 ignored', 'succeeded'],
    ['test result: FAILED. 40 passed; 2 failed; 0 ignored', 'failed'],
    ['error[E0308]: mismatched types', 'failed'],
    ['ok  	deploy.local/server	0.312s', 'succeeded'],
    ['--- FAIL: TestRoutes (0.00s)\nFAIL	deploy.local/server	0.312s', 'failed'],
    ['=========== 209 passed in 3.41s ============', 'succeeded'],
    ['=========== 3 failed, 206 passed in 3.41s ============', 'failed'],
    ['Checking formatting...\nAll matched files use the correct format.', 'succeeded'],
    ['Format issues found in above 1 files. Run without `--check` to fix.', 'failed'],
    ['All matched files use Prettier code style!', 'succeeded'],
    ['Code style issues found in the above file(s). Run Prettier to fix.', 'failed'],
    ['Found 0 warnings and 0 errors.', 'succeeded'],
    ['Found 12 warnings and 1 error.', 'failed'],
    ['✖ 3 problems (0 errors, 3 warnings)', 'succeeded'],
    ['✖ 3 problems (1 error, 2 warnings)', 'failed'],
    ['# tests 209\n# pass 209\n# fail 0', 'succeeded'],
    ['# tests 209\n# pass 206\n# fail 3', 'failed'],
  ];
  for (const [output, status] of cases)
    assert.equal(verificationOutcome(output).status, status, output);
  // One tool passing does not answer for another that failed in the same command.
  assert.equal(verificationOutcome(`${testsPassed}\n** BUILD FAILED **`).status, 'failed');
  assert.equal(verificationOutcome('nothing conclusive here').status, 'unknown');
  assert.equal(verificationOutcome('', true).status, 'unknown');
});
