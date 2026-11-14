// Preserve database bootstrap and process-adapter registration for compatibility callers.
import './store.ts';
import './worker-process.ts';
export * from '../kernel/jobs/worker-lease.ts';
