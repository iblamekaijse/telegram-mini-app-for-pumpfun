// OFFLINE: saved public API fields; mutations below are explicit test scenarios.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MarketSnapshots, eligiblePairs, POLL_MS, STALE_MS } from './web/market-source.mjs';
import { MARKET_PRICE_BASIS, decimalUnits, mintValid, WSOL_MINT } from './market-contract.mjs';
import { createPanelService } from './web/panel-service.mjs';
import { startPanel } from './web/server.mjs';
import { RuleEngine } from './rule-engine.mjs';
import { SimulatedExecutor } from './simulator.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/dexscreener-pumpswap.json', import.meta.url)));
const mint = fixture[0].baseToken.address, pairAddress = fixture[0].pairAddress;
const otherMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const response = (payload = fixture, status = 200, headers = {}) => new Response(JSON.stringify(payload), { status, headers });
function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'paper-market-test-')); t.after(() => rmSync(path, { recursive: true, force: true }));
  return join(path, 'data');
}
const createBody = (requestId = 'market-create-0001') => ({ requestId, mode: 'market-paper', mint, threshold: '0.0001', amount: '10.00', expiresInMinutes: 10 });
const binding = { mode: 'market-paper', provider: 'dexscreener', chainId: 'solana', dexId: 'pumpswap', mint, pairAddress, quoteMint: WSOL_MINT, priceField: 'priceUsd' };
function snapshot(now, overrides = {}) {
  const rawPriceUsd = overrides.rawPriceUsd ?? '0.00009';
  return { ...binding, id: `local-test-${now}`, idKind: 'local-observation', type: 'market-price-snapshot', assetId: `SOLANA:${mint}`,
    observedAtMs: now, receivedAtMs: now, providerUpdatedAtMs: null, rawPriceUsd, priceUnits: decimalUnits(rawPriceUsd), priceBasis: { ...MARKET_PRICE_BASIS }, ...overrides };
}
const config = { id: 'market-rule', assetId: `SOLANA:${mint}`, market: binding,
  condition: { metric: 'priceUnits', operator: 'lte', thresholdUnits: 100_000, priceBasis: MARKET_PRICE_BASIS }, amountUnits: 10_000_000_000,
  limits: { maxTotalSpendUnits: 10_000_000_000, maxFeeUnits: 0, minReceiveUnits: 1, maxSlippageBps: 50, maxEventAgeMs: STALE_MS }, expiresAtMs: 1_000_000 };
class PaperExecutor extends SimulatedExecutor {
  submit() { return { mode: 'demo', status: 'succeeded', kind: 'virtual-condition' }; }
}

test('offline public fixture: exact mint, supported PumpSwap orientation, deterministic pool selection', () => {
  const original = structuredClone(fixture[0]);
  const fake = { ...original, pairAddress: otherMint, liquidity: { usd: 999999999 } };
  const candidates = [original, fake, { ...fake, dexId: 'raydium' }, { ...fake, baseToken: { ...fake.baseToken, address: otherMint } },
    { ...fake, quoteToken: { address: otherMint } }, { ...fake, chainId: 'ethereum' }];
  assert.equal(eligiblePairs(candidates, mint).length, 2);
  assert.equal(eligiblePairs(candidates, mint)[0].pairAddress, otherMint);
  assert.deepEqual(eligiblePairs(candidates, WSOL_MINT), []); // No silent reciprocal price.
  assert.throws(() => eligiblePairs({}, mint));
});

test('USD values use exact fixed units; incompatible precision and invalid addresses are rejected', () => {
  assert.equal(decimalUnits('0.0001210'), 121_000);
  assert.equal(decimalUnits('0.000000001'), 1);
  assert.equal(decimalUnits('1.000000000000'), 1_000_000_000);
  for (const value of ['0.0000000001', '1e-4', '0', '-1', 'NaN', '100000000']) assert.throws(() => decimalUnits(value));
  assert(mintValid(mint)); assert(mintValid(WSOL_MINT));
  for (const value of ['Fartcoin', '0'.repeat(44), 'z'.repeat(44), mint + ' ', '1'.repeat(31)]) assert.equal(mintValid(value), false);
});

test('one rate gate covers lookup and polling; 429 honours Retry-After', async () => {
  let now = 100_000, calls = 0, retryAfter = '90';
  const feed = new MarketSnapshots({ clock: () => now, fetchImpl: async () => ++calls === 1 ? response() : response([], 429, { 'Retry-After': retryAfter }) });
  await feed.select(mint); await feed.poll(); await feed.select(otherMint);
  assert.equal(calls, 1);
  now += POLL_MS;
  assert.equal((await feed.poll()).error, 'HTTP_429');
  assert(feed.state().nextPollAtMs >= now + 90_000);
  now += 89_999; await feed.poll(); assert.equal(calls, 2);
  now++; retryAfter = '7200'; await feed.poll();
  assert(feed.state().nextPollAtMs >= now + 7_200_000); // Do not shorten a server-specified long delay.
});

test('unavailable data never re-emits a previous price; stale observation and recovery are explicit', async () => {
  let now = 100_000, failed = false;
  const feed = new MarketSnapshots({ clock: () => now, fetchImpl: async () => { if (failed) throw new Error('test outage'); return response(); } });
  const first = await feed.select(mint); failed = true; now += POLL_MS;
  const outage = await feed.poll(); assert(!outage.snapshot); assert.equal(feed.state().status, 'error');
  now += STALE_MS; assert.equal(feed.state().stale, true);
  failed = false; const recovered = await feed.poll();
  assert.equal(feed.state().status, 'fresh'); assert.equal(feed.state().recoveries, 1);
  assert.notEqual(recovered.snapshot.id, first.snapshot.id); assert.equal(recovered.snapshot.providerUpdatedAtMs, null);
  assert.equal(recovered.snapshot.idKind, 'local-observation');
  assert(!Object.hasOwn(recovered.snapshot, 'position')); assert(!Object.hasOwn(recovered.snapshot, 'cursor'));
});

test('pinned pool disappearing is no_data even if another eligible pool exists', async () => {
  let now = 100_000, payload = fixture;
  const feed = new MarketSnapshots({ clock: () => now, fetchImpl: async () => response(payload) });
  await feed.select(mint); now += POLL_MS;
  payload = [{ ...fixture[0], pairAddress: otherMint }];
  assert.equal((await feed.poll()).error, 'NO_SUPPORTED_POOL');
  assert.equal(feed.state().binding.pairAddress, pairAddress);
  assert.equal(feed.state().status, 'no_data');
});

test('missing/null or too precise USD price is not replaced by priceNative or synthetic data', async () => {
  for (const priceUsd of [null, undefined, '0.000000000123', '0', 'bad']) {
    const feed = new MarketSnapshots({ fetchImpl: async () => response([{ ...fixture[0], priceUsd, priceNative: '1.0' }]) });
    assert.equal((await feed.select(mint)).error, 'PRICE_UNAVAILABLE_OR_UNSUPPORTED_PRECISION');
    assert.equal(feed.state().snapshot, null);
  }
});

test('offline integration: saved response → rule → high/low observations → virtual result → SQLite restart', async t => {
  const dataDir = directory(t); let now = 100_000, payload = fixture;
  const options = { dataDir, clock: () => now, marketFetch: async () => response(payload) };
  let service = await createPanelService(options); t.after(() => service.close());
  await service.selectMarket({ mint });
  const body = createBody(), created = service.create(body), id = created.currentRuleId;
  assert.equal(created.rules[0].config.market.pairAddress, pairAddress);
  assert.equal(created.rules[0].config.condition.priceBasis.quoteAssetId, 'FIAT:USD');
  service.command(id, 'enable', { requestId: 'market-enable-0001' });
  assert.equal(service.state().rules[0].operations.length, 0); // Never executes the pre-enable cached value.
  now += POLL_MS; await service.pollMarket();
  assert.equal(service.state().rules[0].events.at(-1).result.disposition, 'condition_not_met');
  payload = [{ ...fixture[0], priceUsd: '0.00009' }]; now += POLL_MS;
  await service.pollMarket();
  const before = service.state().rules[0];
  assert.equal(before.state, 'finished'); assert.equal(before.operations.length, 1);
  assert.equal(before.operations[0].result.kind, 'virtual-condition'); assert(!before.operations[0].result.receipt);
  service.close(); service = await createPanelService(options);
  assert.deepEqual(service.state().rules[0].operations, before.operations);
  service.create(body); now += POLL_MS; await service.pollMarket();
  assert.equal(service.state().rules[0].operations.length, 1);
});

test('no_data/stale input cannot create a market rule; active rules cannot switch sources or accept DEMO prices', async t => {
  let now = 100_000, payload = [];
  const service = await createPanelService({ dataDir: directory(t), clock: () => now, marketFetch: async () => response(payload) });
  t.after(() => service.close());
  await service.selectMarket({ mint }); assert.throws(() => service.create(createBody()), { code: 'INVALID_FIELDS' });
  payload = fixture; now = service.state().market.nextPollAtMs; await service.pollMarket();
  now += STALE_MS + 1; assert.throws(() => service.create(createBody()), { code: 'INVALID_FIELDS' });
  await service.pollMarket();
  const id = service.create(createBody()).currentRuleId;
  await assert.rejects(service.selectMarket({ mint: otherMint }), { code: 'RULE_ALREADY_OPEN' });
  await assert.rejects(service.price(id, { requestId: 'wrong-demo-0001', price: '0.01', outcome: 'succeeded' }), { code: 'WRONG_DATA_MODE' });
  assert.throws(() => service.command(id, 'retry_history', { requestId: 'wrong-history-0001' }), { code: 'NO_SNAPSHOT_HISTORY' });
  assert.throws(() => service.create({ ...createBody(), mode: 'demo', assetId: 'DEMO:ASSET-A', threshold: '1.00' }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(service.state().rules[0].operations.length, 0);
});

test('core rejects wrong mint/pool/provider/units and synthetic injection; valid repeated observation creates one intent', () => {
  const engine = new RuleEngine({ clock: () => 100_000, executor: new PaperExecutor() });
  engine.createRule(config, { requestId: 'create' }); engine.enable(config.id, { requestId: 'enable' });
  assert.throws(() => engine.receiveEvent(config.id, { id: 'fake' }), { code: 'MARKET_SNAPSHOT_REQUIRED' });
  assert.throws(() => engine.bindSource(config.id, { sourceId: 'DEMO:fake' }, { requestId: 'bind' }), { code: 'SNAPSHOT_HAS_NO_RECOVERY_CURSOR' });
  for (const change of [{ mint: otherMint, assetId: `SOLANA:${otherMint}` }, { pairAddress: otherMint }])
    assert.throws(() => engine.receiveMarketSnapshot(config.id, snapshot(100_000, change)), { code: 'MARKET_BINDING_MISMATCH' });
  for (const change of [{ provider: 'other' }, { priceBasis: { ...MARKET_PRICE_BASIS, quoteAssetId: 'DEMO:QUOTE-A' } }, { priceUnits: 1 }])
    assert.throws(() => engine.receiveMarketSnapshot(config.id, snapshot(100_000, change)), { code: 'INVALID_MARKET_SNAPSHOT' });
  assert.equal(engine.receiveMarketSnapshot(config.id, snapshot(1)).disposition, 'ignored_stale');
  assert.equal(engine.receiveMarketSnapshot(config.id, snapshot(100_001)).disposition, 'ignored_future');
  const accepted = engine.receiveMarketSnapshot(config.id, snapshot(100_000));
  assert.equal(accepted.disposition, 'prepared');
  assert.equal(engine.receiveMarketSnapshot(config.id, snapshot(100_000)).duplicate, true);
  assert.equal(engine.getRule(config.id).operationIds.length, 1); engine.close();
});

test('older observations cannot become a new signal; pause, expiry and revoke retain core gates', async () => {
  let now = 100_000;
  const engine = new RuleEngine({ clock: () => now, executor: new PaperExecutor() });
  engine.createRule(config, { requestId: 'create' }); engine.enable(config.id, { requestId: 'enable' });
  engine.receiveMarketSnapshot(config.id, snapshot(now, { rawPriceUsd: '0.0002' }));
  assert.equal(engine.receiveMarketSnapshot(config.id, snapshot(now - 1)).disposition, 'ignored_out_of_order');
  engine.pause(config.id, { requestId: 'pause' });
  assert.equal(engine.receiveMarketSnapshot(config.id, snapshot(++now)).disposition, 'ignored_inactive');
  engine.enable(config.id, { requestId: 'enable2' });
  const prepared = engine.receiveMarketSnapshot(config.id, snapshot(++now));
  engine.revoke(config.id, { requestId: 'revoke' });
  assert.equal((await engine.executePrepared(prepared.operationId, { requestId: 'execute' })).status, 'cancelled');
  assert.equal(engine.getRule(config.id).state, 'revoked');
  const expiring = { ...config, id: 'expiring-market', expiresAtMs: now + 1 };
  engine.createRule(expiring, { requestId: 'create-expiring' }); engine.enable(expiring.id, { requestId: 'enable-expiring' });
  const pending = engine.receiveMarketSnapshot(expiring.id, snapshot(now));
  now++;
  assert.equal((await engine.executePrepared(pending.operationId, { requestId: 'execute-expiring' })).status, 'cancelled');
  assert.equal(engine.getRule(expiring.id).state, 'expired'); engine.close();
});

test('market unknown survives SQLite reopen and fresh snapshots cannot unblock it', async t => {
  const dir = directory(t), storagePath = dir + '.sqlite';
  const options = { storagePath, clock: () => 100_000, executor: new SimulatedExecutor({ outcome: 'unknown' }) };
  let engine = RuleEngine.initialize(options);
  engine.createRule(config, { requestId: 'create' }); engine.enable(config.id, { requestId: 'enable' });
  const event = engine.receiveMarketSnapshot(config.id, snapshot(100_000));
  await engine.executePrepared(event.operationId, { requestId: 'execute' }); engine.close();
  engine = RuleEngine.open(options);
  assert.equal(engine.getOperation(event.operationId).status, 'unknown');
  assert.equal(engine.receiveMarketSnapshot(config.id, snapshot(100_000, { id: 'new-observation' })).disposition, 'ignored_inactive');
  assert.throws(() => engine.enable(config.id, { requestId: 'enable2' }), { code: 'ATTEMPT_ALREADY_SUBMITTED' });
  assert.equal(engine.getRule(config.id).operationIds.length, 1); engine.close();
});

test('panel restoration cancels a prepared pre-restart signal and requires explicit enabling with a new observation', async t => {
  const dataDir = directory(t); mkdirSync(dataDir);
  const engine = RuleEngine.initialize({ storagePath: join(dataDir, 'state.sqlite'), clock: () => 100_000, executor: new PaperExecutor() });
  engine.createRule({ ...config, panel: { version: 1, input: {} } }, { requestId: 'create' });
  engine.enable(config.id, { requestId: 'enable' });
  const pending = engine.receiveMarketSnapshot(config.id, snapshot(100_000)); engine.close();
  const service = await createPanelService({ dataDir, clock: () => 100_000, marketFetch: async () => response() });
  t.after(() => service.close());
  assert.equal(service.state().rules[0].state, 'paused');
  assert.equal(service.state().rules[0].operations.find(o => o.id === pending.operationId).status, 'cancelled');
  await service.pollMarket();
  assert.equal(service.state().rules[0].submittedOperationId, null);
  assert.equal(service.state().market.binding.pairAddress, pairAddress);
});

test('HTTP adapter polls automatically and rejects mode injection; transport injection is test-only', { timeout: 8000 }, async t => {
  let now = Date.now(), calls = 0;
  const app = await startPanel({ dataDir: directory(t), port: 0, clock: () => now, marketFetch: async () => { calls++; return response(); } });
  t.after(() => app.close());
  const api = async (path, body) => {
    const r = await fetch(app.url + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    return { status: r.status, data: await r.json() };
  };
  assert.equal((await api('/api/market/select', { mint: 'wrong' })).status, 400);
  await api('/api/market/select', { mint });
  const created = await api('/api/rules', { ...createBody(), threshold: '1.00' });
  const id = created.data.currentRuleId;
  await api(`/api/rules/${id}/enable`, { requestId: 'enable-http-0001' });
  assert.equal((await api(`/api/rules/${id}/price`, { requestId: 'injection-http-0001', price: '0.01', outcome: 'succeeded' })).status, 409);
  now += POLL_MS;
  await new Promise(resolve => setTimeout(resolve, 1300));
  const state = (await api('/api/state')).data;
  assert.equal(calls, 2); assert.equal(state.rules[0].operations.length, 1);
  assert.equal(state.rules[0].operations[0].result.kind, 'virtual-condition');
  assert.equal(state.rules[0].config.market.pairAddress, pairAddress);
});
