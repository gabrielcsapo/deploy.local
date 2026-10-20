import type { HelperAction } from './bridge.ts';
const bridge = window.deployNode!;
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
async function perform(work: () => Promise<unknown>) {
  element('error').textContent = '';
  try {
    await work();
    await refresh();
  } catch {
    element('error').textContent =
      'Unable to complete setup. Check the code, coordinator connection, or local helper status and retry.';
  }
}
async function refresh() {
  const { node, autostart } = await bridge.status();
  element('connection').textContent = node.enrolled
    ? `${node.workerName} · ${node.online ? 'Online as a worker' : 'Offline'}`
    : 'Connect this computer to deploy.local.';
  element('enrollment').hidden = node.enrolled;
  element('permissions').hidden = !node.enrolled;
  element<HTMLInputElement>('login').checked = autostart;
  element('capabilities').replaceChildren(
    ...Object.entries(node.capabilities).map(([name, capability]) => {
      const item = document.createElement('li');
      item.textContent = `${name}: ${capability.state} — ${capability.reason}${capability.fix ? ` ${capability.fix}` : ''}`;
      return item;
    }),
  );
}
element('enrollment').addEventListener('submit', (event) => {
  event.preventDefault();
  const field = element<HTMLInputElement>('code');
  const address = element<HTMLInputElement>('url');
  void perform(async () => {
    const url = new URL(address.value);
    const hash = new URLSearchParams(url.hash.slice(1));
    const code = field.value || url.searchParams.get('code') || hash.get('code') || '';
    const origin = url.origin;
    field.value = '';
    address.value = origin;
    await bridge.enroll(origin, code);
  });
});
for (const action of ['capture', 'input', 'lock-off', 'lock-restore'] as HelperAction[])
  element(action).addEventListener('click', (event) => {
    event.preventDefault();
    void perform(() => bridge.helper(action));
  });
element('remote').addEventListener('click', (event) => {
  event.preventDefault();
  void perform(() => bridge.permissions());
});
element('login').addEventListener(
  'change',
  () => void perform(() => bridge.autostart(element<HTMLInputElement>('login').checked)),
);
void perform(refresh);
