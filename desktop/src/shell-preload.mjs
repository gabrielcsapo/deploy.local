import { ipcRenderer } from 'electron';
import { render } from './views.mjs';
window.addEventListener('DOMContentLoaded', () => {
  ipcRenderer.on('shell:state', (_event, state) => {
    document.body.innerHTML = render(state);
  });
  document.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const body = Object.fromEntries(new FormData(form));
    body.action = event.submitter?.value;
    for (const button of form.querySelectorAll('button')) button.disabled = true;
    try {
      await ipcRenderer.invoke('shell:action', body);
    } catch (error) {
      const p = document.createElement('p');
      p.setAttribute('role', 'alert');
      p.textContent = error.message;
      form.append(p);
    } finally {
      for (const button of form.querySelectorAll('button')) button.disabled = false;
    }
  });
  ipcRenderer.send('shell:ready');
});
