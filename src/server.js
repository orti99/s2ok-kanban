import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { openDb } from './db.js';
import { attachUser, bootstrapUsers } from './auth.js';
import { api } from './api.js';
import { handleMcpRequest } from './mcp/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.behindProxy) app.set('trust proxy', 1);

  app.use(express.json({ limit: '1mb' }));
  app.use(attachUser);

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });

  app.use('/api', api);
  app.all('/mcp', (req, res, next) => handleMcpRequest(req, res).catch(next));

  app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  openDb();
  const created = bootstrapUsers(config.bootstrapUsers);
  if (created.length) {
    console.log('\nNo users existed, created initial accounts (passwords shown once, change them after login):');
    for (const u of created) console.log(`  ${u.username.padEnd(12)} ${u.password}`);
    console.log('');
  }
  const app = createApp();
  app.listen(config.port, config.host, () => {
    console.log(`s2ok-kanban listening on http://${config.host}:${config.port}  (data: ${config.dataDir})`);
    console.log(`MCP endpoint: http://${config.host}:${config.port}/mcp`);
  });
}
