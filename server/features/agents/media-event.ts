import type { ConversationEvent } from '../../../shared/v2/contracts.ts';

export function mapMediaEvent(row: any): ConversationEvent | undefined {
  const event = row.payload?.event;
  if (
    row.type === 'v2.conversation' &&
    event?.kind === 'screenshot' &&
    ['id', 'at', 'screenshotId'].every((key) => typeof event[key] === 'string')
  )
    return { kind: 'screenshot', id: event.id, at: event.at, screenshotId: event.screenshotId };
}
