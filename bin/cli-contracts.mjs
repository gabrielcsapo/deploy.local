// @ts-check
// The transport owns auth/TLS and parses JSON. Keep the wire boundary checked without
// enabling checkJs on the entire legacy CLI and its operational dependencies.
/** @typedef {(path: string, options?: {method?: string, body?: string}) => Promise<any>} API */
/** @typedef {import('../shared/v2/contracts.ts').Release} Release */
/** @typedef {import('../shared/v2/contracts.ts').Rollback} Rollback */
/** @typedef {import('../shared/v2/contracts.ts').WorkspaceState} WorkspaceState */
/** @typedef {import('../shared/v2/contracts.ts').WorkspaceTask} WorkspaceTask */
/** @typedef {import('../shared/v2/contracts.ts').InboxItem} InboxItem */

/** @param {API} api @param {string} project @returns {Promise<Release[] | {releases: Release[]}>} */
export function projectReleases(api, project) {
  return api(`/api/projects/${encodeURIComponent(project)}/releases`);
}

/** @param {API} api @param {string} project @param {Release['id']} to @param {Release['id']} from
 * @returns {Promise<Rollback | {rollback: Rollback}>} */
export function rollbackProject(api, project, to, from) {
  /** @type {import('../shared/v2/api.ts').RollbackRequest} */
  const body = { to, from };
  return api(`/api/projects/${encodeURIComponent(project)}/rollback`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** @param {API} api @returns {Promise<WorkspaceState>} */
export function workspaceState(api) {
  return api('/api/state');
}

/** @param {API} api @param {string} text @param {string} workerId @param {string} operationId
 * @returns {Promise<WorkspaceTask>} */
export function createWorkspaceTask(api, text, workerId, operationId) {
  /** @type {import('../shared/v2/contracts.ts').CreateWorkspaceTaskRequest} */
  const body = { title: text, prompt: text, workerId, operationId };
  return api('/api/tasks', { method: 'POST', body: JSON.stringify(body) });
}

/** @param {API} api @returns {Promise<InboxItem[] | import('../shared/v2/api.ts').InboxResponse>} */
export function inbox(api) {
  return api('/api/inbox?state=waiting');
}

/** @param {API} api @returns {Promise<InboxItem[] | import('../shared/v2/api.ts').InboxResponse>} */
export function answeredInbox(api) {
  return api('/api/inbox?state=answered');
}

/** @param {API} api @param {InboxItem['id']} id @param {string} actionId
 * @returns {Promise<InboxItem | {item: InboxItem}>} */
export function answerInbox(api, id, actionId) {
  /** @type {import('../shared/v2/api.ts').InboxAnswerRequest} */
  const body = { actionId, on: 'cli' };
  return api(`/api/inbox/${encodeURIComponent(id)}/answer`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** @param {API} api @param {string} id @returns {Promise<{release: Release | null}>} */
export function uploadRelease(api, id) {
  return api(`/api/releases/uploads/${encodeURIComponent(id)}`);
}

/** @param {API} api @param {Release['id']} id @returns {Promise<Release | {release: Release}>} */
export function release(api, id) {
  return api(`/api/releases/${encodeURIComponent(id)}`);
}

/** @param {API} api @param {string} project @returns {Promise<Rollback[] | {rollbacks: Rollback[]}>} */
export function rollbacks(api, project) {
  return api(`/api/projects/${encodeURIComponent(project)}/rollbacks`);
}

/** @typedef {(path: string, body: object) => Promise<any>} JSONPost */
/** @param {JSONPost} post @returns {Promise<import('../shared/v2/api.ts').CliLoginStartResponse>} */
export function startLogin(post) {
  return post('/api/auth/cli/start', {});
}

/** @param {JSONPost} post @param {string} deviceCode
 * @returns {Promise<import('../shared/v2/api.ts').CliLoginPollResponse>} */
export function pollLogin(post, deviceCode) {
  /** @type {import('../shared/v2/api.ts').CliLoginPollRequest} */
  const body = { deviceCode };
  return post('/api/auth/cli/poll', body);
}

/** @typedef {{ branch: string, owner: string, review: null | Record<string, any> }} DesignFeedback */
/** @param {API} api @param {string} design @param {{branch: string, computer: string}} body */
export function designWorking(api, design, body) {
  return api(`${design}/working`, { method: 'POST', body: JSON.stringify(body) });
}

/** @param {API} api @param {string} design
 * @param {{ref: string, title: string, summary: string, lookAt: string[]}} body
 * @returns {Promise<{item: InboxItem}>} */
export function proposeDesign(api, design, body) {
  return api(`${design}/propose`, { method: 'POST', body: JSON.stringify(body) });
}

/** @param {API} api @param {string} design @param {string} branch @returns {Promise<DesignFeedback>} */
export function designFeedback(api, design, branch) {
  return api(`${design}/feedback?branch=${encodeURIComponent(branch)}`);
}

/** Read the answer and say this terminal is waiting for it.
 * @param {API} api @param {string} design @param {string} branch @param {string} computer
 * @returns {Promise<DesignFeedback>} */
export function waitDesignFeedback(api, design, branch, computer) {
  return api(`${design}/feedback/wait`, {
    method: 'POST',
    body: JSON.stringify({ branch, computer }),
  });
}

/** @param {API} api @param {string} design @param {{branch: string, pin: number, reply: string}} body
 * @returns {Promise<{comment: {id: string, reply: string, resolved: boolean}}>} */
export function resolveDesignNote(api, design, body) {
  return api(`${design}/feedback/resolve`, { method: 'POST', body: JSON.stringify(body) });
}
