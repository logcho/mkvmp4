import { server, stopConversions, prepareStorage } from './server-core.mjs';
await prepareStorage();
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port })));
server.on('error', error => { console.error(error.message); process.exit(1); });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  stopConversions();
  server.close();
  process.exit(0);
});
