import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { streamRule, sourceEvent, DEMO_SOURCE_ID, DEMO_PRICE_BASIS, DEMO_START_MS } from './fixtures.mjs';

const directory = mkdtempSync(join(tmpdir(), 'owner-decision-demo-'));
const worker = fileURLToPath(new URL('./test-support/process-worker.mjs', import.meta.url));
const ruleId = 'demo-rule-1', opId = 'demo-operation-1';
const action = (method, ...args) => ({ method, args });
const state = () => action('getSourceState', ruleId), rule = () => action('getRule', ruleId);
const owner = { ruleIds: [ruleId], principalId: 'DEMO:trusted-local-owner' };
const high = sourceEvent(1, { payload: { ...DEMO_PRICE_BASIS, priceUnits: 200 } });
const sourceJob = events => ({ sourceId: DEMO_SOURCE_ID, events });
const choose = (incidentId, decision, requestId) => action('ownerDecision',
  { incidentId, decision, acknowledgeHistoryLoss: decision === 'accept_gap' }, { requestId });
function run(storagePath, job) {
  const child = spawnSync(process.execPath, [worker, JSON.stringify({ storagePath, ...job })], { encoding: 'utf8', timeout: 10_000 });
  assert.ifError(child.error); assert.equal(child.status, 0, child.stdout || child.stderr);
  return JSON.parse(child.stdout.trim());
}
function seed(storagePath, events, outcome = 'succeeded') {
  const source = sourceJob(events);
  const active = run(storagePath, { initialize: true, source, outcome, actions: [
    action('createRule', streamRule(), { requestId: 'create' }),
    action('bindSource', ruleId, { sourceId: DEMO_SOURCE_ID }, { requestId: 'bind' }),
    action('enable', ruleId, { requestId: 'enable' }), rule(),
    action('sourceDrain', { maxEvents: 1 }),
  ] });
  assert.equal(active.results[3].state, 'active');
  const lost = run(storagePath, { source: { ...source, retainedFrom: 3 }, actions: [action('sourceDrain'), state(), rule()] });
  assert.equal(lost.results[0].status, 'decision_required');
  return { source, incidentId: lost.results[1].issue.id, callsBeforeLoss: active.simulatorCalls };
}
console.log('DEMO ONLY: доверенный локальный контекст владельца; ownerId из запроса не является авторизацией.');
console.log('SQLite + синтетический источник + имитатор. Реальная торговля ЗАКРЫТА.');
try {
  const storage = join(directory, 'owner.sqlite'), events = [high, sourceEvent(2), sourceEvent(3)];
  const { source, incidentId } = seed(storage, events);
  console.log(JSON.stringify({ stage: 'active_then_history_loss', incidentId, rule: 'paused', continuity: 'decision_required' }));
  const unsupported = run(storage, { source, trustedDemoOwner: owner, actions: [choose(incidentId, 'accept_gap', 'accept'), state()] });
  assert.equal(unsupported.results[0].outcome, 'gap_acceptance_unsupported');
  assert.equal(unsupported.results[1].cursor, 1);
  console.log(JSON.stringify({ stage: 'explicit_gap_acceptance_unavailable', outcome: unsupported.results[0].outcome, cursor: 1, executionBlocked: true }));
  const resolved = run(storage, { source, trustedDemoOwner: owner, actions: [choose(incidentId, 'retry_history', 'recover'), rule(), state()] });
  assert.equal(resolved.results[0].outcome, 'history_verified');
  assert.equal(resolved.results[1].state, 'paused');
  assert.equal(resolved.simulatorCalls, 0);
  console.log(JSON.stringify({ stage: 'owner_verified_history', cursor: resolved.results[2].cursor,
    rule: resolved.results[1].state, continuity: resolved.results[2].continuity, backlogSimulatorCalls: 0 }));
  const fresh = run(storage, { now: DEMO_START_MS + 10,
    source: sourceJob([...events, sourceEvent(4, { occurredAtMs: DEMO_START_MS + 10 })]), actions: [
      action('enable', ruleId, { requestId: 'explicit-enable-after-recovery' }), action('sourceDrain'), rule(),
    ] });
  assert.equal(fresh.simulatorCalls, 1);
  assert.equal(fresh.results[2].state, 'finished');
  console.log(JSON.stringify({ stage: 'explicit_enable_then_fresh_event', rule: fresh.results[2].state, simulatorCalls: 1 }));

  const uncertainStorage = join(directory, 'unknown.sqlite');
  const uncertain = seed(uncertainStorage, [sourceEvent(1), sourceEvent(2), sourceEvent(3)], 'unknown');
  const stillBlocked = run(uncertainStorage, { source: uncertain.source, trustedDemoOwner: owner, actions: [
    choose(uncertain.incidentId, 'retry_history', 'recover-unknown-stream'),
    action('enable', ruleId, { requestId: 'cannot-repeat-unknown' }), action('getOperation', opId), state(),
  ] });
  assert.equal(stillBlocked.results[0].continuity, 'continuous');
  assert.equal(stillBlocked.results[1].error, 'ATTEMPT_ALREADY_SUBMITTED');
  assert.equal(stillBlocked.results[2].status, 'unknown');
  assert.equal(stillBlocked.simulatorCalls, 0);
  console.log(JSON.stringify({ stage: 'history_recovered_unknown_stays', continuity: 'continuous', operation: 'unknown',
    enableError: stillBlocked.results[1].error, newSimulatorCalls: 0 }));
  const newIssue = run(uncertainStorage, { actions: [action('reportSourceIssue', ruleId, 'position_gap'), state()] }).results[1].issue.id;
  const revoked = run(uncertainStorage, { source: uncertain.source, trustedDemoOwner: owner, actions: [
    choose(newIssue, 'revoke', 'owner-final-revoke'), rule(), action('getOperation', opId), state(),
  ] });
  assert.equal(revoked.results[1].state, 'revoked');
  assert.equal(revoked.results[2].status, 'unknown');
  assert.equal(revoked.results[3].continuity, 'stopped');
  console.log(JSON.stringify({ stage: 'final_owner_revocation', rule: 'revoked', continuity: 'stopped', operation: 'unknown', newSimulatorCalls: 0 }));
} finally { rmSync(directory, { recursive: true, force: true }); }
