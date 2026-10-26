// Offline process-restart regression worker; never uses TelegramTransport or a real market transport.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { settings } from '../ops/config.mjs';
import { runLiveCheck } from '../ops/live-check.mjs';
import { startPanel } from '../web/server.mjs';
const config = settings();
const file = join(config.dataDir, '.paper-live-check/report.json');
let now = Math.max(Date.now(), existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).updatedAtMs + 1000 : 0);
const fixture = JSON.parse(readFileSync(new URL('../fixtures/dexscreener-pumpswap.json', import.meta.url)));
let app, id = 100;
const updates = [];
const transport = { async call(method, body) {
  if (method === 'getMe') return { id: 123456, is_bot: true };
  if (method === 'getWebhookInfo') return { url: '' };
  if (method === 'getUpdates') { await new Promise(r => setTimeout(r, 10)); return updates.splice(0); }
  if (method === 'sendMessage') {
    if (body.text.includes(':status]')) updates.push({ update_id: 900, message: { text: '/status', date: Math.floor(now / 1000),
      chat: { id: 42, type: 'private' }, from: { id: 42 }, reply_to_message: { message_id: id, from: { id: 123456 } } } });
    return { message_id: id++ };
  }
  throw new Error('Offline worker rejects other methods');
} };
const result = await runLiveCheck({ config, evidenceMode: 'test-transports', processRestart: true, transport,
  marketFetch: async () => new Response(JSON.stringify([{ ...fixture[0], priceUsd: '0.0001' }])),
  start: async opts => { app = await startPanel(opts); return app; }, now: () => now,
  sleep: async () => { now += 1000; await app.serial(() => app.service.pollMarket()); await new Promise(r => setTimeout(r, 20)); }, notify: () => {} });
console.log(JSON.stringify({ status: result.report.status, restartRequired: result.restartRequired ?? false, code: result.failure?.code }));
process.exitCode = result.failure ? 1 : result.restartRequired ? 75 : 0;
