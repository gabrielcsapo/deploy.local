import { environmentImages } from './agent-media.ts';
import { readCompletion } from './completion-stream.ts';
import { coordinationTools, callCoordinationTool } from './coordination-tools.ts';
import { shellEnvironment } from './shell-environment.ts';
import { compatibleControlTools, controlCall } from './compatible-control-tools.ts';
// Minimal provider-independent tool loop for explicitly configured compatible endpoints.
// Runs as an isolated worker child, never in a client process.
import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const endpoint = process.env.DEPLOY_MODEL_BASE_URL,
  model = process.env.DEPLOY_MODEL_NAME,
  billing = process.env.DEPLOY_MODEL_BILLING_MODE;
if (!endpoint || !model || !['local', 'api'].includes(billing || ''))
  throw new Error(
    'Compatible inference requires DEPLOY_MODEL_BASE_URL, DEPLOY_MODEL_NAME, DEPLOY_MODEL_BILLING_MODE=local|api',
  );
const sessionFile = process.env.DEPLOY_MODEL_SESSION_FILE;
if (!sessionFile) throw new Error('Worker must supply a durable model session file');
const cwd = realpathSync(process.cwd()),
  emit = (type: string, payload: any) => console.log(JSON.stringify({ type, ...payload }));
function safePath(input: string, writing = false) {
  const path = resolve(cwd, input);
  let parent = writing && !existsSync(path) ? dirname(path) : path;
  while (!existsSync(parent) && parent !== dirname(parent)) parent = dirname(parent);
  const actual = realpathSync(parent),
    rel = relative(cwd, actual);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel))
    throw new Error('Path is outside the task workspace');
  return path;
}
const schemas = [
  ...(process.env.DEPLOY_AGENT_TOKEN
    ? [
        ...compatibleControlTools,
        ...coordinationTools
          .filter(({ name }) => name !== 'deploy_control')
          .map(({ name, description, inputSchema }) => ({
            name,
            description,
            parameters: inputSchema,
          })),
      ]
    : []),
  {
    name: 'read_file',
    description: 'Read a UTF-8 file in the task workspace',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'write_file',
    description: 'Write UTF-8 content to a file in the task workspace',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'search',
    description: 'Search repository text with ripgrep',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'list_files',
    description: 'List nonignored repository files',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'run_command',
    description: 'Run a shell command in the task workspace; limited to 30 seconds',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
];
const openedControlSessions = new Set<string>();
async function tool(name: string, args: any) {
  if (name.startsWith('deploy_')) {
    const control = controlCall(name, args);
    const result = await callCoordinationTool(control ? 'deploy_control' : name, control ?? args);
    if (
      control?.action === 'request' &&
      result?.request?.status === 'approved' &&
      result?.session?.id
    )
      openedControlSessions.add(result.session.id);
    // This adapter is text/tool based. Do not send base64 pixels as model text.
    if (result?.snapshot?.image) {
      delete result.snapshot.image;
      result.snapshot.imageNote =
        'Image is visible in the task Controls panel; this adapter receives structured text only.';
    }
    return JSON.stringify(result);
  }
  if (name === 'read_file') return readFileSync(safePath(args.path), 'utf8').slice(0, 256000);
  if (name === 'write_file') {
    const path = safePath(args.path, true);
    mkdirSync(dirname(path), { recursive: true });
    safePath(path, true);
    writeFileSync(path, String(args.content));
    return 'Written ' + args.path;
  }
  let executable = 'rg',
    argv: string[] = [];
  if (name === 'search') argv = ['-n', '--', String(args.query), '.'];
  else if (name === 'list_files') argv = ['--files', '--hidden', '-g', '!.git'];
  else if (name === 'run_command') {
    executable = '/bin/sh';
    argv = ['-lc', String(args.command)];
  } else throw new Error('Unknown tool');
  const result = spawnSync(executable, argv, {
    cwd,
    env: shellEnvironment(),
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.stringify({
    exitCode: result.status,
    stdout: result.stdout?.slice(0, 64000),
    stderr: result.stderr?.slice(0, 16000),
    error: result.error?.message,
  });
}
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const session = existsSync(sessionFile)
  ? JSON.parse(readFileSync(sessionFile, 'utf8'))
  : {
      id: randomUUID(),
      messages: [
        {
          role: 'system',
          content:
            'You are a coding agent working in an isolated task checkout. Use repository tools to fulfill the user request, preserve existing changes, run appropriate checks, and report your actual results. Use deploy_control_list, deploy_control_read, and deploy_control_input only for an approved task session. Inspect its structured text before acting; never guess coordinates or bypass a denied control session with shell commands. This adapter does not receive screen pixels. If structured evidence is insufficient, explain the limitation. For window access, use deploy_control_targets then deploy_control_request; the app presents approval for that exact target. Requesting never grants permission. Use deploy_ask_user for questions; an answer does not grant computer access. Never publish or push unless the user explicitly requests it.',
        },
      ],
    };
// Refresh the obsolete built-in capability sentence in durable pilot sessions.
for (const message of session.messages) {
  if (
    message.role === 'system' &&
    typeof message.content === 'string' &&
    message.content.startsWith('You are a coding agent working in an isolated task checkout.')
  )
    message.content = message.content
      .replaceAll(
        'Other user permission prompts are unavailable.',
        'Use deploy_ask_user for questions; an answer does not grant computer access.',
      )
      .replace(
        'Only the user can open sessions.',
        'Request a target through deploy_control_request.',
      )
      .replace(
        'Browser/computer tools and user permission prompts are unavailable.',
        'Use deploy_control_list, deploy_control_read, and deploy_control_input only for an explicitly granted task session. Inspect structured evidence before acting; this adapter does not receive screen pixels. Never bypass denied control with shell commands. For window access, use deploy_control_targets then deploy_control_request; the app presents approval for that exact target. Requesting never grants permission. Use deploy_ask_user for questions; an answer does not grant computer access.',
      );
}
if (
  !session.messages.some(
    (m: any) => m.role === 'system' && m.content?.includes('deploy_control_targets'),
  )
) {
  session.messages.push({
    role: 'system',
    content:
      'Use deploy_control_targets to discover windows and deploy_control_request to request access. The app presents approval for the chosen target; do not ask the user to select a dropdown. Pending is not permission. After approval, deploy_control_list returns the session. Never bypass denial.',
  });
}
// Replace the previous run's snapshot on every follow-up, including durable sessions.
session.messages = session.messages.filter(
  (message: any) => !(message.role === 'system' && message.content === session.agentContext),
);
session.agentContext = process.env.DEPLOY_AGENT_INSTRUCTIONS || '';
if (session.agentContext)
  session.messages.unshift({ role: 'system', content: session.agentContext });
const images = environmentImages();
session.messages.push({
  role: 'user',
  content:
    images.length && process.env.DEPLOY_MODEL_SUPPORTS_IMAGES === '1'
      ? [
          { type: 'text', text: prompt },
          ...images.map((image) => ({
            type: 'image_url',
            image_url: { url: `data:${image.mimeType};base64,${image.data}` },
          })),
        ]
      : prompt +
        (images.length
          ? '\n[Images were attached, but this provider cannot read image inputs.]'
          : ''),
});
function persist() {
  mkdirSync(dirname(sessionFile!), { recursive: true });
  writeFileSync(sessionFile!, JSON.stringify(session), { mode: 0o600 });
}
if (
  !session.messages.some(
    (m: any) => m.role === 'system' && m.content?.startsWith('Control tools wait'),
  )
)
  session.messages.push({
    role: 'system',
    content:
      'Control tools wait for approval and action completion. When approval returns an active agent-owned session, continue the original user request immediately using tools. Inspect first. Verify each requested action against returned evidence and Sessions opened during this turn are temporary: stop them through the control tool before finishing unless the user has taken control. Do not end with promises to perform actions that remain undone. If an action is blocked, report the actual limitation; never fabricate success.',
  });
persist();
emit('thread.started', { thread_id: session.id });
emit('turn.started', { model, billingMode: billing, provider: endpoint });
try {
  let consecutiveToolFailures = 0,
    cleanupChecks = 0;
  for (let step = 0; step < 40; step++) {
    const response = await fetch(endpoint!.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.DEPLOY_MODEL_API_KEY
          ? { Authorization: 'Bearer ' + process.env.DEPLOY_MODEL_API_KEY }
          : {}),
      },
      body: JSON.stringify({
        model,
        messages: session.messages,
        tools: schemas.map((fn) => ({ type: 'function', function: fn })),
        parallel_tool_calls: false,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: AbortSignal.timeout(180000),
    });
    if (!response.ok)
      throw new Error(
        `Provider HTTP ${response.status}: ${(await response.text()).slice(0, 3000)}`,
      );
    const messageId = randomUUID();
    let lastUpdate = 0;
    const data = await readCompletion(response, (text) => {
      if (Date.now() - lastUpdate < 250) return;
      lastUpdate = Date.now();
      emit('item.updated', { item: { id: messageId, type: 'agent_message', text } });
    });
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error('Provider returned no assistant message');
    session.messages.push(message);
    persist();
    if (data.usage) emit('usage', { usage: data.usage, billingMode: billing, model });
    if (!message.tool_calls?.length && openedControlSessions.size) {
      const state = await callCoordinationTool('deploy_control', { action: 'list' });
      const unfinished = state.sessions.filter(
        (entry: any) =>
          openedControlSessions.has(entry.id) &&
          !['stopped', 'suspended'].includes(entry.status) &&
          entry.controlOwner === 'agent',
      );
      if (unfinished.length) {
        emit('item.completed', {
          item: { id: messageId, type: 'agent_message', text: 'Finishing window cleanup…' },
        });
        if (++cleanupChecks > 2)
          throw new Error(
            'Agent left a control session open after two cleanup reminders. Completion was not confirmed.',
          );
        session.messages.push({
          role: 'system',
          content:
            'Completion check: your newly opened control sessions are still active. Do not claim they are stopped. Use deploy_control_stop for each exact session below, then report the actual returned status. This is harness feedback, not a new user request. ' +
            JSON.stringify(
              unfinished.map((entry: any) => ({
                sessionId: entry.id,
                generation: entry.generation,
                status: entry.status,
              })),
            ),
        });
        persist();
        continue;
      }
    }
    if (message.content)
      emit('item.completed', {
        item: {
          id: messageId,
          type: 'agent_message',
          text:
            typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
        },
      });
    if (!message.tool_calls?.length) {
      emit('turn.completed', {});
      process.exit(0);
    }
    for (const call of message.tool_calls) {
      emit('item.started', {
        item: {
          id: call.id,
          type: 'tool_call',
          name: call.function.name,
          arguments: call.function.arguments,
        },
      });
      let result;
      try {
        if (consecutiveToolFailures >= 3)
          throw new Error('Skipped: repeated tool failures stopped this run');
        result = await tool(call.function.name, JSON.parse(call.function.arguments || '{}'));
        consecutiveToolFailures = 0;
      } catch (error: any) {
        consecutiveToolFailures++;
        result = 'Tool error: ' + error.message;
      }
      session.messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      persist();
      emit('item.completed', {
        item: { id: call.id, type: 'tool_result', name: call.function.name, output: result },
      });
    }
    if (consecutiveToolFailures >= 3)
      throw new Error(
        'Stopped after 3 consecutive tool failures. Review the tool errors and correct the arguments before continuing.',
      );
  }
  throw new Error('Tool loop reached the 40-step limit');
} catch (error: any) {
  emit('turn.failed', { error: { message: error.message } });
  console.error(error.message);
  process.exitCode = 1;
}
