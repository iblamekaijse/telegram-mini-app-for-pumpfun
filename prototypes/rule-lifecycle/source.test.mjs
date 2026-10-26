import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { RuleEngine } from './rule-engine.mjs';
import { SimulatedExecutor } from './simulator.mjs';
import { SyntheticSource } from './synthetic-source.mjs';
import { SourceConsumer } from './source-consumer.mjs';
import { streamRule, sourceEvent, demoEvent, demoRule, DEMO_START_MS, DEMO_SOURCE_ID, DEMO_PRICE_BASIS } from './fixtures.mjs';

const ruleId = 'demo-rule-1', opId = 'demo-operation-1';
const high = position => sourceEvent(position, { payload: { ...DEMO_PRICE_BASIS, priceUnits: 200 } });
const command = (method, ...args) => ({ method, args });
const initial = () => [command('createRule', streamRule(), { requestId: 'create' }),
  command('bindSource', ruleId, { sourceId: DEMO_SOURCE_ID }, { requestId: 'bind' }), command('enable', ruleId, { requestId: 'enable' })];
const state = () => command('getSourceState', ruleId);
const rule = () => command('getRule', ruleId);
const operation = () => command('getOperation', opId);
const drain = options => command('sourceDrain', options ?? {});
const worker = fileURLToPath(new URL('./test-support/process-worker.mjs', import.meta.url));

function setup(events, { outcome = 'succeeded' } = {}) {
  let now = DEMO_START_MS;
  const simulator = new SimulatedExecutor({ outcome });
  const engine = new RuleEngine({ executor: simulator, clock: () => now });
  engine.createRule(streamRule(), { requestId: 'create' });
  engine.bindSource(ruleId, { sourceId: DEMO_SOURCE_ID }, { requestId: 'bind' });
  engine.enable(ruleId, { requestId: 'enable' });
  const source = new SyntheticSource({ sourceId: DEMO_SOURCE_ID, events });
  const consumer = new SourceConsumer({ engine, source, ruleId });
  return { engine, source, consumer, simulator, advance: ms => { now += ms; } };
}
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rule-source-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { storagePath: join(directory, 'state.sqlite'), tracePath: join(directory, 'calls.ndjson') };
}
function run(f, job = {}, signal = null) {
  const child = spawnSync(process.execPath, [worker, JSON.stringify({ ...f, ...job })], { encoding: 'utf8', timeout: 10_000 });
  assert.ifError(child.error); assert.equal(child.signal, signal, child.stderr || child.stdout);
  if (!signal) assert.equal(child.status, 0, child.stderr || child.stdout);
  return JSON.parse(child.stdout.trim());
}
const sourceJob = events => ({ sourceId: DEMO_SOURCE_ID, events });
function calls(f) {
  try { return readFileSync(f.tracePath, 'utf8').trim().split('\n').filter(Boolean).length; }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
}

test('automatic reconnect resumes from committed position without enabling a paused rule', async () => {
  const s = setup([high(1), sourceEvent(2)]);
  s.source.disconnectAfter(1);
  const result = await s.consumer.drain();
  assert.equal(result.reconnects, 1);
  assert.equal(result.status, 'caught_up');
  assert.equal(s.engine.getSourceState(ruleId).cursor, 2);
  assert.equal(s.simulator.callCount, 1);

  const paused = setup([high(1), sourceEvent(2)]);
  await paused.consumer.drain({ maxEvents: 1 });
  paused.engine.pause(ruleId, { requestId: 'pause' });
  paused.consumer.disconnect();
  assert.equal((await paused.consumer.drain()).status, 'caught_up');
  assert.equal(paused.engine.getRule(ruleId).state, 'paused');
  assert.equal(paused.simulator.callCount, 0);
});

test('replayed delivery has a new receipt time but retains identity and cannot purchase twice', async () => {
  const s = setup([sourceEvent(1)]);
  await s.consumer.drain();
  s.advance(10); s.consumer.disconnect(); s.source.replayOnNextConnect([1, 1]);
  const replayed = await s.consumer.drain();
  assert(replayed.deliveries.every(d => d.duplicate && d.receivedAtMs === DEMO_START_MS + 10));
  assert.equal(s.engine.getOperation(opId).event.sourceEvent.receivedAtMs, DEMO_START_MS);
  assert.equal(s.engine.getSourceState(ruleId).cursor, 1);
  assert.equal(s.simulator.callCount, 1);
});

test('stale, foreign-asset, foreign-quote and different-scale values cannot trigger the rule', async () => {
  const s = setup([sourceEvent(1, { occurredAtMs: DEMO_START_MS - 101 }),
    sourceEvent(2, { assetId: 'DEMO:ASSET-B' }),
    sourceEvent(3, { payload: { ...DEMO_PRICE_BASIS, quoteAssetId: 'DEMO:QUOTE-B', priceUnits: 1 } }),
    sourceEvent(4, { payload: { ...DEMO_PRICE_BASIS, quoteDecimals: 3, priceUnits: 1 } }), sourceEvent(5)]);
  const first = await s.consumer.drain({ maxEvents: 4 });
  assert.deepEqual(first.deliveries.map(d => d.disposition), ['ignored_stale', 'ignored_asset', 'ignored_incompatible_price', 'ignored_incompatible_price']);
  assert.equal(s.simulator.callCount, 0);
  assert.equal(s.engine.getSourceState(ruleId).cursor, 4);
  await s.consumer.drain();
  assert.equal(s.simulator.callCount, 1);
});

test('future data is ignored without poisoning the timestamp high-water mark', async () => {
  const s = setup([sourceEvent(1, { occurredAtMs: DEMO_START_MS + 1 }), sourceEvent(2)]);
  const result = await s.consumer.drain();
  assert.equal(result.deliveries[0].disposition, 'ignored_future');
  assert.equal(result.deliveries[1].disposition, 'prepared');
  assert.equal(s.simulator.callCount, 1);
});

test('contiguous positions with older occurrence time are durably ignored, not sorted into a purchase', async () => {
  const s = setup([high(1), sourceEvent(2, { occurredAtMs: DEMO_START_MS - 1 }), sourceEvent(3)]);
  const first = await s.consumer.drain({ maxEvents: 2 });
  assert.equal(first.deliveries[1].disposition, 'ignored_out_of_order');
  assert.equal(s.simulator.callCount, 0);
  assert.equal(s.engine.getSourceState(ruleId).cursor, 2);
  await s.consumer.drain();
  assert.equal(s.simulator.callCount, 1); // Equal time is ordered by position.
});

test('a forward position gap latches decision_required and later delivery cannot silently repair it', async () => {
  const s = setup([high(1), sourceEvent(2)]);
  s.source.replayOnNextConnect([2]);
  assert.equal((await s.consumer.drain()).status, 'decision_required');
  assert.equal(s.engine.getSourceState(ruleId).cursor, 0);
  assert.equal(s.engine.getSourceState(ruleId).issue.reason, 'position_gap');
  assert.equal(s.engine.getRule(ruleId).state, 'paused');
  assert.throws(() => s.engine.enable(ruleId, { requestId: 'resume' }), { code: 'SOURCE_DECISION_REQUIRED' });
  assert.equal(s.consumer.reconnect().status, 'connected');
  assert.equal((await s.consumer.drain()).status, 'decision_required');
  assert.equal(s.simulator.callCount, 0);
});

for (const mutation of ['changed-content', 'same-position-new-id', 'same-id-new-position', 'wrong-source', 'unknown-unit']) {
  test(`source contract violation (${mutation}) blocks execution without advancing cursor`, async () => {
    const s = setup([high(1), sourceEvent(2)]);
    await s.consumer.drain({ maxEvents: 1 });
    let record = high(1);
    if (mutation === 'changed-content') record.payload.priceUnits = 95;
    if (mutation === 'same-position-new-id') record.eventId = 'replacement';
    if (mutation === 'same-id-new-position') record.position = 2;
    if (mutation === 'wrong-source') record.sourceId = 'DEMO:different-feed';
    if (mutation === 'unknown-unit') record.payload.unit = 'unidentified-number';
    const result = s.engine.receiveSourceEvent(ruleId, record);
    assert.equal(result.disposition, 'decision_required');
    assert.equal(s.engine.getSourceState(ruleId).cursor, 1);
    assert.equal(s.simulator.callCount, 0);
  });
}

test('history unavailable cancels unsubmitted intent and reconnect never clears the persisted latch', async () => {
  const s = setup([sourceEvent(1), sourceEvent(2), sourceEvent(3)]);
  s.consumer.reconnect();
  const accepted = s.engine.receiveSourceEvent(ruleId, sourceEvent(1));
  assert.equal(accepted.disposition, 'prepared');
  s.source.pruneBefore(3);
  assert.equal(s.consumer.reconnect().status, 'history_unavailable');
  assert.equal(s.engine.getOperation(opId).status, 'cancelled');
  assert.equal(s.engine.getSourceState(ruleId).cursor, 1);
  assert.equal((await s.engine.executePrepared(opId, { requestId: 'attempt' })).status, 'cancelled');
  assert.equal(s.simulator.callCount, 0);
});

test('unknown stays blocked while duplicates and fresh events continue to be recorded', async () => {
  const s = setup([sourceEvent(1), sourceEvent(2)], { outcome: 'unknown' });
  await s.consumer.drain({ maxEvents: 1 });
  s.consumer.disconnect(); s.source.replayOnNextConnect([1]);
  const result = await s.consumer.drain();
  assert.equal(result.deliveries[0].duplicate, true);
  assert.equal(result.deliveries[1].disposition, 'ignored_inactive');
  assert.equal(s.engine.getSourceState(ruleId).cursor, 2);
  assert.equal(s.engine.getOperation(opId).status, 'unknown');
  assert.throws(() => s.engine.enable(ruleId, { requestId: 'retry' }), { code: 'ATTEMPT_ALREADY_SUBMITTED' });
  assert.equal(s.simulator.callCount, 1);
});

test('stream-bound rules require explicit price basis and cannot use the legacy event shortcut', () => {
  const engine = new RuleEngine({ clock: () => DEMO_START_MS });
  engine.createRule(demoRule(), { requestId: 'create' });
  assert.throws(() => engine.bindSource(ruleId, { sourceId: DEMO_SOURCE_ID }, { requestId: 'bind' }), { code: 'PRICE_BASIS_REQUIRED' });
  const s = setup([sourceEvent(1)]);
  assert.throws(() => s.engine.receiveEvent(ruleId, demoEvent()), { code: 'SOURCE_CONTRACT_REQUIRED' });
  assert.throws(() => s.engine.receiveSourceEvent(ruleId, sourceEvent(1)), { code: 'SOURCE_NOT_CONNECTED' });
});

for (const point of ['after_source_receive', 'before_source_commit', 'after_source_commit']) {
  test(`SIGKILL at ${point}: another process recovers a coherent cursor and replays without loss or duplication`, t => {
    const f = fixture(t), source = sourceJob([sourceEvent(1)]);
    const stopped = run(f, { initialize: true, source, faultPoint: point, actions: [...initial(), drain()] }, 'SIGKILL');
    assert.equal(stopped.crashPoint, point);
    const saved = run(f, { actions: [state(), rule()] });
    const committed = point === 'after_source_commit';
    assert.equal(saved.results[0].cursor, committed ? 1 : 0);
    assert.equal(saved.results[0].connected, false);
    assert.equal(saved.results[1].pendingOperationId, committed ? opId : null);
    assert.equal(calls(f), 0);
    if (committed) {
      const withoutHandshake = run(f, { actions: [command('executePrepared', opId, { requestId: 'before-handshake' })] });
      assert.equal(withoutHandshake.results[0].error, 'SOURCE_NOT_CONNECTED');
      assert.equal(calls(f), 0);
    }
    const recovered = run(f, { source, actions: [drain(), state(), operation(), rule()] });
    assert.equal(recovered.results[1].cursor, 1);
    assert.equal(recovered.results[2].status, 'succeeded');
    assert.equal(recovered.results[3].operationIds.length, 1);
    assert.equal(calls(f), 1);
    const replayed = run(f, { source: { ...source, replay: [1] }, actions: [drain(), state()] });
    assert.equal(replayed.results[0].deliveries[0].duplicate, true);
    assert.equal(replayed.results[1].cursor, 1);
    assert.equal(replayed.simulatorCalls, 0);
    assert.equal(calls(f), 1);
  });
}

test('restart replays unknown operations without clearing their block or resubmitting', t => {
  const f = fixture(t), source = sourceJob([sourceEvent(1), sourceEvent(2)]);
  run(f, { initialize: true, source, faultPoint: 'after_handoff', actions: [...initial(), drain()] }, 'SIGKILL');
  const result = run(f, { source: { ...source, replay: [1] }, actions: [drain(), state(), rule(), operation()] });
  assert.equal(result.results[0].deliveries[0].duplicate, true);
  assert.equal(result.results[1].cursor, 2);
  assert.equal(result.results[2].state, 'paused');
  assert.equal(result.results[3].status, 'unknown');
  assert.equal(calls(f), 1);
  assert.equal(result.simulatorCalls, 0);
});

test('history-loss decision survives process restart even when a later source offers the full log', t => {
  const f = fixture(t), source = sourceJob([high(1), sourceEvent(2), sourceEvent(3)]);
  run(f, { initialize: true, source, killAfterActions: true, actions: [...initial(), drain({ maxEvents: 1 })] }, 'SIGKILL');
  const lost = run(f, { source: { ...source, retainedFrom: 3 }, actions: [drain(), state(), rule()] });
  assert.equal(lost.results[0].status, 'decision_required');
  assert.equal(lost.results[1].issue.reason, 'history_unavailable');
  assert.equal(lost.results[1].cursor, 1);
  assert.equal(lost.results[2].state, 'paused');
  const later = run(f, { source, actions: [command('sourceReconnect'), drain(),
    command('enable', ruleId, { requestId: 'try-resume' }), state(), rule()] });
  assert.equal(later.results[0].status, 'connected');
  assert.equal(later.results[0].executionBlocked, true);
  assert.equal(later.results[1].status, 'decision_required');
  assert.equal(later.results[2].error, 'SOURCE_DECISION_REQUIRED');
  assert.equal(later.results[3].cursor, 1);
  assert.equal(later.results[4].state, 'paused');
  assert.equal(calls(f), 0);
});

test('a failed source snapshot saves neither cursor nor intent, and blocks this engine', t => {
  const f = fixture(t), source = sourceJob([sourceEvent(1)]);
  run(f, { initialize: true, actions: initial() });
  const db = new DatabaseSync(f.storagePath);
  db.exec(`CREATE TRIGGER fail_source BEFORE UPDATE ON snapshot
    WHEN json_extract(NEW.payload, '$.streams[0][1].cursor') = 1
    BEGIN SELECT RAISE(ABORT, 'synthetic source write failure'); END;`);
  db.close();
  const attempted = run(f, { source, actions: [drain(), state()] });
  assert(attempted.results.every(r => r.error === 'STORAGE_UNAVAILABLE'));
  const reopened = new DatabaseSync(f.storagePath);
  const saved = JSON.parse(reopened.prepare('SELECT payload FROM snapshot').get().payload);
  assert.equal(saved.streams[0][1].cursor, 0);
  assert.equal(saved.operations.length, 0);
  assert.equal(saved.events.length, 0);
  reopened.exec('DROP TRIGGER fail_source'); reopened.close();
  const recovered = run(f, { source, actions: [drain(), state(), operation()] });
  assert.equal(recovered.results[1].cursor, 1);
  assert.equal(recovered.results[2].status, 'succeeded');
  assert.equal(calls(f), 1);
});

test('v1 SQLite history is upgraded without losing rules, command identity or an existing outcome', t => {
  const f = fixture(t);
  const savedOutcome = run(f, { initialize: true, actions: [command('createRule', demoRule(), { requestId: 'legacy-create' }),
    command('enable', ruleId, { requestId: 'legacy-enable' }), command('receiveEvent', ruleId, demoEvent()),
    command('executePrepared', opId, { requestId: 'legacy-execute' }),
  ] }).results[3];
  const db = new DatabaseSync(f.storagePath);
  const saved = JSON.parse(db.prepare('SELECT payload FROM snapshot').get().payload);
  saved.version = 1; delete saved.streams; delete saved.nextIncident; delete saved.sourceDecisions; delete saved.positions; delete saved.telegram;
  const payload = JSON.stringify(saved), digest = createHash('sha256').update(payload).digest('hex');
  db.prepare('UPDATE snapshot SET payload=?, sha256=?').run(payload, digest); db.close();
  const reopened = run(f, { actions: [command('createRule', demoRule(), { requestId: 'legacy-create' }), rule(),
    command('executePrepared', opId, { requestId: 'legacy-execute' }),
  ] });
  assert.equal(reopened.results[0].action, 'created');
  assert.equal(reopened.results[1].state, 'finished');
  assert.deepEqual(reopened.results[2], savedOutcome);
  assert.equal(reopened.simulatorCalls, 0);
  assert.equal(calls(f), 1);
  const inspected = new DatabaseSync(f.storagePath);
  const upgraded = JSON.parse(inspected.prepare('SELECT payload FROM snapshot').get().payload);
  assert.equal(upgraded.version, 5); assert.deepEqual(upgraded.streams, []);
  inspected.close();
});

test('occurrence-time ordering survives restart and an older new event cannot trigger a purchase', t => {
  const f = fixture(t), source = sourceJob([high(1), sourceEvent(2, { occurredAtMs: DEMO_START_MS - 1 }), sourceEvent(3)]);
  run(f, { initialize: true, source, actions: [...initial(), drain({ maxEvents: 1 })], killAfterActions: true }, 'SIGKILL');
  const older = run(f, { source, actions: [drain({ maxEvents: 1 }), state(), rule()] });
  assert.equal(older.results[0].deliveries[0].disposition, 'ignored_out_of_order');
  assert.equal(older.results[1].cursor, 2);
  assert.equal(older.results[1].lastOccurredAtMs, DEMO_START_MS);
  assert.equal(older.results[2].operationIds.length, 0);
  assert.equal(calls(f), 0);
  const latest = run(f, { source, actions: [drain(), state(), operation()] });
  assert.equal(latest.results[1].cursor, 3);
  assert.equal(latest.results[2].status, 'succeeded');
  assert.equal(calls(f), 1);
});
