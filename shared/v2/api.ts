import type { AppHealth, ConversationEvent, InboxItem, Release, Rollback } from './contracts.ts';

export type InboxAnswerRequest = {
  actionId: string;
  on: NonNullable<InboxItem['answer']>['on'];
  surface?: 'menu-bar';
  note?: string;
};
export type InboxResponse = { items: InboxItem[] };
export type V2Event = { cursor: number; taskId: string; runId: string | null; at: string } & (
  | { type: 'agent'; agentId: string }
  | { type: 'inbox'; item: InboxItem }
  | { type: 'health'; app: AppHealth }
  | { type: 'release'; release: Release }
  | { type: 'rollback'; rollback: Rollback }
  | { type: 'conversation'; event: ConversationEvent }
);
export type V2EventsResponse = { events: V2Event[]; cursor: number; supportsWait: true };

export type RollbackRequest = { to: Release['id']; from: Release['id'] };

export type CliLoginStartResponse = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
};
export type CliLoginPollRequest = { deviceCode: CliLoginStartResponse['deviceCode'] };
export type CliLoginPollResponse =
  | { state: 'pending' | 'denied' }
  | { state: 'approved'; username: string; token: string };
