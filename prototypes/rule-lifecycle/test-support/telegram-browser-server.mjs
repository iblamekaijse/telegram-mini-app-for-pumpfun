// Test-only stdin harness. No HTTP controls, no token or live Telegram/market requests.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { startPanel } from '../web/server.mjs';
const fixture = JSON.parse(readFileSync(new URL('../fixtures/dexscreener-pumpswap.json', import.meta.url)));
const initial = JSON.parse(process.argv[3] ?? '{}');
let now = initial.now ?? 1800000000000, priceUsd = initial.priceUsd ?? '120', updateId = initial.updateId ?? 0;
const updates = [], sent = [];
const transport = { async call(method, body, signal) {
  if (method === 'getUpdates') {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(done, 80);
      function done() { signal?.removeEventListener('abort', aborted); resolve(); }
      function aborted() { clearTimeout(timer); reject(new Error('TEST aborted')); }
      if (signal?.aborted) aborted(); else signal?.addEventListener('abort', aborted, { once: true });
    });
    return updates.filter(e => e.update_id >= body.offset);
  }
  sent.push({ method, body }); return { message_id: sent.length };
} };
const app = await startPanel({ dataDir: process.argv[2], port: 0, clock: () => now, telegramTransport: transport, telegramToken: '',
  marketFetch: async url => {
    const requestedMint = url.split('/').at(-1);
    return new Response(JSON.stringify([{ ...fixture[0], priceUsd, baseToken: { ...fixture[0].baseToken, address: requestedMint },
      ...(requestedMint !== fixture[0].baseToken.address ? { pairAddress: fixture[0].baseToken.address } : {}) }]));
  } });
console.log(JSON.stringify({ url: app.url, mode: 'OFFLINE TEST Telegram and market transports' }));
createInterface({ input: process.stdin }).on('line', line => {
  const cmd = JSON.parse(line); now += cmd.advanceMs ?? 0; priceUsd = cmd.priceUsd ?? priceUsd;
  if (cmd.text || cmd.callback) {
    const user = cmd.user ?? 42, chat = cmd.chat ?? 42;
    const message = { text: cmd.text, from: { id: user }, chat: { id: chat, type: 'private' } };
    updates.push({ update_id: ++updateId, ...(cmd.callback ? { callback_query: { id: `test-callback-${updateId}`, data: cmd.callback, from: message.from, message } } : { message }) });
  }
  console.log(JSON.stringify({ now, updateId, sent }));
});
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => app.close().then(() => process.exit(0)));
