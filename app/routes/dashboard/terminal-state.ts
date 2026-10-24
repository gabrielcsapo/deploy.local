export type TerminalStatus = {
  name: string;
  enabled: boolean;
  online: boolean;
  supported: boolean;
  locallyDisabled: boolean;
  recent: {
    id: string;
    type: string;
    owner: string;
    ip: string;
    startedAt: string;
    durationMs: number;
    code: number | null;
    reason: string;
  }[];
};
export function terminalUnavailable(status: TerminalStatus) {
  if (!status.supported) return `Update deploy.local on ${status.name}`;
  if (!status.online) return 'Computer is offline';
  if (status.locallyDisabled) return 'Terminal access is disabled locally (DEPLOY_TERMINAL=0)';
  if (!status.enabled) return 'Terminal access is disabled';
  return '';
}
export const terminalKeys = [
  ['Esc', '\x1b'],
  ['Tab', '\t'],
  ['←', '\x1b[D'],
  ['↓', '\x1b[B'],
  ['↑', '\x1b[A'],
  ['→', '\x1b[C'],
  ['|', '|'],
  ['~', '~'],
  ['/', '/'],
] as const;
export function controlInput(data: string, control: boolean) {
  return control && /^[a-z@[\\\]^_]$/i.test(data)
    ? String.fromCharCode(data.toUpperCase().charCodeAt(0) & 31)
    : data;
}
