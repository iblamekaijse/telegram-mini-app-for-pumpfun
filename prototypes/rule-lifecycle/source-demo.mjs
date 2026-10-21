import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { streamRule, sourceEvent, DEMO_SOURCE_ID, DEMO_PRICE_BASIS } from './fixtures.mjs';

const directory = mkdtempSync(join(tmpdir(), 'rule-source-demo-'));
const worker = fileURLToPath(new URL('./test-support/process-worker.mjs', import.meta.url));
const action = (method, ...args) => ({ method, args });
const ruleId = 'demo-rule-1';
const initial = [action('createRule', streamRule(), { requestId: 'create' }),
  action('bindSource', ruleId, { sourceId: DEMO_SOURCE_ID }, { requestId: 'bind' }),
  action('enable', ruleId, { requestId: 'enable' })];
const source = { sourceId: DEMO_SOURCE_ID, events: [
  sourceEvent(1, { payload: { ...DEMO_PRICE_BASIS, priceUnits: 200 } }), sourceEvent(2), sourceEvent(3),
] };
function run(storagePath, job, signal = null) {
  const child = spawnSync(process.execPath, [worker, JSON.stringify({ storagePath, ...job })], { encoding: 'utf8', timeout: 10_000 });
  assert.ifError(child.error); assert.equal(child.signal, signal, child.stdout || child.stderr);
  if (!signal) assert.equal(child.status, 0, child.stdout || child.stderr);
  const result = JSON.parse(child.stdout.trim());
  assert(!result.results.some(r => r?.error), child.stdout);
  return result;
}
console.log('DEMO ONLY: синтетический поток, условная котировка DEMO:QUOTE-A. Solana не подключена.');
try {
  const storage = join(directory, 'stream.sqlite');
  const stopped = run(storage, { initialize: true, source, killAfterActions: true, actions: [...initial,
    action('sourceDrain', { maxEvents: 1 }), action('sourceDisconnect'), action('getSourceState', ruleId),
  ] }, 'SIGKILL');
  assert.equal(stopped.results.at(-1).cursor, 1);
  console.log(JSON.stringify({ stage: 'disconnect_and_SIGKILL', cursor: stopped.results.at(-1).cursor }));

  const recovered = run(storage, { source: { ...source, replay: [1], disconnectAfter: 1 }, actions: [
    action('sourceDrain'), action('getSourceState', ruleId), action('getRule', ruleId),
  ] });
  assert.equal(recovered.results[0].deliveries[0].duplicate, true);
  assert.equal(recovered.simulatorCalls, 1);
  console.log(JSON.stringify({ stage: 'another_process_replay_and_auto_reconnect', duplicate: true,
    reconnects: recovered.results[0].reconnects, cursor: recovered.results[1].cursor,
    rule: recovered.results[2].state, simulatorCalls: recovered.simulatorCalls }));

  const replayed = run(storage, { source: { ...source, replay: [2, 3] }, actions: [action('sourceDrain')] });
  assert.equal(replayed.simulatorCalls, 0);
  console.log(JSON.stringify({ stage: 'another_restart_and_replay', duplicates: replayed.results[0].deliveries.length, simulatorCalls: replayed.simulatorCalls }));

  const lostStorage = join(directory, 'lost-history.sqlite');
  run(lostStorage, { initialize: true, source, actions: [...initial, action('sourceDrain', { maxEvents: 1 })] });
  const lost = run(lostStorage, { source: { ...source, retainedFrom: 3 }, actions: [action('sourceDrain'), action('getSourceState', ruleId)] });
  assert.equal(lost.results[0].status, 'decision_required');
  const reconnected = run(lostStorage, { source, actions: [action('sourceReconnect'), action('sourceDrain'), action('getSourceState', ruleId)] });
  assert.equal(reconnected.results[0].status, 'connected');
  assert.equal(reconnected.results[1].status, 'decision_required');
  console.log(JSON.stringify({ stage: 'history_loss_requires_decision_after_restart', reason: lost.results[1].issue.reason,
    transport: reconnected.results[0].status, execution: reconnected.results[1].status,
    cursor: reconnected.results[2].cursor, simulatorCalls: reconnected.simulatorCalls }));
} finally { rmSync(directory, { recursive: true, force: true }); }
