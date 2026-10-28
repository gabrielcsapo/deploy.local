export function activeControl(sessions, workerId) {
  return sessions.find(
    (s) =>
      s.workerId === workerId &&
      s.kind === 'computer' &&
      ['opening', 'active', 'transferring'].includes(s.status) &&
      s.expiresAt > Date.now(),
  );
}
export function controlBody(session, clientId) {
  return { sessionId: session.id, generation: session.generation, clientId };
}
