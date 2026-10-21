import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

for (const malformed of [true, false]) {
  test(`compatible adapter stops repeated ${malformed ? 'invalid JSON' : 'failed calls'} and preserves tool results`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-tool-failure-'));
    const sessionFile = join(dir, 'session.json');
    writeFileSync(
      sessionFile,
      JSON.stringify({
        id: 'resumed',
        agentContext: 'Old coordinator snapshot',
        messages: [
          { role: 'system', content: 'Old coordinator snapshot' },
          {
            role: 'system',
            content:
              'You are a coding agent working in an isolated task checkout. Browser/computer tools and user permission prompts are unavailable.',
          },
        ],
      }),
    );
    let requests = 0;
    const provider = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const input = JSON.parse(body);
      assert.equal(input.messages[0].content, 'Current coordinator snapshot');
      assert.ok(
        !input.messages.some((message: any) => message.content === 'Old coordinator snapshot'),
      );
      assert.equal(
        input.messages.findLast((message: any) => message.role === 'user').content,
        'Read missing.txt',
      );
      assert.match(input.messages[1].content, /explicitly granted task session/);
      assert.doesNotMatch(input.messages[1].content, /Browser\/computer tools.*unavailable/);
      requests++;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: `failure-${requests}`,
                    type: 'function',
                    function: {
                      name: 'read_file',
                      arguments: malformed ? '{broken' : JSON.stringify({ path: 'missing.txt' }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      );
    });
    await new Promise<void>((done) => provider.listen(0, '127.0.0.1', done));
    try {
      const child = spawn(process.execPath, [resolve('server/workspace/compatible-agent.ts')], {
        cwd: dir,
        env: {
          ...process.env,
          DEPLOY_MODEL_BASE_URL: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
          DEPLOY_MODEL_NAME: 'fixture',
          DEPLOY_MODEL_BILLING_MODE: 'local',
          DEPLOY_MODEL_SESSION_FILE: sessionFile,
          DEPLOY_AGENT_INSTRUCTIONS: 'Current coordinator snapshot',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      child.stderr.resume();
      child.stdin.end('Read missing.txt');
      const code = await new Promise<number | null>((done) => child.on('close', done));
      assert.equal(code, 1);
      assert.equal(requests, 3);
      assert.match(output, /turn.failed/);
      assert.match(output, /3 consecutive tool failures/);
      const messages = JSON.parse(readFileSync(sessionFile, 'utf8')).messages;
      const results = messages.filter((m: any) => m.role === 'tool');
      assert.equal(results.length, 3);
      assert.ok(results.every((m: any) => m.content.startsWith('Tool error:')));
    } finally {
      provider.closeAllConnections();
      await new Promise<void>((done) => provider.close(() => done()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const refusesCleanup of [false, true])
  test(`approval continuation ${refusesCleanup ? 'fails boundedly when cleanup is ignored' : 'completes cleanup without another user message'}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-approval-turn-'));
    let modelCalls = 0,
      polls = 0;
    const actions: string[] = [];
    const session = {
      id: 'session',
      generation: 'generation',
      status: 'active',
      controlOwner: 'agent',
    };
    const request = { id: 'request', status: 'pending', expiresAt: Date.now() + 60000 };
    const coordinator = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { args } = JSON.parse(body);
      actions.push(args.action);
      let value: any;
      if (args.action === 'request') value = request;
      if (args.action === 'list')
        value = {
          requests: [
            ++polls === 1 ? request : { ...request, status: 'approved', sessionId: session.id },
          ],
          sessions: [session],
        };
      if (args.action === 'read')
        value = {
          session,
          snapshot: { text: 'Window content' },
          commands: [{ id: 'command', status: 'succeeded' }],
        };
      if (args.action === 'input') value = { id: 'command', status: 'queued' };
      if (args.action === 'stop') {
        session.status = 'stopped';
        value = session;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(value));
    });
    const provider = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const input = JSON.parse(body);
      assert.equal(input.messages.filter((m: any) => m.role === 'user').length, 1);
      const calls = [
        {
          name: 'deploy_control_request',
          arguments: JSON.stringify({
            workerId: 'local',
            targetId: 'window',
            operationId: 'request-op',
          }),
        },
        {
          name: 'deploy_control_input',
          arguments: JSON.stringify({
            sessionId: session.id,
            generation: session.generation,
            operationId: 'inspect-op',
            input: { type: 'inspect' },
          }),
        },
        undefined, // Deliberate premature final; harness must request cleanup without a user message.
        {
          name: 'deploy_control_stop',
          arguments: JSON.stringify({
            sessionId: session.id,
            generation: session.generation,
            operationId: 'stop-op',
          }),
        },
      ];
      if (modelCalls === 1)
        assert.equal(JSON.parse(input.messages.at(-1).content).request.status, 'approved');
      if (modelCalls === 2)
        assert.equal(JSON.parse(input.messages.at(-1).content).command.status, 'succeeded');
      if (modelCalls === 3) assert.match(input.messages.at(-1).content, /Completion check/);
      const call =
        refusesCleanup && modelCalls >= 2 ? (modelCalls++, undefined) : calls[modelCalls++];
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          choices: [
            {
              message: call
                ? {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{ id: 'call-' + modelCalls, type: 'function', function: call }],
                  }
                : { role: 'assistant', content: 'Inspected and stopped.' },
            },
          ],
        }),
      );
    });
    await Promise.all(
      [coordinator, provider].map(
        (server) => new Promise<void>((done) => server.listen(0, '127.0.0.1', done)),
      ),
    );
    try {
      const child = spawn(process.execPath, [resolve('server/workspace/compatible-agent.ts')], {
        cwd: dir,
        env: {
          ...process.env,
          DEPLOY_MODEL_BASE_URL: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
          DEPLOY_MODEL_NAME: 'fixture',
          DEPLOY_MODEL_BILLING_MODE: 'local',
          DEPLOY_MODEL_SESSION_FILE: join(dir, 'session.json'),
          DEPLOY_AGENT_URL: `http://127.0.0.1:${(coordinator.address() as any).port}`,
          DEPLOY_AGENT_TOKEN: 'fixture',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdout.resume();
      child.stderr.resume();
      child.stdin.end('Inspect the window and stop.');
      assert.equal(await new Promise((done) => child.on('close', done)), refusesCleanup ? 1 : 0);
      assert.equal(modelCalls, 5);
      assert.deepEqual(actions, [
        'request',
        'list',
        'list',
        'read',
        'input',
        'read',
        'list',
        refusesCleanup ? 'list' : 'stop',
        'list',
      ]);
    } finally {
      await Promise.all(
        [coordinator, provider].map((server) => {
          server.closeAllConnections();
          return new Promise<void>((done) => server.close(() => done()));
        }),
      );
      rmSync(dir, { recursive: true, force: true });
    }
  });

test('compatible adapter refreshes coordinator system instructions without changing user text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-system-message-'));
  const sessionFile = join(dir, 'session.json');
  const captureFile = join(dir, 'request.json');
  const fixture = join(dir, 'provider.mjs');
  writeFileSync(
    fixture,
    `import { writeFileSync } from 'node:fs';
globalThis.fetch = async (_url, options) => {
  writeFileSync(process.env.CAPTURE_REQUEST, options.body);
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Done' } }] }), { headers: { 'content-type': 'application/json' } });
};`,
  );
  try {
    for (const context of ['First snapshot', 'Fresh follow-up snapshot']) {
      const child = spawn(
        process.execPath,
        ['--import', fixture, resolve('server/workspace/compatible-agent.ts')],
        {
          cwd: dir,
          env: {
            ...process.env,
            DEPLOY_MODEL_BASE_URL: 'https://provider.invalid/v1',
            DEPLOY_MODEL_NAME: 'fixture',
            DEPLOY_MODEL_BILLING_MODE: 'local',
            DEPLOY_MODEL_SESSION_FILE: sessionFile,
            DEPLOY_AGENT_INSTRUCTIONS: context,
            CAPTURE_REQUEST: captureFile,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      let error = '';
      child.stdout.resume();
      child.stderr.on('data', (chunk) => {
        error += chunk;
      });
      child.stdin.end('The user’s exact words\n');
      const code = await new Promise<number | null>((done) => child.on('close', done));
      assert.equal(code, 0, error);
      const request = JSON.parse(readFileSync(captureFile, 'utf8'));
      assert.deepEqual(request.messages[0], { role: 'system', content: context });
      assert.equal(
        request.messages.findLast((message: any) => message.role === 'user').content,
        'The user’s exact words\n',
      );
      assert.equal(
        request.messages.filter(
          (message: any) =>
            message.role === 'system' &&
            ['First snapshot', 'Fresh follow-up snapshot'].includes(message.content),
        ).length,
        1,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
