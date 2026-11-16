import { nodeRuntimeEnvironment } from './node-runtime.ts';
import { environmentImages } from './agent-media.ts';
import { claudeImageMessage } from './media-files.ts';
import { spawn } from 'node:child_process';
import { ClaudeTextStream } from './claude-stream.ts';
import { workerEntry } from './worker-entry.ts';
import { trustEnvironment } from './tls-trust.ts';
const emit = (type: string, payload: any) => console.log(JSON.stringify({ type, ...payload }));
const config = {
  mcpServers: {
    deploy: {
      command: process.execPath,
      args: workerEntry('mcp'),
      env: { ...trustEnvironment(), ...nodeRuntimeEnvironment() },
      timeout: 1860000,
    },
  },
};
const child = spawn(
  process.env.DEPLOY_CLAUDE_BIN || 'claude',
  [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--append-system-prompt',
    process.env.DEPLOY_AGENT_INSTRUCTIONS || '',
    '--include-partial-messages',
    '--strict-mcp-config',
    '--mcp-config',
    JSON.stringify(config),
    '--permission-mode',
    'acceptEdits',
    '--allowedTools',
    'Read,Edit,Write,Glob,Grep,Bash,mcp__deploy__*',
    ...(process.env.DEPLOY_MODEL_EFFORT ? ['--effort', process.env.DEPLOY_MODEL_EFFORT] : []),
    ...(process.env.DEPLOY_MODEL_NAME ? ['--model', process.env.DEPLOY_MODEL_NAME] : []),
    ...(process.env.DEPLOY_AGENT_SESSION_ID
      ? ['--resume', process.env.DEPLOY_AGENT_SESSION_ID]
      : []),
  ],
  {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '0' },
  },
);
const textStream = new ClaudeTextStream((event) => emit(event.type, { item: event.item }));
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
child.stdin!.end(JSON.stringify(claudeImageMessage(prompt, environmentImages())) + '\n');
let buffer = '',
  failed = false;
const tools = new Map<string, { name: string; arguments: unknown; startedAt: string }>();
child.stdout!.on('data', (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    try {
      const value = JSON.parse(line);
      textStream.consume(value);
      if (value.type === 'system' && value.subtype === 'init')
        emit('thread.started', { thread_id: value.session_id });
      if (value.type === 'assistant')
        for (const block of value.message?.content || []) {
          if (block.type === 'tool_use') {
            tools.set(block.id, {
              name: block.name,
              arguments: block.input,
              startedAt: new Date().toISOString(),
            });
            emit('item.started', {
              item: { type: 'tool_call', id: block.id, name: block.name, arguments: block.input },
            });
          }
        }
      if (value.type === 'user')
        for (const block of value.message?.content || []) {
          if (block.type === 'tool_result')
            emit('item.completed', {
              item: {
                type: 'tool_result',
                id: block.tool_use_id,
                // A result replaces its call on the page, so it carries the call's name.
                ...tools.get(block.tool_use_id),
                output: block.content,
                isError: block.is_error || false,
              },
            });
        }
      if (value.type === 'result') {
        if (value.is_error) console.error(value.result || 'Claude run failed');
        failed = Boolean(value.is_error);
        emit(failed ? 'turn.failed' : 'turn.completed', { result: value });
      }
    } catch {
      emit('provider.output', { text: line });
    }
  }
});
child.once('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once('close', (code) => {
  textStream.flush();
  process.exitCode = failed ? 1 : (code ?? 1);
});
