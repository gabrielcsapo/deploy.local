import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import type { Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import {
  desktopAction,
  desktopRequest,
  desktopSocketPath,
  linuxDesktopTarget,
} from './linux-desktop.ts';
import { configureMacDesktopHelper } from './mac-desktop.ts';
import { InteractiveRunner } from './interactive-runtime.ts';

test('Linux inventory discovers same-user runtime socket without session environment', () => {
  assert.equal(desktopSocketPath({}, 1000), '/run/user/1000/deploy-desktop.sock');
  assert.equal(
    desktopSocketPath({ XDG_RUNTIME_DIR: '/runtime' }, 1000),
    '/runtime/deploy-desktop.sock',
  );
});

test('Linux helper inventory: absent, Wayland, X11, and missing GStreamer', async () => {
  const missing = await linuxDesktopTarget(
    async () => {
      throw new Error('ENOENT');
    },
    '/runtime/sock',
    'SER',
  );
  assert.equal(missing.available, false);
  assert.match(missing.reason, /deploy desktop-helper install/);
  for (const sessionType of ['wayland', 'x11']) {
    const target = await linuxDesktopTarget(
      async () => ({
        available: true,
        reason: 'Approve screen sharing on SER’s screen once',
        sessionType,
        grantStored: false,
      }),
      '/runtime/sock',
      'SER',
    );
    assert.equal(target.id, 'desktop');
    assert.equal(target.kind, 'computer');
    assert.equal(target.label, 'SER desktop');
    assert.equal(target.viewOnly, true);
    assert.equal(target.desktopStatus.sessionType, sessionType);
  }
  const target = await linuxDesktopTarget(async () => ({
    available: false,
    reason: 'Missing GStreamer elements: pipewiresrc. Install: sudo dnf install pipewire-gstreamer',
  }));
  assert.equal(target.available, false);
  assert.match(target.reason, /dnf install/);
});

test('only an available helper that reports inputAllowed drops viewOnly', async () => {
  const status = (extra: any) => async () => ({ available: true, reason: 'ready', ...extra });
  const allowed = await linuxDesktopTarget(status({ inputAllowed: true }), '/sock', 'SER');
  assert.equal(allowed.viewOnly, false);
  assert.equal(allowed.desktopStatus.inputAllowed, true);
  for (const extra of [{}, { inputAllowed: 'yes' }, { inputAllowed: true, available: false }]) {
    const target = await linuxDesktopTarget(status(extra), '/sock', 'SER');
    assert.equal(target.viewOnly, true);
    assert.equal(target.desktopStatus.inputAllowed, false);
  }
});

test('desktop actions keep only the fields the helper accepts', () => {
  assert.deepEqual(
    desktopAction({
      type: 'click',
      x: 1,
      y: 2,
      targetId: 'desktop',
      expectedBounds: { x: 0, y: 0, width: 1280, height: 720 },
      selector: '#x',
    }),
    { type: 'click', x: 1, y: 2, expectedBounds: { x: 0, y: 0, width: 1280, height: 720 } },
  );
  assert.deepEqual(desktopAction({ type: 'text', text: 'hi', expectedBounds: undefined }), {
    type: 'text',
    text: 'hi',
  });
  assert.deepEqual(desktopAction({ type: 'press', key: 'Enter' }), { type: 'press', key: 'Enter' });
  assert.throws(() => desktopAction({ type: 'navigate', url: 'https://x' }), /inspect, click/);
});

test('socket client handles replies, errors, malformed JSON, and truncated responses', async () => {
  let reply = '{"available":true,"reason":"ready"}\n';
  const open = () => {
    const socket = Object.assign(new EventEmitter(), {
      destroy() {},
      write(data: string) {
        assert.deepEqual(JSON.parse(data), { type: 'status' });
        queueMicrotask(() => {
          socket.emit('data', Buffer.from(reply));
          socket.emit('end');
        });
      },
    });
    queueMicrotask(() => socket.emit('connect'));
    return socket as unknown as Socket;
  };
  assert.equal((await desktopRequest('status', '/mock.sock', open)).available, true);
  for (const [value, error] of [
    ['{"error":"denied"}\n', /denied/],
    ['oops\n', /JSON/],
    ['{', /disconnected/],
  ]) {
    reply = value as string;
    await assert.rejects(desktopRequest('status', '/mock.sock', open), error as RegExp);
  }
});

test('runner advertises a view-only Linux desktop and refuses input even if coordinator queues it', async () => {
  let polls = 0;
  const completions: any[] = [];
  const captures: string[] = [];
  const runner = new InteractiveRunner(
    async (action, body) => {
      if (action === 'poll') {
        assert.equal(body.targets.find((t: any) => t.id === 'desktop').viewOnly, true);
        polls++;
        return {
          sessions: [{ id: 'session', generation: 'g', kind: 'computer', targetId: 'desktop' }],
          commands: [
            {
              id: String(polls),
              sessionId: 'session',
              generation: 'g',
              args: { type: polls === 1 ? 'inspect' : 'click', x: 1, y: 1 },
            },
          ],
        };
      }
      if (action === 'claim') return { status: 'running' };
      if (action === 'complete') completions.push(body);
      return {};
    },
    {
      platform: 'linux',
      linuxDesktopRequest: async (request) => {
        const type = typeof request === 'string' ? request : request.type;
        if (type === 'status') return { available: true, reason: 'ready', sessionType: 'wayland' };
        captures.push(type);
        return { text: 'The desktop is locked or idle', screenState: 'locked-or-idle' };
      },
    },
  );
  try {
    await runner.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(completions[0].snapshot.screenState, 'locked-or-idle');
    await runner.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(completions[1].error, /view-only/);
    assert.deepEqual(captures, ['inspect']);
  } finally {
    await runner.shutdown();
  }
});

test('runner forwards input to an input-allowed Linux desktop with the last bounds', async () => {
  let polls = 0;
  const completions: any[] = [];
  const sent: any[] = [];
  const actions = [
    { type: 'inspect' },
    { type: 'click', x: 640, y: 360, selector: 'ignored' },
    { type: 'text', text: 'hello' },
  ];
  const runner = new InteractiveRunner(
    async (action, body) => {
      if (action === 'poll') {
        const desktop = body.targets.find((t: any) => t.id === 'desktop');
        assert.equal(desktop.viewOnly, false);
        assert.equal(desktop.desktopStatus.inputAllowed, true);
        const args = actions[polls++];
        return {
          sessions: [{ id: 'session', generation: 'g', kind: 'computer', targetId: 'desktop' }],
          commands: args
            ? [{ id: String(polls), sessionId: 'session', generation: 'g', args }]
            : [],
        };
      }
      if (action === 'claim') return { status: 'running' };
      if (action === 'complete') completions.push(body);
      return {};
    },
    {
      platform: 'linux',
      linuxDesktopRequest: async (request) => {
        if (request === 'status')
          return { available: true, reason: 'Input is allowed', inputAllowed: true };
        sent.push(request);
        return {
          image: 'jpeg',
          mimeType: 'image/jpeg',
          text: 'Desktop screenshot',
          inputBounds: { x: 0, y: 0, width: 1280, height: 720 },
        };
      },
    },
  );
  try {
    for (let index = 0; index < actions.length; index++) {
      await runner.tick();
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(sent, [
      { type: 'inspect' },
      { type: 'click', x: 640, y: 360, expectedBounds: { x: 0, y: 0, width: 1280, height: 720 } },
      { type: 'text', text: 'hello', expectedBounds: { x: 0, y: 0, width: 1280, height: 720 } },
    ]);
    assert.equal(completions.length, 3);
    assert.ok(completions.every((completion) => completion.snapshot && !completion.error));
  } finally {
    await runner.shutdown();
  }
});

test('macOS remote workers discover the app helper and preserve explicit configuration', () => {
  const env: NodeJS.ProcessEnv = {};
  configureMacDesktopHelper(
    env,
    'darwin',
    (path) => path === '/Applications/Deploy.app/Contents/Helpers/deploy-control-helper',
    '/home',
  );
  assert.equal(
    env.DEPLOY_DESKTOP_HELPER,
    '/Applications/Deploy.app/Contents/Helpers/deploy-control-helper',
  );
  configureMacDesktopHelper(env, 'darwin', () => true, '/different');
  assert.equal(
    env.DEPLOY_DESKTOP_HELPER,
    '/Applications/Deploy.app/Contents/Helpers/deploy-control-helper',
  );
  const linux: NodeJS.ProcessEnv = {};
  configureMacDesktopHelper(linux, 'linux', () => true);
  assert.deepEqual(linux, {});
});

test('Python helper protocol and mocked portal tests (no desktop interaction)', () => {
  const output = execFileSync('python3', [resolve('native/Linux/test_desktop_helper.py')], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.match(output, /helper tests passed/);
});
