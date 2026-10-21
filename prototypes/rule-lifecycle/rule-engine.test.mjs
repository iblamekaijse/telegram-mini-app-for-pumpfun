import test from 'node:test';
import assert from 'node:assert/strict';
import { RuleEngine, RuleError, LIVE_TRADING_ALLOWED } from './rule-engine.mjs';
import { SimulatedExecutor } from './simulator.mjs';
import { demoRule, demoEvent, DEMO_START_MS } from './fixtures.mjs';

function setup(options = {}) {
  let now = DEMO_START_MS;
  const simulator = new SimulatedExecutor(options);
  const engine = new RuleEngine({ clock: () => now, executor: simulator });
  const config = demoRule();
  engine.createRule(config, { requestId: 'create' });
  const enable = (id = 'enable') => engine.enable(config.id, { requestId: id });
  const event = (id = 'event', priceUnits = 95) => ({ ...demoEvent(id, now), priceUnits });
  const receive = (e = event()) => engine.receiveEvent(config.id, e);
  const execute = (id, requestId = 'execute') => engine.executePrepared(id, { requestId });
  return { engine, simulator, config, enable, event, receive, execute, advance: ms => { now += ms; } };
}
function rejectsCode(action, code) {
  assert.throws(action, error => error instanceof RuleError && error.code === code);
}

test('invalid rule parameters cannot create an executable rule', () => {
  const corruptions = [
    c => { c.assetId = 'not-a-demo-asset'; }, c => { c.amountUnits = 0; },
    c => { c.amountUnits = 0.1; }, c => { c.amountUnits = Number.MAX_SAFE_INTEGER + 1; },
    c => { c.condition.operator = 'unknown'; }, c => { c.condition.thresholdUnits = NaN; },
    c => { c.limits.maxTotalSpendUnits = 9; }, c => { c.limits.minReceiveUnits = 0; },
    c => { c.limits.maxFeeUnits = -1; }, c => { c.limits.maxSlippageBps = 10_001; },
    c => { c.limits.maxEventAgeMs = 0; }, c => { c.expiresAtMs = DEMO_START_MS; },
  ];
  for (const [index, corrupt] of corruptions.entries()) {
    const simulator = new SimulatedExecutor();
    const engine = new RuleEngine({ clock: () => DEMO_START_MS, executor: simulator });
    const config = demoRule(); corrupt(config);
    assert.throws(() => engine.createRule(config, { requestId: `invalid-${index}` }), RuleError);
    rejectsCode(() => engine.enable(config.id, { requestId: 'enable' }), 'RULE_NOT_FOUND');
    assert.equal(simulator.callCount, 0);
  }
});

test('draft and unmet condition do not submit; matching event executes the fixed demo intent', async () => {
  const s = setup();
  assert.equal(s.receive(s.event('draft')).disposition, 'ignored_inactive');
  s.enable();
  assert.equal(s.receive(s.event('high', 101)).disposition, 'condition_not_met');
  assert.equal(s.simulator.callCount, 0);
  const { operationId } = s.receive(s.event('matching', 100));
  assert.equal(s.engine.getOperation(operationId).status, 'prepared');
  const result = await s.execute(operationId);
  assert.equal(result.status, 'succeeded');
  assert.equal(s.engine.getRule(s.config.id).state, 'finished');
  assert.equal(s.simulator.callCount, 1);
  assert.equal(s.simulator.requests[0].side, 'buy');
  assert.deepEqual(s.simulator.requests[0].limits, s.config.limits);
  assert.equal(s.simulator.requests[0].amountUnits, 10);
});

test('duplicate creation and commands are idempotent; request ID reuse with different content is rejected', () => {
  const s = setup();
  const reordered = Object.fromEntries(Object.entries(s.config).reverse());
  s.engine.createRule(reordered, { requestId: 'create' });
  s.enable(); s.enable();
  rejectsCode(() => s.engine.createRule({ ...s.config, amountUnits: 9 }, { requestId: 'create' }), 'IDEMPOTENCY_CONFLICT');
  rejectsCode(() => s.engine.pause(s.config.id, { requestId: 'enable' }), 'IDEMPOTENCY_CONFLICT');
  assert.equal(s.engine.getRule(s.config.id).state, 'active');
  assert.equal(s.simulator.callCount, 0);
});

test('duplicate event delivery and competing matching events reserve one operation', async () => {
  const s = setup(); s.enable();
  const first = s.receive();
  assert.equal(s.receive().operationId, first.operationId);
  assert.equal(s.receive(s.event('other-event')).disposition, 'ignored_reserved');
  await s.execute(first.operationId);
  assert.equal(s.receive().duplicate, true);
  assert.equal(s.engine.getRule(s.config.id).operationIds.length, 1);
  assert.equal(s.simulator.callCount, 1);
});

test('reusing an event ID with changed data is rejected', () => {
  const s = setup(); s.enable(); s.receive();
  rejectsCode(() => s.receive(s.event('event', 94)), 'EVENT_ID_CONFLICT');
  assert.equal(s.simulator.callCount, 0);
});

test('parallel execution requests with same or distinct request IDs share one in-flight operation', async () => {
  const s = setup({ hold: true }); s.enable();
  const { operationId } = s.receive();
  const first = s.execute(operationId);
  const replay = s.execute(operationId);
  const another = s.execute(operationId, 'another-request');
  assert.strictEqual(first, replay); assert.strictEqual(first, another);
  assert.equal(s.simulator.callCount, 1);
  assert.equal(s.receive(s.event('while-pending')).disposition, 'ignored_reserved');
  s.simulator.completeNext();
  const results = await Promise.all([first, replay, another]);
  assert(results.every(r => r.status === 'succeeded'));
  await s.execute(operationId, 'after-success');
  assert.equal(s.simulator.callCount, 1);
});

test('wrong asset, stale and future events are ignored without invoking simulator', () => {
  const s = setup(); s.enable();
  assert.equal(s.receive({ ...s.event('wrong'), assetId: 'DEMO:ASSET-B' }).disposition, 'ignored_asset');
  assert.equal(s.receive({ ...s.event('stale'), observedAtMs: DEMO_START_MS - 101 }).disposition, 'ignored_stale');
  assert.equal(s.receive({ ...s.event('future'), observedAtMs: DEMO_START_MS + 1 }).disposition, 'ignored_future');
  assert.equal(s.simulator.callCount, 0);
  assert.equal(s.engine.getRule(s.config.id).operationIds.length, 0);
});

test('freshness is checked again immediately before handoff; only a new fresh event can prepare again', async () => {
  const s = setup(); s.enable();
  const oldEvent = s.event();
  const { operationId } = s.receive(oldEvent); s.advance(101);
  assert.equal((await s.execute(operationId)).reason, 'event_became_stale');
  assert.equal(s.simulator.callCount, 0);
  assert.equal(s.receive(oldEvent).duplicate, true);
  const fresh = s.receive(s.event('fresh'));
  await s.execute(fresh.operationId, 'fresh-request');
  assert.equal(s.simulator.callCount, 1);
});

test('enabled rule processes a synthetic event end to end, including duplicate simultaneous deliveries', async () => {
  const s = setup({ hold: true }); s.enable(); const event = s.event();
  const first = s.engine.handleEvent(s.config.id, event);
  const duplicate = s.engine.handleEvent(s.config.id, event);
  assert.equal(s.simulator.callCount, 1);
  s.simulator.completeNext();
  const [a, b] = await Promise.all([first, duplicate]);
  assert.equal(a.operation.status, 'succeeded'); assert.equal(b.operation.id, a.operation.id);
  const next = await s.engine.handleEvent(s.config.id, s.event('later-match'));
  assert.equal(next.operation, null); assert.equal(s.simulator.callCount, 1);
});

for (const action of ['pause', 'revoke', 'expire']) {
  test(`${action} between preparation and handoff blocks the queued operation`, async () => {
    const s = setup(); s.enable(); const { operationId } = s.receive();
    if (action === 'expire') s.advance(1_000);
    else s.engine[action](s.config.id, { requestId: action });
    const operation = await s.execute(operationId);
    assert.equal(operation.status, 'cancelled');
    assert.equal(s.simulator.callCount, 0);
    assert.equal(s.receive(s.event('after-stop')).disposition, 'ignored_inactive');
    assert.equal(s.engine.getRule(s.config.id).state, { pause: 'paused', revoke: 'revoked', expire: 'expired' }[action]);
  });
}

test('resume after pause requires a new event and cannot replay a cancelled operation', async () => {
  const s = setup(); s.enable(); const oldEvent = s.event(); const old = s.receive(oldEvent);
  s.engine.pause(s.config.id, { requestId: 'pause' });
  s.enable('resume');
  await s.execute(old.operationId);
  assert.equal(s.receive(oldEvent).duplicate, true);
  assert.equal(s.simulator.callCount, 0);
  const next = s.receive(s.event('new-after-resume'));
  await s.execute(next.operationId, 'new-execute');
  assert.equal(s.simulator.callCount, 1);
});

for (const action of ['pause', 'revoke', 'expire']) {
  test(`${action} after handoff does not pretend the operation was cancelled`, async () => {
    const s = setup({ hold: true }); s.enable(); const { operationId } = s.receive();
    const pending = s.execute(operationId);
    if (action === 'expire') { s.advance(1_000); s.engine.tick(); }
    else s.engine[action](s.config.id, { requestId: action });
    assert.equal(s.engine.getOperation(operationId).status, 'submitted');
    assert.equal(s.receive(s.event('new-in-flight')).disposition, 'ignored_inactive');
    s.simulator.completeNext(); assert.equal((await pending).status, 'succeeded');
    assert.equal(s.engine.getRule(s.config.id).state, action === 'pause' ? 'finished' : action === 'expire' ? 'expired' : 'revoked');
    assert.equal(s.simulator.callCount, 1);
  });
}

test('expiry is enforced on the exact deadline without a background timer; revoke is permanent', () => {
  for (const action of ['expire', 'revoke']) {
    const s = setup(); s.enable();
    if (action === 'expire') s.advance(1_000);
    else s.engine.revoke(s.config.id, { requestId: 'revoke' });
    rejectsCode(() => s.enable('new-enable'), 'INVALID_TRANSITION');
    // Replaying a prior successful acknowledgement must not reactivate the rule.
    s.enable('enable');
    assert.equal(s.receive(s.event('post-terminal')).disposition, 'ignored_inactive');
    assert.equal(s.simulator.callCount, 0);
  }
});

for (const outcome of ['failed', 'unknown', 'throw']) {
  test(`${outcome} cannot automatically or manually resubmit the one-shot attempt`, async () => {
    const s = setup({ outcome }); s.enable(); const { operationId } = s.receive();
    const result = await s.execute(operationId);
    const expected = outcome === 'failed' ? 'failed' : 'unknown';
    assert.equal(result.status, expected);
    assert.equal(s.engine.getRule(s.config.id).state, expected === 'failed' ? 'finished' : 'paused');
    await s.execute(operationId, 'repeat-request');
    rejectsCode(() => s.enable('try-reenable'), 'ATTEMPT_ALREADY_SUBMITTED');
    assert.equal(s.receive(s.event('next-event')).disposition, 'ignored_inactive');
    assert.equal(s.simulator.callCount, 1);
  });
}

test('successful completion consumes the rule even with a new request ID and event', async () => {
  const s = setup(); s.enable(); const { operationId } = s.receive();
  await s.execute(operationId); await s.execute(operationId, 'repeat');
  rejectsCode(() => s.enable('reenable'), 'ATTEMPT_ALREADY_SUBMITTED');
  s.receive(s.event('next-match')); assert.equal(s.simulator.callCount, 1);
});

test('simulation enforces amount, total spend, fees, min receipt and slippage using test units', async () => {
  const cases = [
    { spentUnits: 9 }, { feeUnits: 2 }, { receivedUnits: 3 }, { slippageBps: 51 },
  ];
  for (const receipt of cases) {
    const s = setup({ receipt }); s.enable(); const { operationId } = s.receive();
    const result = await s.execute(operationId);
    assert.equal(result.status, 'failed'); assert.equal(result.reason, 'synthetic_limits_exceeded');
    assert.equal(s.simulator.callCount, 1);
    await s.execute(operationId, 'repeat'); assert.equal(s.simulator.callCount, 1);
  }
  const s = setup({ receipt: { feeUnits: 1, receivedUnits: 4, slippageBps: 50 } });
  s.enable(); const { operationId } = s.receive();
  assert.equal((await s.execute(operationId)).status, 'succeeded');
});

test('total spend ceiling is enforced even when the fee separately fits its ceiling', async () => {
  const simulator = new SimulatedExecutor({ receipt: { feeUnits: 1 } });
  const engine = new RuleEngine({ clock: () => DEMO_START_MS, executor: simulator });
  const config = demoRule(); config.limits.maxTotalSpendUnits = 10;
  engine.createRule(config, { requestId: 'create' }); engine.enable(config.id, { requestId: 'enable' });
  const { operation } = await engine.handleEvent(config.id, demoEvent());
  assert.equal(operation.status, 'failed');
  assert.equal(operation.reason, 'synthetic_limits_exceeded');
  assert.equal(simulator.callCount, 1);
});

test('late unknown result preserves permanent revocation and cannot trigger another purchase', async () => {
  const s = setup({ hold: true, outcome: 'unknown' }); s.enable();
  const { operationId } = s.receive(); const pending = s.execute(operationId);
  s.engine.revoke(s.config.id, { requestId: 'revoke' });
  assert.equal(s.engine.getOperation(operationId).status, 'submitted');
  s.simulator.completeNext(); assert.equal((await pending).status, 'unknown');
  assert.equal(s.engine.getRule(s.config.id).state, 'revoked');
  await s.execute(operationId, 'retry'); s.receive(s.event('another-event'));
  assert.equal(s.simulator.callCount, 1);
});

test('saved parameters cannot be changed through caller objects or returned snapshots', async () => {
  const s = setup(); s.config.amountUnits = 999; s.config.limits.minReceiveUnits = 1;
  const view = s.engine.getRule(s.config.id);
  assert.throws(() => { view.config.limits.minReceiveUnits = 0; }, TypeError);
  s.enable(); const { operationId } = s.receive(); await s.execute(operationId);
  assert.equal(s.simulator.requests[0].amountUnits, 10);
  assert.equal(s.simulator.requests[0].limits.minReceiveUnits, 4);
});

test('live mode and non-simulator adapters are unavailable', () => {
  assert.equal(LIVE_TRADING_ALLOWED, false);
  rejectsCode(() => new RuleEngine({ mode: 'live' }), 'LIVE_TRADING_CLOSED');
  rejectsCode(() => new RuleEngine({ executor: { submit() { throw new Error('Must never be called'); } } }), 'SIMULATOR_REQUIRED');
});
