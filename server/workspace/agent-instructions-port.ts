import type { AgentInstructionsSource } from '../contracts/agent-instructions.ts';

let provider: AgentInstructionsSource | undefined;

export function registerAgentInstructionsSource(value: AgentInstructionsSource) {
  provider = value;
}

export function requireAgentInstructionsSource(processName: string): AgentInstructionsSource {
  if (!provider) throw new Error(`AgentInstructionsSource is not wired in ${processName}`);
  return provider;
}
