import { createServer } from 'node:http';

const port = process.env.PORT || 3000;

const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ message: 'Hello from deploy.local!', uptime: process.uptime() }));
});

server.listen(port, () => {
  console.log(`Listening on port ${port}`);
});
