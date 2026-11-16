import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

// Match the versions negotiated by the SDK this transport replaces.
const protocolVersions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The tools-only MCP surface used by the Claude Code and Codex stdio clients. */
export function serveMcp({
  tools,
  callTool,
  input = process.stdin,
  output = process.stdout,
}: {
  tools: readonly unknown[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  input?: Readable;
  output?: Writable;
}) {
  const send = (reply: object) => output.write(JSON.stringify(reply) + '\n');
  const error = (id: string | number | null, code: number, message: string) =>
    send({ jsonrpc: '2.0', id, error: { code, message } });
  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on('line', (line) => {
    void receive(line);
  });

  async function receive(line: string) {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      error(null, -32700, 'Parse error');
      return;
    }
    if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      error(null, -32600, 'Invalid Request');
      return;
    }
    // Notifications, including cancellation and future extensions, never get a reply
    // and must not accidentally invoke a tool. Tool calls may remain pending while
    // subsequent requests (including ping) are handled independently.
    if (!('id' in message)) return;
    const id = message.id;
    if (typeof id !== 'string' && !(typeof id === 'number' && Number.isInteger(id))) {
      error(null, -32600, 'Invalid Request');
      return;
    }
    const params = message.params;
    const invalidParams = () => error(id, -32602, 'Invalid params');
    if (params !== undefined && !isObject(params)) {
      invalidParams();
      return;
    }
    if (params?._meta !== undefined && !isObject(params._meta)) {
      invalidParams();
      return;
    }
    let result: unknown;
    switch (message.method) {
      case 'initialize': {
        if (
          !params ||
          typeof params.protocolVersion !== 'string' ||
          !isObject(params.capabilities) ||
          !isObject(params.clientInfo) ||
          typeof params.clientInfo.name !== 'string' ||
          typeof params.clientInfo.version !== 'string'
        ) {
          invalidParams();
          return;
        }
        result = {
          protocolVersion: protocolVersions.includes(params.protocolVersion)
            ? params.protocolVersion
            : protocolVersions[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'deploy.local', version: '1.0.0' },
        };
        break;
      }
      case 'ping':
        result = {};
        break;
      case 'tools/list':
        if (params?.cursor !== undefined && typeof params.cursor !== 'string') {
          invalidParams();
          return;
        }
        result = { tools };
        break;
      case 'tools/call':
        if (
          !params ||
          typeof params.name !== 'string' ||
          (params.arguments !== undefined && !isObject(params.arguments))
        ) {
          invalidParams();
          return;
        }
        try {
          result = await callTool(params.name, (params.arguments || {}) as Record<string, unknown>);
        } catch (cause) {
          result = {
            isError: true,
            content: [
              { type: 'text', text: cause instanceof Error ? cause.message : String(cause) },
            ],
          };
        }
        break;
      default:
        error(id, -32601, 'Method not found');
        return;
    }
    send({ result, jsonrpc: '2.0', id });
  }
  return lines;
}
