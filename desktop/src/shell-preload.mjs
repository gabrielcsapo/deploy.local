import { ipcRenderer } from 'electron';
import { render } from './views.mjs';
window.addEventListener('DOMContentLoaded', () => {
  ipcRenderer.on('shell:state', (_event, state) => {
    const focused = document.activeElement;
    const action = focused?.getAttribute('data-action') || focused?.value;
    const draft =
      document.querySelector('button[value="join"]') && state.page === 'setup'
        ? [...document.querySelectorAll('input[type="checkbox"]')]
            .filter((input) => input.name !== 'runApps')
            .map((input) => [input.name, input.checked])
        : [];
    document.body.innerHTML = render(state);
    for (const [name, checked] of draft) {
      const input = document.querySelector(`input[name="${name}"]`);
      if (input && !input.disabled) input.checked = checked;
    }
    if (action) {
      const target = [...document.querySelectorAll('button, input[data-action]')].find(
        (element) => (element.dataset.action || element.value) === action,
      );
      target?.focus({ preventScroll: true });
    }
  });
  document.addEventListener('change', (event) => {
    if (event.target.matches('input[data-action]')) {
      const submitter = document.createElement('button');
      submitter.value = event.target.dataset.action;
      submitter.hidden = true;
      event.target.form.append(submitter);
      event.target.form.requestSubmit(submitter);
    }
  });
  document.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const body = Object.fromEntries(new FormData(form));
    body.action = event.submitter?.value;
    for (const button of form.querySelectorAll('button, input[data-action]'))
      button.disabled = true;
    try {
      await ipcRenderer.invoke('shell:action', body);
    } catch (error) {
      const p = document.createElement('p');
      p.setAttribute('role', 'alert');
      p.textContent = error.message;
      form.append(p);
    } finally {
      for (const button of form.querySelectorAll('button, input[data-action]'))
        button.disabled = false;
    }
  });
  ipcRenderer.send('shell:ready');
});
