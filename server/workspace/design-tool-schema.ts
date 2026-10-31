/** The deploy_design tool's schema. Kept free of server imports: workers load it in the MCP process. */
export const designToolSchema = {
  name: 'deploy_design',
  description:
    'Work on this project’s design (design/canvas.json and the boards in design/boards) with the person watching. Edit boards as files in your workspace, keep every data-layer ID, and render with node design/tools/render.mjs. presence: before changing a board or layer, say which (board like Welcome.html, optional layer ID and a short note) so your cursor shows on the Design page; call with no board when you finish. comments: read open comments (all: true includes resolved). comment: leave a comment on a board or layer. resolve: resolve a comment you addressed (commentId). propose: when your committed design changes are ready, ask the owner to approve them in Waiting on you. Never approve your own design.',
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
    },
  },
};
