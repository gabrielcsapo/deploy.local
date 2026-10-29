// Shown in the main window when a page could not load, so losing the coordinator never opens
// another window. The desktop app passes the coordinator's name and host in the query.
const query = new URLSearchParams(location.search);
for (const node of document.querySelectorAll('[data-name]'))
  node.textContent = query.get('name') || 'your coordinator';
if (query.get('host'))
  document.querySelector('[data-host]').textContent = ` at ${query.get('host')}`;
