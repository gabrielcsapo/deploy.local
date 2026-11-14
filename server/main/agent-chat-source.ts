import { registerAgentChatSource } from '../v2/agent-chat-source-port.ts';

export function wireAgentChatSource() {
  registerAgentChatSource(async () => import('../v2/agents.ts'));
}
