import { EventEmitter } from 'node:events';

export interface DeployEvent {
  type: string;
  deploymentName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(100);

export function emit(event: DeployEvent) {
  emitter.emit('event', event);
}

export function on(handler: (event: DeployEvent) => void) {
  emitter.on('event', handler);
  return () => emitter.off('event', handler);
}
