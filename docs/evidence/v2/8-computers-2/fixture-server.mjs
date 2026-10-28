// Existing Restarting screen, isolated from the coordinator and all services.
import { createServer } from 'node:http';
import { restartingHtml } from '../../../../server/edge/restarting.ts';
const server = createServer((req, res) => {
  if (req.url !== '/restarting') {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(503, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
  res.end(restartingHtml('SER', '7f3b2d4'));
});
server.listen(5186, '127.0.0.1', () => console.log('Fixture: http://127.0.0.1:5186/restarting'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
