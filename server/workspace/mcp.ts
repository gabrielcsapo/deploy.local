import { serveMcp } from './mcp-stdio.ts';
import { coordinationTools, callCoordinationTool } from './coordination-tools.ts';

serveMcp({
  tools: coordinationTools,
  callTool: async (name, args) => {
    const result = await callCoordinationTool(name, args);
    const image = result?.snapshot?.image;
    const mimeType = result?.snapshot?.mimeType;
    if (image) delete result.snapshot.image;
    return {
      content: [
        { type: 'text', text: JSON.stringify(result) },
        ...(image && mimeType === 'image/jpeg' ? [{ type: 'image', data: image, mimeType }] : []),
      ],
    };
  },
});
