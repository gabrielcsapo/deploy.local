/** The deploy_design tool's schema. Kept free of server imports: workers load it in the MCP process. */
export const designToolSchema = {
  name: 'deploy_design',
  description:
    'Work on this project’s design (design/canvas.json and the boards in design/boards) with the person watching. Edit boards as files in your workspace, keep every data-layer ID, and render with node design/tools/render.mjs. presence: before changing a board or layer, say which (board like Welcome.html, optional layer ID and a short note) so your cursor shows on the Design page; call with no board when you finish. comments: read open comments (all: true includes resolved). comment: leave a comment on a board or layer. resolve: reply to a pin/comment (commentId, reply), set resolved true when addressed or false when still open; keep the original request. propose: when your committed design changes are ready, ask the owner to approve them in Waiting on you. Supply a plain title and a proposer-written summary of 2–3 sentences explaining what changes and why; optional changeWords maps board filenames to layer IDs and your plain words for each change. Never approve your own design.',
  inputSchema: {
    type: 'object' as const,
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: { type: 'string', enum: ['presence', 'comments', 'comment', 'resolve', 'propose'] },
      board: { type: 'string' },
      layer: { type: 'string' },
      note: { type: 'string' },
      text: { type: 'string' },
      commentId: { type: 'string' },
      all: { type: 'boolean' },
      title: { type: 'string', maxLength: 200 },
      summary: { type: 'string', maxLength: 4000 },
      changeWords: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          additionalProperties: { type: 'string', maxLength: 500 },
        },
      },
      reply: { type: 'string', maxLength: 1000 },
      resolved: { type: 'boolean' },
    },
  },
};
