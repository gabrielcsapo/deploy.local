/** The deploy_design tool's schema. Kept free of server imports: workers load it in the MCP process. */
export const designToolSchema = {
  name: 'deploy_design',
  description:
    'Work on this project’s design (design/canvas.json and the boards in design/boards) with the person watching. Edit boards as files in your workspace, keep every data-layer ID, and render with node design/tools/render.mjs. presence: before changing a board or layer, say which (board like Welcome.html, optional layer ID and a short note) so your cursor shows on the Design page; call with no board when you finish. comments: read open comments (all: true includes resolved). comment: leave a comment on a board or layer. resolve: reply to a pin/comment (commentId, reply), set resolved true when addressed or false when still open; keep the original request. propose: when your committed design changes are ready, ask the owner to approve them in Waiting on you. Supply a plain title and a proposer-written summary of 2–3 sentences explaining what changes and why; optional changeWords maps board filenames to layer IDs and your plain words for each change. built: after implementation, report state matches or differs, with a differences count when it differs. Never approve your own design.',
  inputSchema: {
    type: 'object' as const,
    additionalProperties: false,
    required: ['action'],
    allOf: [
      {
        if: { properties: { action: { const: 'propose' } } },
        then: { required: ['title', 'summary'] },
      },
      { if: { properties: { action: { const: 'built' } } }, then: { required: ['state'] } },
      {
        if: {
          properties: { action: { const: 'built' }, state: { const: 'differs' } },
          required: ['state'],
        },
        then: { required: ['differences'] },
      },
    ],
    properties: {
      action: {
        type: 'string',
        enum: ['presence', 'comments', 'comment', 'resolve', 'propose', 'built'],
      },
      state: { type: 'string', enum: ['matches', 'differs'] },
      differences: { type: 'integer', minimum: 1 },
      board: { type: 'string' },
      layer: { type: 'string' },
      note: { type: 'string' },
      text: { type: 'string' },
      commentId: { type: 'string' },
      all: { type: 'boolean' },
      title: { type: 'string', minLength: 1, maxLength: 200 },
      summary: { type: 'string', minLength: 1, maxLength: 4000 },
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
