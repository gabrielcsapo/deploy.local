import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { coordinationTools, callCoordinationTool } from './coordination-tools.ts';
const server = new Server(
  { name: 'deploy.local', version: '1.0.0' },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: coordinationTools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const result = await callCoordinationTool(request.params.name, request.params.arguments || {});
    const image = result?.snapshot?.image;
    const mimeType = result?.snapshot?.mimeType;
    if (image) delete result.snapshot.image;
    return {
      content: [
        { type: 'text', text: JSON.stringify(result) },
        ...(image && mimeType === 'image/jpeg' ? [{ type: 'image', data: image, mimeType }] : []),
      ],
    };
  } catch (error: any) {
    return { isError: true, content: [{ type: 'text', text: error.message }] };
  }
});
await server.connect(new StdioServerTransport());
