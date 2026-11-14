/** Lazy agent operations used by conversation attachments. Records stay provider-owned. */
export type AgentChatSource = () => Promise<{
  agentsForOwner: (owner: string) => any[];
  agentConversation: (owner: string, agentId: string) => any[];
  agentTeachingPrompt: (owner: string, agent: any) => string;
  saveAgentReply: (
    owner: string,
    agent: any,
    content: string,
    reply: string,
    attachments?: any[],
    model?: string,
    operationId?: string,
  ) => { events: any[] };
}>;
