const page = {
  cursor: { type: 'string', maxLength: 128 },
  limit: { type: 'integer', minimum: 1, maximum: 20 },
};
const query = { type: 'string', minLength: 1, maxLength: 160 };
const handle = { type: 'string', minLength: 1, maxLength: 256 };
const context = { type: 'integer', minimum: 0, maximum: 3 };
export const projectSections = [
  'entries',
  'exports',
  'symbols',
  'uses',
  'usedBy',
  'unreferenced',
  'files',
  'skipped',
  'coverage',
] as const;
export const codeIndexTools = [
  {
    name: 'deploy_code_find',
    description: 'Find code symbols, projects and packages by name.',
    inputSchema: { properties: { query, ...page }, required: ['query'] },
  },
  {
    name: 'deploy_code_symbol',
    description: 'Read a definition and usage counts. Request section references for locations.',
    inputSchema: {
      properties: { handle, section: { type: 'string', enum: ['references'] }, context, ...page },
      required: ['handle'],
    },
  },
  {
    name: 'deploy_code_project',
    description: 'Read a project’s code index status and browse one graph section at a time.',
    inputSchema: {
      properties: { project: handle, section: { type: 'string', enum: projectSections }, ...page },
      required: ['project'],
    },
  },
  {
    name: 'deploy_code_search',
    description: 'Search indexed code and text across this owner’s projects.',
    inputSchema: { properties: { query, project: handle, context, ...page }, required: ['query'] },
  },
].map(({ inputSchema, ...tool }) => ({
  ...tool,
  inputSchema: { type: 'object' as const, additionalProperties: false, ...inputSchema },
}));
