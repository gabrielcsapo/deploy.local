export const projectTools = [
  {
    name: 'deploy_project',
    description:
      'Read or manage issues, pull requests and pipelines in this conversation’s project. Creates link back to this task. Use get/diff to inspect current revision and commit IDs before modifying or merging. merge and retry-merge run only when the owner’s merge rule allows this agent; otherwise they are refused and asking again does not change that, so tell the person the pull request is ready for them to merge. Pipeline actions must be authorized by the user. This does not switch conversations. Never invent successful checks or a deployment.',
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      required: ['resource', 'action'],
      properties: {
        resource: { type: 'string', enum: ['issues', 'pulls', 'pipelines'] },
        action: {
          type: 'string',
          enum: [
            'list',
            'get',
            'diff',
            'create',
            'update',
            'close',
            'reopen',
            'comment',
            'merge',
            'retry-merge',
            'cancel',
          ],
        },
        id: { type: 'string' },
        operationId: { type: 'string' },
        revision: { type: 'integer' },
        title: { type: 'string' },
        body: { type: 'string' },
        sourceBranch: { type: 'string' },
        targetBranch: { type: 'string' },
        issueIds: { type: 'array', items: { type: 'string' } },
        baseCommit: { type: 'string' },
        headCommit: { type: 'string' },
        ref: { type: 'string' },
        pullId: { type: 'string' },
      },
    },
  },
];
