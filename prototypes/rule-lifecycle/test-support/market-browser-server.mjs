// OFFLINE browser harness only. Not used by npm start, no HTTP scenario controls.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { startPanel } from '../web/server.mjs';
const fixture = JSON.parse(readFileSync(new URL('../fixtures/dexscreener-pumpswap.json', import.meta.url)));
let now = Date.now(), scenario = 'fixture', priceUsd = fixture[0].priceUsd, calls = 0;
const app = await startPanel({ dataDir: process.argv[2], port: 0, clock: () => now, marketFetch: async () => {
  calls++;
  if (scenario === 'error') throw new Error('OFFLINE TEST transport failure');
  return new Response(JSON.stringify(scenario === 'no_data' ? [] : [{ ...fixture[0], priceUsd }]));
} });
console.log(JSON.stringify({ url: app.url, mode: 'OFFLINE SAVED FIXTURE' }));
createInterface({ input: process.stdin }).on('line', line => {
  const command = JSON.parse(line);
  now += command.advanceMs ?? 0; scenario = command.scenario ?? scenario; priceUsd = command.priceUsd ?? priceUsd;
  console.log(JSON.stringify({ controlled: true, now, calls }));
});
