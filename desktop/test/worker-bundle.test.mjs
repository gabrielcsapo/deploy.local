import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const worker = fileURLToPath(new URL('../build/worker/', import.meta.url));

// The bundled worker launches Claude and the deploy tool server as scripts beside
// worker.mjs; a build without them fails every Claude task on the desktop.
test(
  'the bundled worker ships its agent scripts and a tool server with the agent tools',
  { skip: !existsSync(worker + 'worker.mjs') && 'run pnpm build first', timeout: 20000 },
  async () => {
    for (const name of ['claude-agent', 'compatible-agent', 'mcp'])
      assert.ok(existsSync(`${worker}workspace-${name}.js`), `workspace-${name}.js`);
    const child = spawn(process.execPath, [worker + 'workspace-mcp.js'], {
      env: { ...process.env, DEPLOY_AGENT_URL: 'http://127.0.0.1:9/', DEPLOY_AGENT_TOKEN: 't' },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const tools = await new Promise((resolve, reject) => {
      let buffer = '';
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        for (const line of buffer.split('\n')) {
          try {
            const message = JSON.parse(line);
            if (message.id === 2) resolve(message.result.tools.map((tool) => tool.name));
          } catch {}
        }
      });
      child.once('exit', (code) => reject(new Error(`tool server exited ${code}`)));
      for (const message of [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'test', version: '1' },
          },
        },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      ])
        child.stdin.write(JSON.stringify(message) + '\n');
    }).finally(() => child.kill());
    assert.ok(tools.includes('deploy_code_find'));
  },
);
