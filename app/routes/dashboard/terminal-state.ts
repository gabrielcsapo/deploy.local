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
/**
 * The phone key bar, in reach order: keys a touch keyboard lacks first, then arrows, then the
 * symbols it hides behind a layer switch. Ctrl and paste sit around these groups in the view.
 */
export const terminalKeyGroups = [
  [
    ['Esc', '\x1b', 'Escape'],
    ['Tab', '\t', 'Tab'],
  ],
  [
    ['←', '\x1b[D', 'Left arrow'],
    ['↑', '\x1b[A', 'Up arrow'],
    ['↓', '\x1b[B', 'Down arrow'],
    ['→', '\x1b[C', 'Right arrow'],
  ],
  [
    ['|', '|', 'Pipe'],
    ['~', '~', 'Tilde'],
    ['/', '/', 'Slash'],
    ['-', '-', 'Hyphen'],
  ],
] as const;
export const terminalKeys = terminalKeyGroups.flat();
export function controlInput(data: string, control: boolean) {
  return control && /^[a-z@[\\\]^_]$/i.test(data)
    ? String.fromCharCode(data.toUpperCase().charCodeAt(0) & 31)
    : data;
}
