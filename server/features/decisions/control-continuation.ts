// Keep approval inside the original tool call. Polls are read-only; mutations are
// never replayed. Coordinator authentication fences stopped/replaced runs.
export async function continueControl(
  args: any,
  initial: any,
  call: (args: any) => Promise<any>,
  options: { now?: () => number; wait?: () => Promise<void> } = {},
) {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 500)));
  if (args.action === 'request') {
    const deadline = Math.min(initial.expiresAt, now() + 30 * 60_000);
    let request = initial;
    let approvedSession: any;
    while (now() < deadline) {
      const state = await call({ action: 'list' });
      request = state.requests.find((entry: any) => entry.id === initial.id);
      if (!request) throw new Error('Access request is no longer available');
      if (request.status === 'approved') {
        const session = state.sessions.find((entry: any) => entry.id === request.sessionId);
        if (!session) throw new Error('Approved session is no longer available');
        approvedSession = session;
        if (session.status === 'active' && session.controlOwner === 'agent')
          return { request, ...(await call({ action: 'read', sessionId: session.id })) };
        if (session.status !== 'opening' || session.controlOwner !== 'agent')
          return { request, session, nextStep: 'Control is unavailable. Do not send input.' };
      } else if (request.status !== 'pending') {
        return { request, nextStep: 'Access was not granted. Do not send input or request again.' };
      }
      await wait();
    }
    if (request.status === 'approved')
      return {
        request,
        session: approvedSession,
        nextStep:
          'Worker readiness was not confirmed. Do not send input; read the session status or stop it.',
      };
    return {
      request: { ...request, status: 'expired' },
      nextStep: 'Approval wait expired. Do not send input.',
    };
  }
  if (args.action === 'input') {
    const deadline = now() + 30_000;
    while (now() < deadline) {
      const state = await call({ action: 'read', sessionId: args.sessionId });
      const command = state.commands.find((entry: any) => entry.id === initial.id);
      if (command && !['queued', 'running'].includes(command.status)) return { ...state, command };
      if (state.session.status !== 'active' || state.session.controlOwner !== 'agent')
        return { ...state, command, nextStep: 'Control changed. Do not replay input.' };
      await wait();
    }
    return {
      command: initial,
      nextStep: 'Completion is not confirmed. Read command status; do not replay input.',
    };
  }
  return initial;
}
