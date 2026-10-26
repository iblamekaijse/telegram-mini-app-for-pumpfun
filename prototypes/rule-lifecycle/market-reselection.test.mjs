// OFFLINE regression scenarios: actual source/service, saved public HTTP fields.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MarketSnapshots, POLL_MS, STALE_MS } from './web/market-source.mjs';
import { createPanelService } from './web/panel-service.mjs';
import { RuleEngine } from './rule-engine.mjs';
import { SimulatedExecutor } from './simulator.mjs';
import { MARKET_PRICE_BASIS, WSOL_MINT, decimalUnits } from './market-contract.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/dexscreener-pumpswap.json', import.meta.url)));
const mint = fixture[0].baseToken.address, pairAddress = fixture[0].pairAddress;
const otherMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const reply = (payload = fixture, status = 200, headers = {}) => new Response(JSON.stringify(payload), { status, headers });
const body = requestId => ({ requestId, mode: 'market-paper', mint, threshold: '1.00', amount: '10.00', expiresInMinutes: 1 });
function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 'market-reselection-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'data');
}

test('same mint within cooldown retains the exact usable snapshot and pinned pool without HTTP or re-delivery', async () => {
  let now = 100_000, calls = 0;
  const feed = new MarketSnapshots({ clock: () => now, fetchImpl: async () => { calls++; return reply(); } });
  await feed.select(mint);
  const first = feed.state();
  now += 1000;
  for (let i = 0; i < 3; i++) {
    const result = await feed.select(mint), selected = feed.state();
    assert.equal(result.snapshot, undefined); // Cached data is not a new execution signal.
    assert.equal(selected.status, 'fresh'); assert.equal(selected.stale, false);
    assert.equal(selected.snapshotUsable, true); assert.equal(selected.pollStatus, 'waiting');
    assert.deepEqual(selected.snapshot, first.snapshot); assert.deepEqual(selected.binding, first.binding);
    assert.equal(selected.nextPollAtMs, first.nextPollAtMs);
  }
  await feed.poll(); assert.equal(calls, 1);
  now = first.nextPollAtMs - 1; await feed.select(mint); assert.equal(calls, 1);
  now++; await feed.poll(); assert.equal(calls, 2);
});

test('changing mint discards the old snapshot and binding while retaining the shared request deadline', async () => {
  let now = 100_000, calls = 0;
  const feed = new MarketSnapshots({ clock: () => now, fetchImpl: async () => { calls++; return reply(); } });
  await feed.select(mint); const deadline = feed.state().nextPollAtMs;
  now += 1000; await feed.select(otherMint);
  assert.equal(feed.state().mint, otherMint); assert.equal(feed.state().snapshot, null);
  assert.equal(feed.state().binding, null); assert.equal(feed.state().snapshotUsable, false);
  assert.equal(feed.state().status, 'waiting'); assert.equal(feed.state().nextPollAtMs, deadline);
  await feed.select(mint); // Returning to a mint does not resurrect its discarded cache.
  assert.equal(feed.state().snapshotUsable, false); assert.equal(feed.state().snapshot, null);
  assert.equal(calls, 1);
  now = deadline; await feed.poll(); assert.equal(calls, 2); assert.equal(feed.state().snapshotUsable, true);
});

test('reselection preserves an error and Retry-After even when the old snapshot has not aged out', async () => {
  let now = 100_000, calls = 0;
  const feed = new MarketSnapshots({ clock: () => now, fetchImpl: async () => ++calls === 1 ? reply() : reply([], 429, { 'Retry-After': '90' }) });
  await feed.select(mint); now += POLL_MS; await feed.poll();
  const failed = feed.state();
  assert.equal(failed.stale, false); assert.equal(failed.snapshotUsable, false);
  now += 1000; await feed.select(mint);
  assert.equal(feed.state().status, 'error'); assert.equal(feed.state().error, 'HTTP_429');
  assert.equal(feed.state().snapshotUsable, false); assert.equal(feed.state().nextPollAtMs, failed.nextPollAtMs);
  assert.equal(calls, 2);
  now += STALE_MS; await feed.select(mint);
  assert.equal(feed.state().stale, true); assert.equal(feed.state().snapshotUsable, false); assert.equal(calls, 2);
});

test('a stale snapshot remains unusable during cooldown; selecting it does not refresh timestamps', async () => {
  let now = 100_000, calls = 0;
  const feed = new MarketSnapshots({ clock: () => now, fetchImpl: async () => {
    calls++; now += STALE_MS + 1; // Controlled elapsed request time, not a real delayed provider response.
    return reply();
  } });
  await feed.select(mint); const before = feed.state();
  assert.equal(before.stale, true); assert.equal(before.snapshotUsable, false);
  now++; await feed.select(mint);
  assert.equal(feed.state().status, 'stale'); assert.equal(feed.state().snapshotUsable, false);
  assert.deepEqual(feed.state().snapshot, before.snapshot); assert.equal(calls, 1);
});

test('creation uses the same strict snapshot eligibility after reselection, mint change, outage and recovery', async t => {
  let now = 100_000, calls = 0, failed = false;
  const service = await createPanelService({ dataDir: directory(t), clock: () => now, marketFetch: async () => {
    calls++; return failed ? reply([], 503) : reply();
  } });
  t.after(() => service.close());
  await service.selectMarket({ mint }); now += 1000; await service.selectMarket({ mint });
  assert.equal(service.state().market.snapshotUsable, true); assert.equal(calls, 1);
  await service.selectMarket({ mint: otherMint });
  assert.throws(() => service.create(body('create-data-0001')), { code: 'INVALID_FIELDS' });
  await service.selectMarket({ mint });
  assert.throws(() => service.create(body('create-data-0001')), { code: 'INVALID_FIELDS' });
  now += POLL_MS; await service.pollMarket();
  failed = true; now += POLL_MS; await service.pollMarket();
  assert.equal(service.state().market.stale, false);
  assert.throws(() => service.create(body('create-data-0001')), { code: 'INVALID_FIELDS' });
  await service.selectMarket({ mint });
  assert.throws(() => service.create(body('create-data-0001')), { code: 'INVALID_FIELDS' });
  failed = false; now = service.state().market.nextPollAtMs; await service.pollMarket();
  now += 1000; await service.selectMarket({ mint });
  const created = service.create(body('create-data-0001'));
  assert.equal(created.rules.length, 1); assert.equal(created.rules[0].state, 'draft');
  assert.equal(created.rules[0].config.market.pairAddress, pairAddress);
  assert.equal(service.create(body('create-data-0001')).rules.length, 1);
});

for (const ending of ['finished', 'expired', 'revoked']) {
  test(`${ending} → repeated same-mint selection → new rule → one operation → reopen preserves both histories`, async t => {
    let now = 100_000, calls = 0;
    const dataDir = directory(t), options = { dataDir, clock: () => now, marketFetch: async () => { calls++; return reply(); } };
    let service = await createPanelService(options); t.after(() => service.close());
    await service.selectMarket({ mint });
    const oldBody = body(`create-${ending}-0001`), oldId = service.create(oldBody).currentRuleId;
    service.command(oldId, 'enable', { requestId: `enable-${ending}-0001` });
    if (ending === 'finished') { now += POLL_MS; await service.pollMarket(); }
    if (ending === 'expired') now += 60_000;
    if (ending === 'revoked') {
      const command = { requestId: 'revoke-old-rule-0001' };
      service.command(oldId, 'revoke', command); service.command(oldId, 'revoke', command);
      assert.throws(() => service.command(oldId, 'enable', { requestId: 'enable-revoked-again' }), { code: 'INVALID_TRANSITION' });
    }
    assert.equal(service.state().rules[0].state, ending);
    await service.selectMarket({ mint });
    const before = service.state().rules[0], callsBefore = calls;
    now += 1000; await service.selectMarket({ mint }); await service.selectMarket({ mint });
    assert.equal(service.state().market.snapshotUsable, true); assert.equal(calls, callsBefore);
    const nextBody = body(`create-${ending}-0002`), nextId = service.create(nextBody).currentRuleId;
    service.create(nextBody);
    assert.notEqual(nextId, oldId); assert.equal(service.state().rules.length, 2);
    assert.deepEqual(service.state().rules[0], before);
    assert.equal(service.state().rules[1].operations.length, 0); // No cached-signal execution.
    const enable = { requestId: `enable-${ending}-0002` };
    service.command(nextId, 'enable', enable); service.command(nextId, 'enable', enable);
    now += POLL_MS; await service.pollMarket(); await service.pollMarket();
    const next = service.state().rules[1];
    assert.equal(next.state, 'finished'); assert.equal(next.operations.length, 1);
    assert.deepEqual(service.state().rules[0], before);
    service.close(); service = await createPanelService(options);
    service.create(nextBody); await service.pollMarket();
    assert.equal(service.state().rules.length, 2); assert.equal(service.state().rules[0].state, ending);
    assert.deepEqual(service.state().rules[1].operations, next.operations);
  });
}

test('fresh source/reselection does not clear unknown; explicit revocation keeps its result when a separate rule is created', async t => {
  const dataDir = directory(t); mkdirSync(dataDir);
  const market = { mode: 'market-paper', provider: 'dexscreener', chainId: 'solana', dexId: 'pumpswap', mint, pairAddress, quoteMint: WSOL_MINT, priceField: 'priceUsd' };
  const rule = { id: 'unknown-rule', assetId: `SOLANA:${mint}`, market, panel: { version: 1, input: {} },
    condition: { metric: 'priceUnits', operator: 'lte', thresholdUnits: decimalUnits('1.00'), priceBasis: MARKET_PRICE_BASIS },
    amountUnits: 10_000_000_000, limits: { maxTotalSpendUnits: 10_000_000_000, minReceiveUnits: 1, maxFeeUnits: 0, maxSlippageBps: 50, maxEventAgeMs: STALE_MS }, expiresAtMs: 1_000_000 };
  const engine = RuleEngine.initialize({ storagePath: join(dataDir, 'state.sqlite'), clock: () => 100_000, executor: new SimulatedExecutor({ outcome: 'unknown' }) });
  engine.createRule(rule, { requestId: 'create' }); engine.enable(rule.id, { requestId: 'enable' });
  const prepared = engine.receiveMarketSnapshot(rule.id, { ...market, id: 'local-unknown-observation', idKind: 'local-observation', type: 'market-price-snapshot', assetId: rule.assetId,
    observedAtMs: 100_000, receivedAtMs: 100_000, providerUpdatedAtMs: null, rawPriceUsd: fixture[0].priceUsd, priceUnits: decimalUnits(fixture[0].priceUsd), priceBasis: MARKET_PRICE_BASIS });
  await engine.executePrepared(prepared.operationId, { requestId: 'execute' }); engine.close();
  const service = await createPanelService({ dataDir, clock: () => 100_000, marketFetch: async () => reply() }); t.after(() => service.close());
  await service.pollMarket();
  assert.equal(service.state().market.snapshotUsable, true);
  assert.equal(service.state().rules[0].operations[0].status, 'unknown');
  assert.throws(() => service.command(rule.id, 'enable', { requestId: 'unknown-enable-again' }), { code: 'ATTEMPT_ALREADY_SUBMITTED' });
  assert.throws(() => service.create(body('create-after-unknown')), { code: 'RULE_ALREADY_OPEN' });
  await assert.rejects(service.selectMarket({ mint }), { code: 'RULE_ALREADY_OPEN' });
  service.command(rule.id, 'revoke', { requestId: 'unknown-final-revoke' });
  await service.selectMarket({ mint }); service.create(body('create-after-unknown'));
  assert.equal(service.state().rules.length, 2);
  assert.equal(service.state().rules[0].state, 'revoked'); assert.equal(service.state().rules[0].operations[0].status, 'unknown');
});
