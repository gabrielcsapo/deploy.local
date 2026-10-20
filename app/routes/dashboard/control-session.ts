export function endedControlReason(session: {
  status: string;
  reason?: string | null;
  targetLabel: string;
}): string {
  const reason = session.reason || '';
  if (reason.startsWith('Interaction outcome uncertain'))
    return 'The session stopped after an uncertain action';
  if (reason === 'Stopped by agent') return `The agent finished with ${session.targetLabel}`;
  if (reason === 'Stopped by user') return 'You stopped this session';
  if (reason.startsWith('Control connection expired') || session.status === 'suspended')
    return `The connection to ${session.targetLabel} timed out`;
  return 'This session ended';
}
