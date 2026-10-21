import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { RuleEngine } from './rule-engine.mjs';
import { SimulatedExecutor } from './simulator.mjs';
import { demoRule, demoEvent, DEMO_START_MS } from './fixtures.mjs';

const worker = fileURLToPath(new URL('./test-support/process-worker.mjs', import.meta.url));
const ruleId = 'demo-rule-1', operationId = 'demo-operation-1';
const action = (method, ...args) => ({ method, args });
const create = () => action('createRule', demoRule(), { requestId: 'create' });
const enable = (requestId = 'enable') => action('enable', ruleId, { requestId });
const receive = (e = demoEvent()) => action('receiveEvent', ruleId, e);
const execute = (requestId = 'execute', id = operationId) => action('executePrepared', id, { requestId });
const inspectRule = () => action('getRule', ruleId);
const inspectOperation = () => action('getOperation', operationId);
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rule-persistence-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const storagePath = join(directory, 'state.sqlite'), tracePath = join(directory, 'handoffs.ndjson');
  const calls = () => {
    try { return readFileSync(tracePath, 'utf8').trim().split('\n').filter(Boolean).length; }
    catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  };
  return { directory, storagePath, tracePath, calls };
}
function run(f, job = {}, { signal = null, status = 0 } = {}) {
  const child = spawnSync(process.execPath, [worker, JSON.stringify({ storagePath: f.storagePath, tracePath: f.tracePath, ...job })],
    { encoding: 'utf8', timeout: 10_000 });
  assert.ifError(child.error);
  assert.equal(child.signal, signal, child.stderr || child.stdout);
  if (!signal) assert.equal(child.status, status, child.stderr || child.stdout);
  const result = JSON.parse(child.stdout.trim());
  return result;
}
function kill(f, job) { return run(f, job, { signal: 'SIGKILL' }); }

for (const state of ['draft', 'active', 'paused', 'revoked']) {
  test(`acknowledged ${state} and command fingerprints survive SIGKILL and another process`, t => {
    const f = fixture(t), actions = [create()];
    if (state !== 'draft') actions.push(enable());
    if (state === 'paused') actions.push(action('pause', ruleId, { requestId: 'pause' }));
    if (state === 'revoked') actions.push(action('revoke', ruleId, { requestId: 'revoke' }));
    const stopped = kill(f, { initialize: true, actions, killAfterActions: true });
    assert(stopped.results.every(result => !result.error));
    const recovered = run(f, { actions: [create(), ...actions.slice(1), inspectRule(),
      action('createRule', { ...demoRule(), amountUnits: 9 }, { requestId: 'create' }),
      ...(state === 'revoked' ? [enable('new-enable')] : []),
    ] });
    assert.equal(recovered.results[actions.length].state, state);
    assert.equal(recovered.results[actions.length + 1].error, 'IDEMPOTENCY_CONFLICT');
    if (state === 'revoked') assert.equal(recovered.results.at(-1).error, 'INVALID_TRANSITION');
    assert.equal(f.calls(), 0);
  });
}

for (const outcome of ['succeeded', 'failed', 'unknown', 'throw']) {
  test(`persisted ${outcome} result and repeated requests survive a killed process without another handoff`, t => {
    const f = fixture(t);
    const stopped = kill(f, { initialize: true, outcome, killAfterActions: true, actions: [create(), enable(), receive(), execute()] });
    const saved = stopped.results[3];
    assert.equal(saved.status, outcome === 'throw' ? 'unknown' : outcome);
    const recovered = run(f, { actions: [execute(), execute('different-request'), receive(),
      receive({ ...demoEvent(), priceUnits: 94 }), enable(), enable('new-enable'), inspectRule(), inspectOperation(),
      action('handleEvent', ruleId, demoEvent()),
    ] });
    assert.deepEqual(recovered.results[0], saved);
    assert.deepEqual(recovered.results[1], saved);
    assert.equal(recovered.results[2].operationId, operationId);
    assert.equal(recovered.results[2].duplicate, true);
    assert.equal(recovered.results[3].error, 'EVENT_ID_CONFLICT');
    assert.equal(recovered.results[5].error, 'ATTEMPT_ALREADY_SUBMITTED');
    assert.equal(recovered.results[6].state, ['succeeded', 'failed'].includes(outcome) ? 'finished' : 'paused');
    assert.deepEqual(recovered.results[7], saved);
    assert.deepEqual(recovered.results[8].operation, saved);
    assert.equal(recovered.simulatorCalls, 0);
    assert.equal(f.calls(), 1);
  });
}

test('crash after prepared commit leaves a safe unsubmitted intent; duplicate event shares its ID', t => {
  const f = fixture(t);
  const stopped = kill(f, { initialize: true, faultPoint: 'after_prepared_commit', actions: [create(), enable(), receive()] });
  assert.equal(stopped.crashPoint, 'after_prepared_commit');
  assert.equal(f.calls(), 0);
  const readOnlyRecovery = run(f, { actions: [inspectOperation(), inspectRule()] });
  assert.equal(readOnlyRecovery.results[0].status, 'prepared');
  assert.equal(readOnlyRecovery.results[1].pendingOperationId, operationId);
  assert.equal(f.calls(), 0); // Opening a history never dispatches anything by itself.
  const resumed = run(f, { actions: [receive(), execute()] });
  assert.equal(resumed.results[0].operationId, operationId);
  assert.equal(resumed.results[0].duplicate, true);
  assert.equal(resumed.results[1].status, 'succeeded');
  assert.equal(f.calls(), 1);
});

for (const [point, previousCalls] of [['after_dispatch_commit', 0], ['after_handoff', 1], ['before_result_commit', 1]]) {
  test(`SIGKILL at ${point}: unresolved handoff recovers as unknown and never resubmits`, t => {
    const f = fixture(t);
    const stopped = kill(f, { initialize: true, faultPoint: point, actions: [create(), enable(), receive(), execute()] });
    assert.equal(stopped.crashPoint, point);
    assert.equal(f.calls(), previousCalls);
    const recovered = run(f, { actions: [inspectRule(), inspectOperation(), execute(), execute('retry'), receive(), enable('new-enable'),
      action('handleEvent', ruleId, demoEvent()),
    ] });
    assert.equal(recovered.results[0].state, 'paused');
    assert.equal(recovered.results[0].submittedOperationId, operationId);
    assert.equal(recovered.results[1].status, 'unknown');
    assert.equal(recovered.results[1].result.reason, 'recovered_unresolved_handoff');
    assert.equal(recovered.results[2].status, 'unknown');
    assert.equal(recovered.results[3].status, 'unknown');
    assert.equal(recovered.results[4].operationId, operationId);
    assert.equal(recovered.results[5].error, 'ATTEMPT_ALREADY_SUBMITTED');
    assert.equal(recovered.results[6].operation.status, 'unknown');
    assert.equal(recovered.simulatorCalls, 0);
    const again = run(f, { actions: [inspectOperation(), execute()] });
    assert.deepEqual(again.results[0], recovered.results[1]);
    assert.equal(again.simulatorCalls, 0);
    assert.equal(f.calls(), previousCalls);
  });
}

test('crash after result commit but before reply preserves success without a second handoff', t => {
  const f = fixture(t);
  const stopped = kill(f, { initialize: true, faultPoint: 'after_result_commit', actions: [create(), enable(), receive(), execute()] });
  assert.equal(stopped.crashPoint, 'after_result_commit');
  const recovered = run(f, { actions: [execute(), inspectRule()] });
  assert.equal(recovered.results[0].status, 'succeeded');
  assert.equal(recovered.results[1].state, 'finished');
  assert.equal(f.calls(), 1);
});

test('recovery checks exact expiry, cancels prepared work and cannot replay old enable', t => {
  const f = fixture(t);
  kill(f, { initialize: true, killAfterActions: true, actions: [create(), enable(), receive()] });
  const recovered = run(f, { now: DEMO_START_MS + 1_000, actions: [inspectRule(), inspectOperation(), enable(), execute(), receive(), enable('new-enable')] });
  assert.equal(recovered.results[0].state, 'expired');
  assert.equal(recovered.results[1].status, 'cancelled');
  assert.equal(recovered.results[1].reason, 'rule_expired');
  assert.equal(recovered.results[3].status, 'cancelled');
  assert.equal(recovered.results[5].error, 'INVALID_TRANSITION');
  assert.equal(f.calls(), 0);
  assert.equal(run(f, { actions: [inspectRule()] }).results[0].state, 'expired');
});

test('freshness is checked again after a restart before the prepared intent can be dispatched', t => {
  const f = fixture(t);
  kill(f, { initialize: true, killAfterActions: true, actions: [create(), enable(), receive()] });
  const recovered = run(f, { now: DEMO_START_MS + 101, actions: [execute(), receive(),
    receive(demoEvent('fresh', DEMO_START_MS + 101)), execute('fresh-execute', 'demo-operation-2'),
  ] });
  assert.equal(recovered.results[0].reason, 'event_became_stale');
  assert.equal(recovered.results[1].duplicate, true);
  assert.equal(recovered.results[2].operationId, 'demo-operation-2');
  assert.equal(recovered.results[3].status, 'succeeded');
  assert.equal(f.calls(), 1);
});

for (const state of ['paused', 'revoked', 'expired']) {
  test(`a killed in-flight operation becomes unknown while preserving ${state} rule semantics`, t => {
    const f = fixture(t);
    const actions = [create(), enable(), receive(), action('submitWithoutWaiting', operationId, { requestId: 'execute' })];
    if (state === 'expired') actions.push(action('setNow', DEMO_START_MS + 1_000), action('tick'));
    else actions.push(action(state === 'revoked' ? 'revoke' : 'pause', ruleId, { requestId: 'stop' }));
    kill(f, { initialize: true, hold: true, killAfterActions: true, actions });
    const recovered = run(f, { actions: [inspectRule(), execute(), enable('new-enable'), inspectRule()] });
    assert.equal(recovered.results[0].state, state);
    assert.equal(recovered.results[1].status, 'unknown');
    assert.equal(recovered.results[2].error, 'ATTEMPT_ALREADY_SUBMITTED');
    assert.equal(recovered.results[3].state, state);
    assert.equal(f.calls(), 1);
  });
}

test('expiry during downtime preserves uncertainty instead of declaring an in-flight attempt cancelled', t => {
  const f = fixture(t);
  kill(f, { initialize: true, faultPoint: 'after_handoff', actions: [create(), enable(), receive(), execute()] });
  const recovered = run(f, { now: DEMO_START_MS + 1_000, actions: [inspectRule(), inspectOperation(), execute()] });
  assert.equal(recovered.results[0].state, 'expired');
  assert.equal(recovered.results[1].status, 'unknown');
  assert.equal(recovered.results[2].status, 'unknown');
  assert.equal(f.calls(), 1);
});

test('operation counter and ignored-event fingerprints survive restart', t => {
  const f = fixture(t);
  kill(f, { initialize: true, killAfterActions: true, actions: [create(), receive(demoEvent('ignored')), enable(), receive(), execute()] });
  const config = demoRule('second-rule');
  const recovered = run(f, { actions: [receive(demoEvent('ignored')),
    action('createRule', config, { requestId: 'second-create' }),
    action('enable', config.id, { requestId: 'second-enable' }),
    action('receiveEvent', config.id, demoEvent()),
  ] });
  assert.equal(recovered.results[0].disposition, 'ignored_inactive');
  assert.equal(recovered.results[0].duplicate, true);
  assert.equal(recovered.results[3].operationId, 'demo-operation-2');
  assert.equal(f.calls(), 1);
});

test('absent, empty, corrupt or non-file storage never opens as a new history', t => {
  const f = fixture(t);
  for (const content of [null, '', 'not a sqlite database']) {
    rmSync(f.storagePath, { force: true });
    if (content !== null) writeFileSync(f.storagePath, content);
    const result = run(f, { actions: [create(), enable(), receive(), execute()] }, { status: 2 });
    assert.equal(result.error, content === '' ? 'STORAGE_INVALID' : 'STORAGE_UNAVAILABLE');
  }
  rmSync(f.storagePath);
  mkdirSync(f.storagePath);
  assert.equal(run(f, {}, { status: 2 }).error, 'STORAGE_UNAVAILABLE');
  assert.equal(f.calls(), 0);
});

test('initialization is explicit and cannot overwrite an existing history', t => {
  const f = fixture(t);
  run(f, { initialize: true, actions: [create(), action('revoke', ruleId, { requestId: 'revoke' })] });
  assert.equal(run(f, { initialize: true }, { status: 2 }).error, 'STORAGE_ALREADY_EXISTS');
  assert.equal(run(f, { actions: [inspectRule()] }).results[0].state, 'revoked');
});

for (const damage of ['checksum', 'version', 'counter', 'missing-row']) {
  test(`invalid saved history (${damage}) fails closed rather than resetting counters or rules`, t => {
    const f = fixture(t);
    run(f, { initialize: true, actions: [create(), enable(), receive(), execute()] });
    const db = new DatabaseSync(f.storagePath);
    if (damage === 'missing-row') db.exec('DELETE FROM snapshot');
    else {
      const row = db.prepare('SELECT payload FROM snapshot WHERE id=1').get();
      const state = JSON.parse(row.payload);
      if (damage === 'version') state.version = 999;
      if (damage === 'counter') state.nextOperation = 1;
      const payload = JSON.stringify(state);
      const checksum = damage === 'checksum' ? 'invalid-checksum' : createHash('sha256').update(payload).digest('hex');
      db.prepare('UPDATE snapshot SET payload=?, sha256=?').run(payload, checksum);
    }
    db.close();
    const recovered = run(f, { actions: [create(), enable(), receive(), execute()] }, { status: 2 });
    assert(['STORAGE_INVALID', 'STORAGE_UNAVAILABLE'].includes(recovered.error));
    assert.equal(f.calls(), 1);
  });
}

test('failed snapshot write does not acknowledge enable and poisons the running engine', t => {
  const f = fixture(t);
  run(f, { initialize: true, actions: [create()] });
  const db = new DatabaseSync(f.storagePath);
  db.exec(`CREATE TRIGGER fail_active_snapshot BEFORE UPDATE ON snapshot
    WHEN json_extract(NEW.payload, '$.rules[0][1].state') = 'active'
    BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END;`);
  db.close();
  const attempt = run(f, { actions: [enable(), receive(), inspectRule()] });
  assert(attempt.results.every(result => result.error === 'STORAGE_UNAVAILABLE'));
  assert.equal(attempt.simulatorCalls, 0);
  const recovered = run(f, { actions: [inspectRule()] });
  assert.equal(recovered.results[0].state, 'draft');
  assert.equal(f.calls(), 0);
});

for (const failureAt of ['submitted', 'succeeded']) {
  test(`a failed ${failureAt} snapshot cannot acknowledge or silently retry an execution`, t => {
    const f = fixture(t);
    run(f, { initialize: true, actions: [create(), enable(), receive()] });
    const db = new DatabaseSync(f.storagePath);
    db.exec(`CREATE TRIGGER fail_operation_snapshot BEFORE UPDATE ON snapshot
      WHEN json_extract(NEW.payload, '$.operations[0][1].status') = '${failureAt}'
      BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END;`);
    db.close();
    const attempt = run(f, { actions: [execute(), inspectRule()] });
    assert(attempt.results.every(result => result.error === 'STORAGE_UNAVAILABLE'));
    assert.equal(attempt.simulatorCalls, failureAt === 'submitted' ? 0 : 1);
    const recovered = run(f, { actions: [inspectOperation(), inspectRule()] });
    assert.equal(recovered.results[0].status, failureAt === 'submitted' ? 'prepared' : 'unknown');
    assert.equal(recovered.results[1].state, failureAt === 'submitted' ? 'active' : 'paused');
    assert.equal(recovered.simulatorCalls, 0);
    assert.equal(f.calls(), failureAt === 'submitted' ? 0 : 1);
  });
}

for (const [advance, expectedState, expectedReason] of [[101, 'active', 'event_became_stale'], [1_000, 'expired', 'rule_expired']]) {
  test(`eligibility is checked after durable dispatch recording when time advances by ${advance}ms`, async t => {
    const f = fixture(t), simulator = new SimulatedExecutor();
    let now = DEMO_START_MS;
    const engine = RuleEngine.initialize({ storagePath: f.storagePath, executor: simulator, clock: () => now,
      faultInjector: point => { if (point === 'after_dispatch_commit') now += advance; },
    });
    engine.createRule(demoRule(), { requestId: 'create' });
    engine.enable(ruleId, { requestId: 'enable' });
    engine.receiveEvent(ruleId, demoEvent());
    const result = await engine.executePrepared(operationId, { requestId: 'execute' });
    assert.equal(result.status, 'cancelled');
    assert.equal(result.reason, expectedReason);
    assert.equal(simulator.callCount, 0);
    engine.close();
    const recovered = run(f, { now, actions: [inspectOperation(), inspectRule(), execute()] });
    assert.equal(recovered.results[0].status, 'cancelled');
    assert.equal(recovered.results[1].state, expectedState);
    assert.equal(recovered.results[1].submittedOperationId, null);
    assert.equal(recovered.simulatorCalls, 0);
  });
}

test('replacing an open storage file stops the engine before a handoff', t => {
  const f = fixture(t), simulator = new SimulatedExecutor();
  const engine = RuleEngine.initialize({ storagePath: f.storagePath, executor: simulator, clock: () => DEMO_START_MS });
  engine.createRule(demoRule(), { requestId: 'create' });
  engine.enable(ruleId, { requestId: 'enable' });
  engine.receiveEvent(ruleId, demoEvent());
  renameSync(f.storagePath, join(f.directory, 'moved.sqlite'));
  writeFileSync(f.storagePath, 'replacement');
  assert.throws(() => engine.executePrepared(operationId, { requestId: 'execute' }), { code: 'STORAGE_UNAVAILABLE' });
  assert.throws(() => engine.getRule(ruleId), { code: 'STORAGE_UNAVAILABLE' });
  assert.equal(simulator.callCount, 0);
  engine.close();
});

test('a second live process cannot open the store; SIGKILL releases the OS lock for recovery', { timeout: 10_000 }, async t => {
  const f = fixture(t);
  const first = spawn(process.execPath, [worker, JSON.stringify({ storagePath: f.storagePath, initialize: true,
    stayAlive: true, actions: [create(), enable()] })], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (first.exitCode === null && first.signalCode === null) first.kill('SIGKILL'); });
  let stdout = '';
  await new Promise((resolve, reject) => {
    first.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes('\n')) resolve(); });
    first.once('error', reject);
    first.once('exit', () => reject(new Error(`Lock holder exited before readiness: ${stdout}`)));
  });
  assert.equal(JSON.parse(stdout.trim()).results[1].action, 'enabled');
  const second = run(f, { actions: [receive(), execute()] }, { status: 2 });
  assert.equal(second.error, 'STORAGE_BUSY');
  const exited = once(first, 'exit');
  first.kill('SIGKILL');
  const [, signal] = await exited;
  assert.equal(signal, 'SIGKILL');
  const recovered = run(f, { actions: [inspectRule(), receive(), execute()] });
  assert.equal(recovered.results[0].state, 'active');
  assert.equal(recovered.results[2].status, 'succeeded');
  assert.equal(f.calls(), 1);
});
