/** Load both projections, in order, before refreshing either one. */
export type StateRefreshSources = () => Promise<{
  getLive: (owner: string, invalidateRefresh: boolean) => Promise<unknown>;
  syncInbox: (owner: string, invalidateRefresh: boolean) => unknown;
}>;
