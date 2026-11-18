/** The deploy_design tool's schema. Kept free of server imports: workers load it in the MCP process. */
export const designToolSchema = {
  name: 'deploy_design',
  description:
    'Work on one of this project’s designs with the person watching: the App design (design/) or a named design (artifacts/<name>/), each a canvas.json and one HTML board per screen in boards/. Start with list (the designs on main and which one this task uses) and use (artifact: a name for a named design, left out for the App design). use binds this task to that design so its comments, presence and proposals go there; a design not on main yet comes back with a starter canvas.json and a board template to write into your workspace, and every use returns the format guide. Keep every data-layer ID. presence: before changing a board or layer, say which (board like Welcome.html, optional layer ID and a short note) so your cursor shows on the Design page; call with no board when you finish. comments: read open comments (all: true includes resolved). comment: leave a comment on a board or layer. resolve: reply to a pin/comment (commentId, reply), set resolved true when addressed or false when still open; keep the original request. propose: when your committed design changes are ready, ask the owner to approve them in Waiting on you. Approval puts the design on main only; wait for the owner to ask for a build before implementing. Supply a plain title and a proposer-written summary of 2–3 sentences explaining what changes and why; optional changeWords maps board filenames to layer IDs and your plain words for each change. built: after implementation, report state matches or differs, with a positive differences count and required text describing what differs in plain words. Optional why, board, width and screenshotId identify the difference and a capture from this task. matches may include captures (number compared). Later reports replace earlier reports. Differences go to the owner as one decision; wait for Fix the app or Keep it and update the design. Keep means update the board in your task branch for the pull request. Never approve your own design.',
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
        then: { required: ['differences', 'text'] },
      },
    ],
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'use', 'presence', 'comments', 'comment', 'resolve', 'propose', 'built'],
      },
      state: { type: 'string', enum: ['matches', 'differs'] },
      differences: { type: 'integer', minimum: 1 },
      captures: { type: 'integer', minimum: 0 },
      comparisons: {
        type: 'array',
        maxItems: 100,
        description:
          'Optional compared pairs, including matches, so Compare can open the approved board and the task capture at each width.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['board', 'width', 'screenshotId'],
          properties: {
            artifact: {
              type: 'string',
              pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
              description:
                'For use: the named design, artifacts/<artifact>/. Leave out for the App design.',
            },
            board: { type: 'string' },
            width: { type: 'integer', minimum: 320, maximum: 2560 },
            screenshotId: { type: 'string' },
          },
        },
      },
      why: { type: 'string', minLength: 1, maxLength: 4000 },
      width: { type: 'integer', minimum: 320, maximum: 2560 },
      screenshotId: { type: 'string', description: 'ID of an existing capture from this task.' },
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
