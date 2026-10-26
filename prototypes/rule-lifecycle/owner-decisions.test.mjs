import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { RuleEngine } from './rule-engine.mjs';
import { SimulatedExecutor } from './simulator.mjs';
import { SyntheticSource } from './synthetic-source.mjs';
import { SourceConsumer } from './source-consumer.mjs';
import { createTrustedDemoOwnerContext } from './demo-owner.mjs';
import { streamRule, sourceEvent, DEMO_SOURCE_ID, DEMO_START_MS, DEMO_PRICE_BASIS } from './fixtures.mjs';

const ruleId = 'demo-rule-1', opId = 'demo-operation-1';
const high = n => sourceEvent(n, { payload: { ...DEMO_PRICE_BASIS, priceUnits: 200 } });
const fullLog = [high(1), sourceEvent(2), sourceEvent(3)];
const makeSource = (events = fullLog) => new SyntheticSource({ sourceId: DEMO_SOURCE_ID, events });
function setup({ outcome = 'succeeded', events = fullLog } = {}) {
  let now = DEMO_START_MS;
  const simulator = new SimulatedExecutor({ outcome });
  const engine = new RuleEngine({ executor: simulator, clock: () => now });
  engine.createRule(streamRule(), { requestId: 'create' });
  engine.bindSource(ruleId, { sourceId: DEMO_SOURCE_ID }, { requestId: 'bind' });
  engine.enable(ruleId, { requestId: 'enable' });
  const source = makeSource(events);
  const consumer = new SourceConsumer({ engine, source, ruleId });
  const ownerContext = createTrustedDemoOwnerContext({ ruleIds: [ruleId] });
  const gap = () => { engine.reportSourceIssue(ruleId, 'history_unavailable', { retainedFrom: 3 }); return engine.getSourceState(ruleId).issue.id; };
  const decide = (incidentId, decision, requestId = decision, recoverySource = source, extra = {}) => engine.decideSourceIssue(ruleId,
    { incidentId, decision, ...extra }, { requestId, ownerContext, source: recoverySource });
  return { engine, simulator, source, consumer, ownerContext, gap, decide, advance: ms => { now += ms; } };
}

test('owner revocation stops the incident permanently and preserves all prior rule parameters and operations', async () => {
  const s = setup(); s.consumer.reconnect();
  s.engine.receiveSourceEvent(ruleId, high(1));
  s.engine.receiveSourceEvent(ruleId, sourceEvent(2));
  const incidentId = s.gap(), oldOperation = s.engine.getOperation(opId), config = s.engine.getRule(ruleId).config;
  const result = s.decide(incidentId, 'revoke');
  assert.equal(result.outcome, 'rule_revoked');
  assert.equal(s.engine.getRule(ruleId).state, 'revoked');
  assert.equal(s.engine.getSourceState(ruleId).continuity, 'stopped');
  assert.deepEqual(s.engine.getOperation(opId), oldOperation);
  assert.deepEqual(s.engine.getRule(ruleId).config, config);
  assert.deepEqual(s.decide(incidentId, 'revoke'), result);
  assert.equal(s.engine.getSourceDecisionLog(ruleId).length, 1);
  assert.equal((await s.consumer.drain()).status, 'stopped');
  assert.throws(() => s.engine.enable(ruleId, { requestId: 'enable-again' }), { code: 'INVALID_TRANSITION' });
  assert.equal(s.simulator.callCount, 0);
});

test('retry records an unavailable attempt; same key cannot change its meaning after history becomes available', () => {
  const s = setup(), incidentId = s.gap();
  s.source.pruneBefore(3);
  const failed = s.decide(incidentId, 'retry_history', 'retry-1');
  assert.equal(failed.outcome, 'history_unavailable');
  const full = makeSource();
  assert.deepEqual(s.decide(incidentId, 'retry_history', 'retry-1', full), failed);
  assert.equal(s.engine.getSourceState(ruleId).continuity, 'decision_required');
  assert.equal(s.engine.getSourceDecisionLog(ruleId).length, 1);
  const succeeded = s.decide(incidentId, 'retry_history', 'retry-2', full);
  assert.equal(succeeded.outcome, 'history_verified');
  assert.equal(s.engine.getSourceDecisionLog(ruleId).length, 2);
});

test('verified recovery consumes backlog without a purchase, requires enable, and rejects accumulated pre-decision prices', async () => {
  const s = setup();
  await s.consumer.drain({ maxEvents: 1 });
  const incidentId = s.gap();
  const result = s.decide(incidentId, 'retry_history');
  assert.equal(result.cursor, 3);
  assert.equal(result.continuity, 'continuous');
  assert.equal(result.ruleState, 'paused');
  assert.equal(s.engine.getSourceState(ruleId).connected, false);
  assert.equal(s.engine.getRule(ruleId).operationIds.length, 0);
  assert.equal(s.simulator.callCount, 0);
  s.advance(10);
  s.engine.enable(ruleId, { requestId: 'explicit-enable' });
  const newSource = makeSource([...fullLog, sourceEvent(4), sourceEvent(5, { occurredAtMs: DEMO_START_MS + 10 })]);
  const consumer = new SourceConsumer({ engine: s.engine, source: newSource, ruleId });
  const drained = await consumer.drain();
  assert.equal(drained.deliveries[0].disposition, 'ignored_before_resolution');
  assert.equal(drained.deliveries[1].disposition, 'prepared');
  assert.equal(s.simulator.callCount, 1);
  assert.equal(s.engine.getOperation(opId).event.sourceEvent.position, 5);
});

test('full recovery checks already processed facts and rejects a conflicting prefix', async () => {
  const s = setup(); await s.consumer.drain({ maxEvents: 1 });
  const incidentId = s.gap();
  const differentHistory = makeSource([sourceEvent(1), sourceEvent(2), sourceEvent(3)]);
  assert.equal(s.decide(incidentId, 'retry_history', 'bad-prefix', differentHistory).outcome, 'verification_failed');
  assert.equal(s.engine.getSourceState(ruleId).cursor, 1);
  assert.equal(s.engine.getSourceState(ruleId).issue.id, incidentId);
  assert.equal(s.simulator.callCount, 0);
});

test('plain ownerId, cloned contexts and grants for another rule are not authorization', () => {
  const s = setup(), incidentId = s.gap();
  for (const ownerContext of [{ ownerId: 'DEMO:owner' }, structuredClone(s.ownerContext),
    createTrustedDemoOwnerContext({ ruleIds: ['another-rule'] })]) {
    assert.throws(() => s.engine.decideSourceIssue(ruleId, { incidentId, decision: 'revoke' }, { requestId: 'unauthorized', ownerContext }), { code: 'DEMO_OWNER_AUTH_REQUIRED' });
  }
  assert.equal(s.engine.getSourceDecisionLog(ruleId).length, 0);
  assert.equal(s.engine.getRule(ruleId).state, 'paused');
  assert.throws(() => s.engine.revoke(ruleId, { requestId: 'legacy-revoke' }), { code: 'INCIDENT_DECISION_REQUIRED' });
});

test('duplicate old decision cannot clear a new incident; stale decisions and command-key conflicts are rejected', () => {
  const s = setup(), firstId = s.gap();
  const first = s.decide(firstId, 'retry_history', 'owner-1');
  const secondId = s.gap();
  assert.notEqual(secondId, firstId);
  assert.deepEqual(s.decide(firstId, 'retry_history', 'owner-1'), first);
  assert.equal(s.engine.getSourceState(ruleId).issue.id, secondId);
  assert.equal(s.engine.getSourceState(ruleId).continuity, 'decision_required');
  assert.throws(() => s.decide(firstId, 'revoke', 'old-case-new-key'), { code: 'STALE_SOURCE_INCIDENT' });
  assert.throws(() => s.decide(secondId, 'revoke', 'owner-1'), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(s.engine.getSourceDecisionLog(ruleId).length, 1);
});

test('a decision for one rule cannot resolve the current incident of another even with a grant for both', () => {
  const s = setup(), firstId = s.gap();
  const other = 'other-rule';
  s.engine.createRule(streamRule(other), { requestId: 'other-create' });
  s.engine.bindSource(other, { sourceId: DEMO_SOURCE_ID }, { requestId: 'other-bind' });
  s.engine.enable(other, { requestId: 'other-enable' });
  s.engine.reportSourceIssue(other, 'position_gap');
  const ownerContext = createTrustedDemoOwnerContext({ ruleIds: [ruleId, other] });
  assert.throws(() => s.engine.decideSourceIssue(other, { incidentId: firstId, decision: 'revoke' }, { requestId: 'cross-rule', ownerContext }), { code: 'STALE_SOURCE_INCIDENT' });
  assert.equal(s.engine.getSourceState(other).continuity, 'decision_required');
});

test('verification cannot clear a newer incident introduced before it returns', () => {
  const s = setup(), oldId = s.gap();
  let newerId;
  class ReentrantSyntheticSource extends SyntheticSource {
    readRecoveryHistory() {
      const snapshot = super.readRecoveryHistory();
      s.decide(oldId, 'retry_history', 'completed-first', makeSource());
      newerId = s.gap();
      return snapshot;
    }
  }
  const source = new ReentrantSyntheticSource({ sourceId: DEMO_SOURCE_ID, events: fullLog });
  assert.throws(() => s.decide(oldId, 'retry_history', 'late-decision', source), { code: 'STALE_SOURCE_INCIDENT' });
  assert.equal(s.engine.getSourceState(ruleId).issue.id, newerId);
  assert.equal(s.engine.getSourceState(ruleId).continuity, 'decision_required');
  assert.equal(s.engine.getSourceDecisionLog(ruleId).length, 1);
});

test('acknowledging a lost gap is explicitly unsupported and never changes the cursor or permissions', () => {
  const s = setup(), incidentId = s.gap(), before = s.engine.getSourceState(ruleId);
  assert.throws(() => s.decide(incidentId, 'accept_gap', 'missing-ack'), { code: 'HISTORY_LOSS_ACK_REQUIRED' });
  const unsupported = s.decide(incidentId, 'accept_gap', 'accept', s.source, { acknowledgeHistoryLoss: true });
  assert.equal(unsupported.outcome, 'gap_acceptance_unsupported');
  assert(unsupported.details.missingContract);
  assert.deepEqual(s.engine.getSourceState(ruleId), before);
  assert.deepEqual(s.decide(incidentId, 'accept_gap', 'accept', s.source, { acknowledgeHistoryLoss: true }), unsupported);
  assert.equal(s.engine.getSourceDecisionLog(ruleId).length, 1);
  assert.equal(s.simulator.callCount, 0);
});

for (const decision of ['retry_history', 'revoke', 'accept_gap']) {
  test(`${decision} cannot clear unknown or reset the consumed attempt and configured limits`, async () => {
    const events = [sourceEvent(1), sourceEvent(2), sourceEvent(3)];
    const s = setup({ outcome: 'unknown', events });
    await s.consumer.drain({ maxEvents: 1 });
    const old = s.engine.getOperation(opId), config = s.engine.getRule(ruleId).config;
    const incidentId = s.gap();
    const result = s.decide(incidentId, decision, 'resolve', s.source, { acknowledgeHistoryLoss: decision === 'accept_gap' });
    assert.deepEqual(s.engine.getOperation(opId), old);
    assert.deepEqual(s.engine.getRule(ruleId).config, config);
    assert.equal(s.engine.getRule(ruleId).submittedOperationId, opId);
    if (decision === 'retry_history') assert.equal(result.continuity, 'continuous');
    else assert.equal(result.continuity, decision === 'revoke' ? 'stopped' : 'decision_required');
    assert.throws(() => s.engine.enable(ruleId, { requestId: 'repeat-buy' }), { code: 'ATTEMPT_ALREADY_SUBMITTED' });
    assert.equal(s.simulator.callCount, 1);
  });
}

test('expiry during history verification is persisted together with the decision and cannot be re-enabled', () => {
  const s = setup(), incidentId = s.gap();
  class SlowSyntheticSource extends SyntheticSource {
    readRecoveryHistory() { const result = super.readRecoveryHistory(); s.advance(1_000); return result; }
  }
  const source = new SlowSyntheticSource({ sourceId: DEMO_SOURCE_ID, events: fullLog });
  const result = s.decide(incidentId, 'retry_history', 'slow', source);
  assert.equal(result.ruleState, 'expired');
  assert.equal(result.continuity, 'continuous');
  assert.equal(s.engine.getSourceDecisionLog(ruleId)[0].after.ruleState, 'expired');
  assert.throws(() => s.engine.enable(ruleId, { requestId: 'late' }), { code: 'INVALID_TRANSITION' });
  assert.equal(s.simulator.callCount, 0);
});

const worker = fileURLToPath(new URL('./test-support/process-worker.mjs', import.meta.url));
const action = (method, ...args) => ({ method, args });
const state = () => action('getSourceState', ruleId), rule = () => action('getRule', ruleId), journal = () => action('getSourceDecisionLog', ruleId);
const sourceJob = events => ({ sourceId: DEMO_SOURCE_ID, events: events ?? fullLog });
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'owner-decision-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { storagePath: join(directory, 'state.sqlite'), tracePath: join(directory, 'calls.ndjson') };
}
function run(f, job, signal = null) {
  const child = spawnSync(process.execPath, [worker, JSON.stringify({ ...f, ...job })], { encoding: 'utf8', timeout: 10_000 });
  assert.ifError(child.error); assert.equal(child.signal, signal, child.stdout || child.stderr);
  if (!signal) assert.equal(child.status, 0, child.stdout || child.stderr);
  return JSON.parse(child.stdout.trim());
}
function seed(f, { unknown = false } = {}) {
  const source = sourceJob(unknown ? [sourceEvent(1), sourceEvent(2), sourceEvent(3)] : fullLog);
  run(f, { initialize: true, outcome: unknown ? 'unknown' : 'succeeded', source, actions: [
    action('createRule', streamRule(), { requestId: 'create' }), action('bindSource', ruleId, { sourceId: DEMO_SOURCE_ID }, { requestId: 'bind' }),
    action('enable', ruleId, { requestId: 'enable' }), action('sourceDrain', { maxEvents: 1 }),
  ] });
  const lost = run(f, { source: { ...source, retainedFrom: 3 }, actions: [action('sourceDrain'), state()] });
  assert.equal(lost.results[0].status, 'decision_required');
  return { source, incidentId: lost.results[1].issue.id };
}
const ownerGrant = { ruleIds: [ruleId] };
const decideAction = (incidentId, decision, requestId = 'owner-choice') => action('ownerDecision',
  { incidentId, decision, acknowledgeHistoryLoss: decision === 'accept_gap' }, { requestId });

for (const decision of ['revoke', 'retry_history', 'accept_gap']) {
  for (const point of ['before_owner_decision_commit', 'inside_owner_decision_transaction', 'after_owner_decision_commit']) {
    test(`SIGKILL ${point} (${decision}): another process sees an atomic journal/state/command and repeats safely`, t => {
      const f = fixture(t), { source, incidentId } = seed(f);
      const stopped = run(f, { source, trustedDemoOwner: ownerGrant, faultPoint: point, actions: [decideAction(incidentId, decision)] }, 'SIGKILL');
      assert.equal(stopped.crashPoint, point);
      const saved = run(f, { actions: [state(), rule(), journal()] });
      const committed = point === 'after_owner_decision_commit';
      assert.equal(saved.results[2].length, committed ? 1 : 0);
      assert.equal(saved.results[0].cursor, committed && decision === 'retry_history' ? 3 : 1);
      assert.equal(saved.results[0].continuity, !committed || decision === 'accept_gap' ? 'decision_required' : decision === 'revoke' ? 'stopped' : 'continuous');
      assert.equal(saved.results[1].state, committed && decision === 'revoke' ? 'revoked' : 'paused');
      const repeated = run(f, { source, trustedDemoOwner: ownerGrant, actions: [decideAction(incidentId, decision), decideAction(incidentId, decision), journal(), state()] });
      assert.deepEqual(repeated.results[0], repeated.results[1]);
      assert.equal(repeated.results[2].length, 1);
      assert.equal(repeated.results[2][0].requestId, 'owner-choice');
      assert.equal(repeated.results[2][0].incidentId, incidentId);
      assert.equal(repeated.simulatorCalls, 0);
      assert.throws(() => readFileSync(f.tracePath), { code: 'ENOENT' });
    });
  }
}

test('a failed decision write persists no journal, command or resolution, then a new process can repeat it', t => {
  const f = fixture(t), { source, incidentId } = seed(f);
  const db = new DatabaseSync(f.storagePath);
  db.exec(`CREATE TRIGGER fail_owner_decision BEFORE UPDATE ON snapshot
    WHEN json_array_length(NEW.payload, '$.sourceDecisions') > 0
    BEGIN SELECT RAISE(ABORT, 'synthetic owner decision failure'); END;`);
  db.close();
  const attempted = run(f, { source, trustedDemoOwner: ownerGrant, actions: [decideAction(incidentId, 'retry_history'), state()] });
  assert(attempted.results.every(r => r.error === 'STORAGE_UNAVAILABLE'));
  const raw = new DatabaseSync(f.storagePath);
  const saved = JSON.parse(raw.prepare('SELECT payload FROM snapshot').get().payload);
  assert.equal(saved.sourceDecisions.length, 0);
  assert(!saved.commands.some(([key]) => key === 'owner-choice'));
  assert.equal(saved.streams[0][1].continuity, 'decision_required');
  assert.equal(saved.streams[0][1].cursor, 1);
  raw.exec('DROP TRIGGER fail_owner_decision'); raw.close();
  const recovered = run(f, { source, trustedDemoOwner: ownerGrant, actions: [decideAction(incidentId, 'retry_history'), journal()] });
  assert.equal(recovered.results[0].outcome, 'history_verified');
  assert.equal(recovered.results[1].length, 1);
});

test('stale incidents and independent unknown block survive restart after stream recovery', t => {
  const f = fixture(t), { source, incidentId } = seed(f, { unknown: true });
  const old = run(f, { actions: [action('getOperation', opId)] }).results[0];
  const resolved = run(f, { source, trustedDemoOwner: ownerGrant, actions: [decideAction(incidentId, 'retry_history'), action('getOperation', opId)] });
  assert.equal(resolved.results[0].continuity, 'continuous');
  assert.deepEqual(resolved.results[1], old);
  const newer = run(f, { actions: [action('reportSourceIssue', ruleId, 'position_gap'), state()] }).results[1].issue.id;
  assert.notEqual(newer, incidentId);
  const repeated = run(f, { source, trustedDemoOwner: ownerGrant, actions: [decideAction(incidentId, 'retry_history'),
    decideAction(incidentId, 'retry_history', 'stale-new-key'), state(), action('enable', ruleId, { requestId: 'buy-again' }),
    action('getOperation', opId), journal(),
  ] });
  assert.equal(repeated.results[1].error, 'STALE_SOURCE_INCIDENT');
  assert.equal(repeated.results[2].issue.id, newer);
  assert.equal(repeated.results[2].continuity, 'decision_required');
  assert.equal(repeated.results[3].error, 'ATTEMPT_ALREADY_SUBMITTED');
  assert.deepEqual(repeated.results[4], old);
  assert.equal(repeated.results[5].length, 1);
  assert.equal(repeated.simulatorCalls, 0);
  assert.equal(readFileSync(f.tracePath, 'utf8').trim().split('\n').length, 1);
});

test('v2 migration assigns a stable incident ID without losing unknown, cursor or command identity', t => {
  const f = fixture(t), { source } = seed(f, { unknown: true });
  const raw = new DatabaseSync(f.storagePath);
  const saved = JSON.parse(raw.prepare('SELECT payload FROM snapshot').get().payload);
  saved.version = 2; delete saved.nextIncident; delete saved.sourceDecisions; delete saved.positions; delete saved.telegram;
  for (const [, stream] of saved.streams) {
    delete stream.freshAfterMs; delete stream.issue.id; delete stream.issue.ruleId;
  }
  const payload = JSON.stringify(saved), checksum = createHash('sha256').update(payload).digest('hex');
  raw.prepare('UPDATE snapshot SET payload=?, sha256=?').run(payload, checksum); raw.close();
  const migrated = run(f, { actions: [state(), action('getOperation', opId)] });
  const incidentId = migrated.results[0].issue.id;
  assert.equal(migrated.results[0].cursor, 1);
  assert.equal(migrated.results[1].status, 'unknown');
  const again = run(f, { source, trustedDemoOwner: ownerGrant, actions: [state(), decideAction(incidentId, 'retry_history'),
    action('executePrepared', opId, { requestId: 'source:demo-operation-1' }),
  ] });
  assert.equal(again.results[0].issue.id, incidentId);
  assert.equal(again.results[1].continuity, 'continuous');
  assert.equal(again.results[2].status, 'unknown');
  assert.equal(again.simulatorCalls, 0);
});
