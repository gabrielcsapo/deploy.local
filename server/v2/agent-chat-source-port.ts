import type { AgentChatSource } from '../contracts/agent-chat-source.ts';

let provider: AgentChatSource | undefined;

export function registerAgentChatSource(value: AgentChatSource) {
  provider = value;
}

export function requireAgentChatSource(processName: string): AgentChatSource {
  if (!provider) throw new Error(`AgentChatSource is not wired in ${processName}`);
  return provider;
}
