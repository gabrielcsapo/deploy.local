import type { ConversationEvent, InboxItem, Release, Rollback } from './contracts.ts';

export type InboxAnswerRequest = {
  actionId: string;
  on: NonNullable<InboxItem['answer']>['on'];
  note?: string;
};
export type InboxResponse = { items: InboxItem[] };
export type V2Event = { cursor: number; taskId: string; runId: string | null; at: string } & (
  | { type: 'inbox'; item: InboxItem }
  | { type: 'release'; release: Release }
  | { type: 'rollback'; rollback: Rollback }
  | { type: 'conversation'; event: ConversationEvent }
);
export type V2EventsResponse = { events: V2Event[]; cursor: number; supportsWait: true };
