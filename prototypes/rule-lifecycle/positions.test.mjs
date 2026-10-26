import { emptyTelegramState } from './telegram-state.mjs';
// OFFLINE: saved provider response shape with explicitly TEST prices; temporary SQLite only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createPanelService } from './web/panel-service.mjs';
import { positionValues, formatRational } from './position-model.mjs';
import { POLL_MS, STALE_MS } from './web/market-source.mjs';
import { canonical } from './event-contract.mjs';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/dexscreener-pumpswap.json', import.meta.url)));
const mint = fixture[0].baseToken.address;
function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 'virtual-positions-'));
  t.after(() => rmSync(root, { recursive: true, force: true })); return join(root, 'data');
}
const body = (requestId = 'position-create-0001') => ({ requestId, mode: 'market-paper', scenario: 'virtual-position', mint,
  threshold: '100', amount: '1000', expiresInMinutes: 1, takeProfit: '10', stopLoss: '10' });
async function setup(t, { enter = true } = {}) {
  const dataDir = directory(t); let now = 100_000, priceUsd = '120', fail = false, slow = false;
  const options = { dataDir, clock: () => now, marketFetch: async () => {
    if (fail) throw new Error('OFFLINE outage'); if (slow) now += STALE_MS + 1;
    return new Response(JSON.stringify([{ ...fixture[0], priceUsd }]));
  } };
  let service = await createPanelService(options), closed = false;
  t.after(() => { if (!closed) service.close(); });
  await service.selectMarket({ mint }); const id = service.create(body()).currentRuleId;
  service.command(id, 'enable', { requestId: 'position-enable-0001' });
  const ctx = { dataDir, options, id, get service() { return service; },
    async poll(price, advance = POLL_MS) { now += advance; if (price !== undefined) priceUsd = price; return service.pollMarket(); },
    fail(value) { fail = value; }, slow(value) { slow = value; }, detach() { service.close(); closed = true; },
    async reopen() { service.close(); now++; service = await createPanelService(options); return service.state(); },
  };
  if (enter) await ctx.poll('100'); return ctx;
}
const pos = s => s.positions[0];
const code = expected => ({ code: expected });

test('exact arithmetic: TEST 1000 / 100 = 10; 110 => +100/+10%; 90 => -100/-10%; thirds stay rational', () => {
  const policy = { takeProfitBps: 1000, stopLossBps: 1000 };
  for (const [exit, pnl, pct] of [[110, '100', '10'], [90, '-100', '-10']]) {
    const v = positionValues(1000e9, 100e9, exit * 1e9, policy);
    assert.equal(formatRational(v.quantity), '10'); assert.equal(formatRational(v.pnlUsd), pnl); assert.equal(formatRational(v.pnlPercent), pct);
  }
  const thirds = positionValues(1e9, 3e9, 4e9, policy);
  assert.deepEqual(thirds.quantity, { n: '1', d: '3' }); assert.deepEqual(thirds.pnlUsd, { n: '1', d: '3' });
  assert.equal(formatRational(thirds.quantity, 12), '0.333333333333');
});
test('entry requires a new qualifying observation; cannot close on entry, reopen rule, switch source or create second position', async t => {
  const c = await setup(t, { enter: false });
  assert.equal(c.service.state().positions.length, 0); await c.poll('120'); assert.equal(c.service.state().positions.length, 0);
  await c.poll('100'); const s = c.service.state();
  assert.equal(s.rules[0].state, 'finished'); assert.equal(pos(s).status, 'open'); assert.equal(pos(s).display.quantity, '10');
  assert.equal(pos(s).observations.length, 0); assert.equal(pos(s).exit, null);
  assert.equal(c.service.create(body()).rules.length, 1);
  assert.throws(() => c.service.create(body('position-second-0001')), code('POSITION_ALREADY_OPEN'));
  await assert.rejects(c.service.selectMarket({ mint }), code('POSITION_ALREADY_OPEN'));
  assert.throws(() => c.service.command(c.id, 'enable', { requestId: 'enable-entry-again' }), code('ATTEMPT_ALREADY_SUBMITTED'));
});
for (const [price, reason, pnl, percent] of [['110', 'take_profit', '100', '10'], ['90', 'stop_loss', '-100', '-10'], ['125', 'take_profit', '250', '25'], ['75', 'stop_loss', '-250', '-25']]) {
  test(`${reason}: observed ${price}, not threshold; saved result and next cycle preserve history`, async t => {
    const c = await setup(t); await c.poll(price); const closed = pos(c.service.state());
    assert.equal(closed.status, 'closed'); assert.equal(closed.exit.reason, reason); assert.equal(closed.display.price, price);
    assert.equal(closed.display.pnlUsd, pnl); assert.equal(closed.display.pnlPercent, percent);
    assert.deepEqual(pos(await c.reopen()), closed); await c.service.pollMarket();
    const next = body('position-create-0002'); c.service.create(next); c.service.create(next);
    assert.equal(c.service.state().rules.length, 2); assert.equal(c.service.state().positions.length, 1);
    assert.deepEqual(pos(c.service.state()), closed);
    c.service.command(c.service.state().currentRuleId, 'enable', { requestId: 'enable-second-0001' }); await c.poll('100');
    assert.equal(c.service.state().positions.length, 2); assert.equal(c.service.state().positions[1].status, 'open');
  });
}
test('manual request is durable/idempotent and cannot close from cached price; restart waits for a new snapshot', async t => {
  const c = await setup(t), id = pos(c.service.state()).id, command = { requestId: 'manual-position-close' };
  const first = c.service.closePosition(id, command); c.service.closePosition(id, command);
  c.service.closePosition(id, { requestId: 'manual-position-close2' });
  assert.deepEqual(pos(c.service.state()).closeRequest, pos(first).closeRequest);
  await c.service.pollMarket(); assert.equal(pos(c.service.state()).status, 'close_requested');
  const restored = await c.reopen(); assert.equal(pos(restored).status, 'close_requested'); assert.equal(pos(restored).valuationAvailable, false);
  c.service.closePosition(id, command); await c.service.pollMarket();
  assert.equal(pos(c.service.state()).exit.reason, 'user_request'); assert.equal(pos(c.service.state()).display.pnlUsd, '0');
  c.service.closePosition(id, command);
  assert.throws(() => c.service.closePosition(id, { requestId: 'manual-after-closed' }), code('POSITION_ALREADY_CLOSED'));
});
test('entry expiry does not expire position; outage and stale responses cannot value/close; recovery uses observed new price', async t => {
  const c = await setup(t); await c.poll('105', 60_000);
  assert.equal(pos(c.service.state()).status, 'open'); assert.equal(pos(c.service.state()).display.pnlUsd, '50');
  c.fail(true); await c.poll('200'); assert.equal(pos(c.service.state()).valuationAvailable, false); assert.equal(pos(c.service.state()).exit, null);
  c.service.closePosition(pos(c.service.state()).id, { requestId: 'outage-manual-close' });
  await c.poll('200', 120_000); assert.equal(pos(c.service.state()).status, 'close_requested');
  c.fail(false); c.slow(true); await c.poll('200', 120_000);
  assert.equal(pos(c.service.state()).status, 'close_requested'); assert.equal(pos(c.service.state()).valuationAvailable, false);
  c.slow(false); await c.poll('107', 120_000);
  assert.equal(pos(c.service.state()).exit.reason, 'user_request'); assert.equal(pos(c.service.state()).display.pnlUsd, '70');
});
test('expired waiting rule cannot enter; invalid percentages are rejected', async t => {
  const c = await setup(t, { enter: false }); await c.poll('100', 60_000);
  assert.equal(c.service.state().rules[0].state, 'expired'); assert.equal(c.service.state().positions.length, 0);
  const next = body('position-invalid-0001'); next.stopLoss = '100';
  assert.throws(() => c.service.create(next), e => !!e.fields?.stopLoss); next.stopLoss = '10'; next.takeProfit = '0';
  assert.throws(() => c.service.create(next), e => !!e.fields?.takeProfit);
});
function worker(job) {
  return spawnSync(process.execPath, ['test-support/position-worker.mjs', JSON.stringify(job)], { cwd: new URL('.', import.meta.url), encoding: 'utf8' });
}
function run(job) { const r = worker(job); assert.equal(r.status, 0, r.stderr + r.stdout); return JSON.parse(r.stdout); }
for (const point of ['before_result_commit', 'after_result_commit']) {
  test(`SIGKILL ${point}: separate process restores entry and position consistently, unknown cannot retry`, async t => {
    const c = await setup(t), s = c.service.state(), storagePath = join(directory(t), '..', 'state.sqlite');
    const config = { ...s.rules[0].config, id: 'crash-entry-rule', expiresAtMs: 1_000_000 };
    const crash = worker({ storagePath, initialize: true, now: 110_000, config, entry: pos(s).entry, faultPoint: point, action: 'enter' });
    assert.equal(crash.signal, 'SIGKILL', crash.stderr);
    const recovered = run({ storagePath, now: 120_000, action: 'inspect' });
    assert.equal(recovered.positions.length, point === 'after_result_commit' ? 1 : 0);
    assert.equal(recovered.rules[0].state, point === 'after_result_commit' ? 'finished' : 'paused');
    assert.equal(recovered.operations[0].status, point === 'after_result_commit' ? 'succeeded' : 'unknown');
    if (point === 'before_result_commit') {
      const again = run({ storagePath, now: 130_000, action: 'retry' });
      assert.equal(again.positions.length, 0); assert.equal(again.operations[0].status, 'unknown');
    }
  });
}
for (const point of ['before_position_commit', 'inside_position_transaction', 'after_position_commit']) {
  test(`SIGKILL ${point}: exit and observation atomic; separate-process replay does not duplicate exit`, async t => {
    const c = await setup(t), entry = pos(c.service.state()).entry; c.detach();
    const storagePath = join(c.dataDir, 'state.sqlite'), event = { ...entry, id: 'test-exit-observation', observedAtMs: 120_000, receivedAtMs: 120_000, rawPriceUsd: '125', priceUnits: 125e9 };
    const crash = worker({ storagePath, now: 120_000, action: 'snapshot', event, faultPoint: point });
    assert.equal(crash.signal, 'SIGKILL', crash.stderr);
    const recovered = run({ storagePath, now: 120_000, action: 'inspect' });
    assert.equal(recovered.positions[0].status, point === 'after_position_commit' ? 'closed' : 'open');
    const replay = run({ storagePath, now: 120_000, action: 'snapshot', event });
    assert.equal(replay.positions[0].status, 'closed'); assert.equal(replay.positions[0].exit.values.pnlUsd.n, '250');
    assert.equal(replay.positions[0].observations.length, 1);
    assert.equal(run({ storagePath, now: 130_000, action: 'snapshot', event }).positions[0].observations.length, 1);
  });
}
test('replay of entry, stale/future/out-of-order observations and other pool/mint cannot exit', async t => {
  const c = await setup(t), entry = pos(c.service.state()).entry; c.detach(); const storagePath = join(c.dataDir, 'state.sqlite');
  const replay = run({ storagePath, now: 120_000, action: 'snapshot', event: entry });
  assert.equal(replay.positions[0].status, 'open'); assert.equal(replay.positions[0].observations.length, 0);
  for (const [id, observedAtMs, receivedAtMs, now] of [['stale', 120_000, 120_000, 200_000], ['future', 210_000, 210_000, 200_000], ['older', 109_000, 109_000, 120_000]]) {
    assert.equal(run({ storagePath, now, action: 'snapshot', event: { ...entry, id, observedAtMs, receivedAtMs, rawPriceUsd: '110', priceUnits: 110e9 } }).positions[0].status, 'open');
  }
  for (const change of [{ pairAddress: mint }, { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', assetId: 'SOLANA:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }]) {
    const r = worker({ storagePath, now: 220_000, action: 'snapshot', event: { ...entry, id: 'different-binding', observedAtMs: 220_000, receivedAtMs: 220_000, ...change } });
    assert.equal(r.status, 1); assert.match(r.stderr, /MARKET_BINDING_MISMATCH/);
  }
});
test('v3 SQLite migrates losslessly without converting legacy rules into positions', async t => {
  const c = await setup(t, { enter: false }); c.service.command(c.id, 'revoke', { requestId: 'legacy-final-revoke' }); c.detach();
  const storagePath = join(c.dataDir, 'state.sqlite'), db = new DatabaseSync(storagePath);
  const saved = JSON.parse(db.prepare('SELECT payload FROM snapshot').get().payload); saved.version = 3; delete saved.positions; delete saved.telegram;
  delete saved.rules[0][1].config.position; delete saved.rules[0][1].config.panel.input.position;
  const create = saved.commands.find(([, c]) => JSON.parse(c.fingerprint).action === 'create')[1];
  const command = JSON.parse(create.fingerprint); delete command.config.position; delete command.config.panel.input.position; create.fingerprint = canonical(command);
  const payload = JSON.stringify(saved); db.prepare('UPDATE snapshot SET payload=?,sha256=?').run(payload, createHash('sha256').update(payload).digest('hex')); db.close();
  const restored = await createPanelService(c.options); assert.equal(restored.state().rules[0].state, 'revoked'); assert.deepEqual(restored.state().positions, []); restored.close();
  const raw = new DatabaseSync(storagePath), upgraded = JSON.parse(raw.prepare('SELECT payload FROM snapshot').get().payload); raw.close();
  assert.deepEqual(upgraded, { ...saved, version: 7, positions: [], telegram: emptyTelegramState() });
});

test('explicit condition-only scenario never creates a position, even with TP/SL form values present', async t => {
  const c = await setup(t, { enter: false });
  c.service.command(c.id, 'revoke', { requestId: 'revoke-before-legacy' });
  const input = { ...body('condition-only-0001'), scenario: 'condition-only' };
  const created = c.service.create(input), id = created.currentRuleId;
  assert.equal(created.rules[1].config.position, undefined);
  c.service.command(id, 'enable', { requestId: 'enable-condition-only' });
  await c.poll('100');
  assert.equal(c.service.state().rules[1].state, 'finished');
  assert.deepEqual(c.service.state().positions, []);
});

test('open position loses valuation when observations age out without a new successful poll', async t => {
  const c = await setup(t);
  c.fail(true); await c.poll(undefined, STALE_MS + 1);
  assert.equal(c.service.state().market.stale, true);
  assert.equal(pos(c.service.state()).valuationAvailable, false);
  assert.equal(pos(c.service.state()).status, 'open');
});
