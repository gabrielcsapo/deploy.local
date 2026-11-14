import { agentInstructions } from '../v2/agent-instructions.ts';
import { registerAgentInstructionsSource } from '../workspace/agent-instructions-port.ts';

export function wireAgentInstructionsSource() {
  registerAgentInstructionsSource(agentInstructions);
}
