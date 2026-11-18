// Keep agent-launch's eager prefix before the former worker-entry import slot.
import '../features/agents/agent-packages.ts';
import '../workspace/node-runtime.ts';
import '../features/agents/coordination-tools.ts';
import '../workspace/tls-trust.ts';
import { workerEntry } from '../workspace/worker-entry.ts';
import { registerWorkerEntry } from '../workspace/worker-entry-port.ts';

export function wireWorkerEntry() {
  registerWorkerEntry(workerEntry);
}
