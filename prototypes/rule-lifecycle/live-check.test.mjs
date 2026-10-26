// OFFLINE ONLY: fake Telegram and fixture prices, real application/HTTP/SQLite, temporary data.
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPanelService } from './web/panel-service.mjs';
import { startPanel } from './web/server.mjs';
import { runLiveCheck, DEFAULT_MINT } from './ops/live-check.mjs';
import { inspectDatabase, fileChecksum } from './ops/storage.mjs';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/dexscreener-pumpswap.json', import.meta.url)));

async function harness(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'paper-live-check-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  let now = 1_800_000_000_000, currentApp, appRunning = false, apiId = 100, updateId = 500, aborted = false;
  const config = { dataDir: join(root, 'data'), dbPath: join(root, 'data/state.sqlite'), port: 0, token: 'OFFLINE_SECRET_NOT_A_TOKEN', botId: '123456' };
  const seed = await createPanelService({ dataDir: config.dataDir, clock: () => now, marketFetch: async () => new Response(JSON.stringify([{ ...fixture[0], priceUsd: '0.0001' }])) });
  const tg = seed.telegram.load(); tg.botId = config.botId; tg.owner = { userId: '42', chatId: '42' }; tg.generation = 1; seed.telegram.save(tg);
  if (options.seed) await options.seed(seed, ms => { now += ms; });
  seed.close();
  const updates = [], sends = [], calls = [], stages = [], marketTimes = [];
  let activePolls = 0, maxPolls = 0, polls = 0, starts = 0;
  const marketFetch = async () => {
    marketTimes.push(now);
    if (options.outage) throw new Error('OFFLINE market outage');
    return new Response(JSON.stringify([{ ...fixture[0], priceUsd: options.price?.(now) ?? '0.0001' }]));
  };
  const transport = { async call(method, body, signal) {
    calls.push(method);
    if (method === 'getMe') return { id: options.badBot ? 999 : 123456, is_bot: true };
    if (method === 'getWebhookInfo') return { url: options.webhook ? 'https://example.invalid/hook' : '' };
    if (method === 'getUpdates') {
      activePolls++; maxPolls = Math.max(maxPolls, activePolls); polls++;
      await new Promise(r => { const timer = setTimeout(r, 10); signal?.addEventListener('abort', () => { clearTimeout(timer); r(); }, { once: true }); });
      activePolls--; return updates.splice(0).filter(u => u.update_id >= body.offset);
    }
    if (method === 'sendMessage') {
      assert.equal(String(body.chat_id), '42'); sends.push(structuredClone(body)); const message_id = ++apiId;
      if (body.text.includes(':status]') && !options.noStatus) {
        const status = { update_id: updateId++, message: { message_id: 900, date: Math.floor(now / 1000), text: '/status',
          chat: { id: 42, type: 'private' }, from: { id: 42, is_bot: false },
          reply_to_message: { message_id, from: { id: 123456, is_bot: true } } } };
        if (options.statusMutate) options.statusMutate(status);
        updates.push(status); if (options.duplicate) updates.push(structuredClone(status));
      }
      if (options.failSend && body.text.includes(':status]')) throw Object.assign(new Error('https://secret.invalid/OFFLINE_SECRET_NOT_A_TOKEN'), { status: 403 });
      return { message_id };
    }
    throw new Error(`Unexpected ${method}`);
  } };
  const abort = new AbortController();
  const args = { config, evidenceMode: 'test-transports', marketFetch, transport, signal: abort.signal,
    now: () => now, waitMs: 120_000, ownerWaitMs: 90_000, totalMs: 900_000, restartMs: 11_500,
    notify: s => { stages.push(s); if (options.interruptStage && s === `Проверка: ${options.interruptStage}` && !aborted) { aborted = true; abort.abort(); } },
    start: async opts => { starts++; currentApp = await startPanel(opts); appRunning = true; const close = currentApp.close; currentApp.close = async () => { await close(); appRunning = false; }; return currentApp; },
    sleep: async () => {
      now += 1000;
      if (appRunning) { try { await currentApp.serial(() => currentApp.service.pollMarket()); } catch (e) { if (!/closed/i.test(e.message)) throw e; } }
      await new Promise(r => setTimeout(r, 20));
    } };
  return { config, args, calls, sends, stages, marketTimes, get starts() { return starts; }, get polls() { return polls; }, get maxPolls() { return maxPolls; },
    run: overrides => runLiveCheck({ ...args, ...overrides }), get now() { return now; }, advance: ms => { now += ms; } };
}
async function state(path) { const s = await inspectDatabase(path); try { return s.state; } finally { s.close(); } }

test('one real application worker with fake transports: entry, correlated owner /status, close, restart, durable report and no replay', async t => {
  const h = await harness(t, { duplicate: true }); const result = await h.run();
  assert.equal(result.failure, undefined, result.report?.lastFailure?.reason);
  const r = result.report; assert.equal(r.status, 'completed'); assert.equal(r.evidenceMode, 'test-transports');
  assert.equal(r.userSawResult, 'unconfirmed'); assert.equal(r.stages.statusProcessed.updateId, 500);
  assert.equal(r.stages.restartVerified.noNotificationReplay, true);
  assert.ok(r.stages.restartVerified.atMs - r.stages.restartVerified.startedAtMs >= 11_500); assert.equal(r.actual.originalHistoryUnchanged, true);
  assert.equal(h.maxPolls, 1); assert.equal(h.starts, 2);
  for (let i = 1; i < h.marketTimes.length; i++) assert.ok(h.marketTimes[i] - h.marketTimes[i - 1] >= 10_000, 'market cooldown must survive restart');
  assert.notEqual(r.stages.virtualEntry.entry.id, r.selection.id);
  assert.ok(r.stages.virtualClose.exit.observedAtMs > r.stages.virtualClose.request.requestedAtMs);
  const s = await state(h.config.dbPath); assert.equal(s.rules.length, 1); assert.equal(s.operations.length, 1); assert.equal(s.positions.length, 1);
  assert.equal(s.positions[0][1].status, 'closed'); assert.equal(s.telegram.outbox.filter(e => e.id === 'reply:500').length, 1);
  const count = h.sends.length, hash = fileChecksum(h.config.dbPath);
  assert.equal((await h.run()).report.status, 'completed'); assert.equal(h.sends.length, count); assert.equal(fileChecksum(h.config.dbPath), hash);
  const text = readFileSync(result.path, 'utf8'); assert.ok(!text.includes(h.config.token)); assert.ok(!text.includes('chat_id')); assert.ok(!text.includes('reply_to_message'));
  assert.equal(existsSync(join(h.config.dataDir, '.paper-live-check/lock')), false);
});
for (const stage of ['ruleCreated', 'virtualEntry', 'ownerUpdateReceived', 'closeRequested', 'virtualClose', 'restartVerified']) {
  test(`interruption after ${stage}: same command resumes one rule, operation, position and /status`, async t => {
    const h = await harness(t, { interruptStage: stage }); const first = await h.run();
    assert.equal(first.report.status, 'incomplete'); assert.equal(first.failure.code, 'INTERRUPTED');
    h.advance(10_000);
    const second = await h.run({ signal: new AbortController().signal });
    assert.equal(second.report.status, 'completed', second.report.lastFailure?.reason);
    const s = await state(h.config.dbPath); assert.equal(s.rules.length, 1); assert.equal(s.operations.length, 1); assert.equal(s.positions.length, 1);
    assert.equal(second.report.id, first.report.id);
    assert.equal(s.telegram.outbox.filter(e => e.id.endsWith(':open:'+s.positions[0][0])).length, 1);
  });
}
for (const [label, statusMutate] of [
  ['another user', u => { u.message.from.id = 43; }], ['group', u => { u.message.chat.type = 'group'; }],
  ['unrelated /status', u => { delete u.message.reply_to_message; }], ['stale prompt', u => { u.message.reply_to_message.message_id = 1; }],
]) test(`reject ${label}; preserve incomplete position and do not request close`, async t => {
  const h = await harness(t, { statusMutate }); const r = await h.run();
  assert.equal(r.report.status, 'incomplete'); assert.equal(r.report.ownerUpdate, null); assert.equal(r.failure.code, 'WAIT_DEADLINE');
  const s = await state(h.config.dbPath); assert.equal(s.positions[0][1].closeRequest, null);
});
test('market outage: no fake entry, bounded deadline, same report retained', async t => {
  const h = await harness(t, { outage: true }); const r = await h.run();
  assert.equal(r.failure.code, 'WAIT_DEADLINE'); assert.equal(r.report.status, 'incomplete'); assert.match(r.report.lastFailure.reason, /PROVIDER_UNAVAILABLE/);
  const s = await state(h.config.dbPath); assert.equal(s.rules.length, 0); assert.equal(s.positions.length, 0); assert.equal(h.sends.length, 0);
});
for (const [label, options] of [['bot mismatch', { badBot: true }], ['active webhook', { webhook: true }]])
  test(`${label}: no getUpdates/sends and no rule`, async t => {
    const h = await harness(t, options); const r = await h.run(); assert.equal(r.report.status, 'incomplete');
    assert.ok(!h.calls.includes('getUpdates')); assert.equal(h.sends.length, 0); assert.equal((await state(h.config.dbPath)).rules.length, 0);
  });
test('API rejection: no secret URL in report, no false sent status', async t => {
  const h = await harness(t, { failSend: true }); const r = await h.run();
  assert.equal(r.report.status, 'incomplete'); assert.ok(!r.report.stages.statusReplyApiAccepted);
  assert.ok(!readFileSync(r.path, 'utf8').includes(h.config.token));
});
test('existing user rule: fail before writes, transport or server start', async t => {
  const h = await harness(t, { seed: service => service.create({ requestId: 'existing-user-rule', assetId: 'DEMO:ASSET-A', threshold: '100', amount: '10', expiresInMinutes: 60 }) });
  const before = fileChecksum(h.config.dbPath);
  assert.equal((await h.run()).failure.code, 'EXISTING_RULE');
  assert.ok(h.stages.some(s => s.includes('existing-user-rule')));
  assert.equal(fileChecksum(h.config.dbPath), before); assert.equal(h.starts, 0); assert.equal(h.calls.length, 0);
});
test('already running app: no second getUpdates, no writes', async t => {
  const h = await harness(t); const app = await startPanel({ dataDir: h.config.dataDir, port: 0 });
  try { await assert.rejects(h.run(), { code: 'STORAGE_BUSY' }); assert.equal(h.calls.length, 0); } finally { await app.close(); }
});
test('archived user history and .env remain unchanged during successful run', async t => {
  const h = await harness(t, { seed: service => {
    const id = service.create({ requestId: 'archived-user-rule', assetId: 'DEMO:ASSET-A', threshold: '100', amount: '10', expiresInMinutes: 60 }).currentRuleId;
    service.command(id, 'revoke', { requestId: 'user-archived-revoke' });
  } });
  const initial = await state(h.config.dbPath), r = await h.run();
  assert.equal(r.report.status, 'completed', r.report.lastFailure?.reason);
  const final = await state(h.config.dbPath);
  assert.deepEqual(final.rules.find(([id]) => id === initial.rules[0][0]), initial.rules[0]);
  for (const table of ['commands', 'events', 'streams', 'sourceDecisions'])
    assert.deepEqual(final[table].slice(0, initial[table].length), initial[table]);
});
test('unknown is never retried or used as a route to a check rule', async t => {
  const h = await harness(t, { seed: async service => {
    const id = service.create({ requestId: 'user-unknown-rule', assetId: 'DEMO:ASSET-A', threshold: '100', amount: '10', expiresInMinutes: 60 }).currentRuleId;
    service.command(id, 'enable', { requestId: 'user-unknown-enable' });
    await service.price(id, { requestId: 'user-unknown-price', price: '99', outcome: 'unknown' });
  } });
  const before = fileChecksum(h.config.dbPath), r = await h.run();
  assert.equal(r.report, undefined); assert.ok(['EXISTING_RULE', 'UNKNOWN_BLOCK'].includes(r.failure.code));
  assert.equal(fileChecksum(h.config.dbPath), before); assert.equal(h.calls.length, 0);
});
test('a later user rule stops continuation without changing either rule', async t => {
  const h = await harness(t, { interruptStage: 'virtualClose' }); const first = await h.run();
  const service = await createPanelService({ dataDir: h.config.dataDir, clock: () => h.now });
  service.create({ requestId: 'new-user-rule-after-check', assetId: 'DEMO:ASSET-A', threshold: '100', amount: '10', expiresInMinutes: 60 }); service.close();
  const before = fileChecksum(h.config.dbPath), r = await h.run({ signal: new AbortController().signal });
  assert.equal(r.failure.code, 'EXISTING_RULE'); assert.equal(fileChecksum(h.config.dbPath), before);
  assert.equal(r.report.id, first.report.id);
});
test('no threshold crossing stays incomplete; selected snapshot is not used for entry', async t => {
  let reads = 0;
  const h = await harness(t, { price: () => ++reads === 1 ? '0.0001' : '0.0003' }); const r = await h.run();
  assert.equal(r.report.status, 'incomplete'); assert.equal(r.failure.code, 'WAIT_DEADLINE');
  const s = await state(h.config.dbPath); assert.equal(s.positions.length, 0); assert.equal(s.operations.length, 0);
  assert.equal(s.rules[0][1].state, 'active'); assert.ok(!r.report.stages.virtualEntry);
});

test('new Node process reopens same SQLite, with .env preserved and no second submission or send', async t => {
  const h = await harness(t), envFile = join(h.config.dataDir, '.env');
  writeFileSync(envFile, `TELEGRAM_BOT_TOKEN=OFFLINE_SECRET_NOT_A_TOKEN\nTELEGRAM_BOT_ID=123456\nDEMO_DATA_DIR=${h.config.dataDir}\nDEMO_PORT=0\nCUSTOM_PRESERVED=keep\n`, { mode: 0o600 });
  const envHash = fileChecksum(envFile), worker = new URL('./test-support/live-check-worker.mjs', import.meta.url);
  const run = () => spawnSync(process.execPath, [worker.pathname], { env: { ...process.env, DEMO_ENV_FILE: envFile }, encoding: 'utf8', timeout: 30_000 });
  const first = run(); assert.equal(first.status, 75, first.stdout + first.stderr);
  const reportFile = join(h.config.dataDir, '.paper-live-check/report.json');
  const before = JSON.parse(readFileSync(reportFile, 'utf8')), s = await state(h.config.dbPath);
  const second = run(); assert.equal(second.status, 0, second.stdout + second.stderr);
  const report = JSON.parse(readFileSync(reportFile, 'utf8')), after = await state(h.config.dbPath);
  assert.equal(report.status, 'completed'); assert.equal(report.stages.restartVerified.processRestart, true);
  assert.notEqual(report.stages.restartVerified.previousProcessId, report.stages.restartVerified.processId);
  assert.ok(report.stages.restartVerified.observation.observedAtMs >= before.marketCooldown.notBeforeMs);
  assert.ok(report.stages.restartVerified.atMs - report.stages.restartVerified.startedAtMs >= 11_500);
  assert.equal(report.id, before.id); assert.deepEqual(after.rules, s.rules); assert.deepEqual(after.positions, s.positions); assert.deepEqual(after.operations, s.operations);
  assert.equal(fileChecksum(envFile), envHash);
  assert.equal(after.telegram.outbox.filter(e => e.id.endsWith(':open:' + s.positions[0][0])).length, 1);
});

test('existing open position is preserved, without source selection or notifications', async t => {
  const h = await harness(t, { seed: async (s, advance) => {
    await s.selectMarket({ mint: DEFAULT_MINT });
    const id = s.create({ requestId: 'user-existing-position', mode: 'market-paper', scenario: 'virtual-position', mint: DEFAULT_MINT,
      threshold: '0.0002', amount: '10', expiresInMinutes: 60, takeProfit: '10', stopLoss: '10' }).currentRuleId;
    s.command(id, 'enable', { requestId: 'user-existing-enable' }); advance(10_000); await s.pollMarket();
  } });
  const hash = fileChecksum(h.config.dbPath), r = await h.run();
  assert.equal(r.failure.code, 'EXISTING_POSITION'); assert.equal(fileChecksum(h.config.dbPath), hash); assert.equal(h.calls.length, 0);
});
test('no owner: no binding, recipient selection or getUpdates performed by the tool', async t => {
  const h = await harness(t, { seed: s => { const tg = s.telegram.load(); tg.owner = null; s.telegram.save(tg); } });
  const hash = fileChecksum(h.config.dbPath), r = await h.run();
  assert.equal(r.failure.code, 'OWNER_REQUIRED'); assert.equal(fileChecksum(h.config.dbPath), hash); assert.equal(h.calls.length, 0);
});
test('native CLI refuses missing token and token arguments without revealing supplied values', async t => {
  const root = mkdtempSync(join(tmpdir(), 'live-check-cli-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, DEMO_ENV_FILE: join(root, 'absent.env'), TELEGRAM_BOT_TOKEN: '', TELEGRAM_BOT_ID: '' };
  const cli = new URL('./ops/live-check-cli.mjs', import.meta.url).pathname;
  const missing = spawnSync(process.execPath, [cli], { env, encoding: 'utf8' });
  assert.equal(missing.status, 1); assert.match(missing.stderr, /TELEGRAM_NOT_CONFIGURED/);
  const bad = spawnSync(process.execPath, [cli, '--token', 'FORBIDDEN_SECRET_ARGUMENT'], { env, encoding: 'utf8' });
  assert.equal(bad.status, 1); assert.ok(!bad.stderr.includes('FORBIDDEN_SECRET_ARGUMENT')); assert.match(bad.stderr, /ARGUMENT/);
});

test('completed run remains historical and read-only after later ordinary user activity', async t => {
  const h = await harness(t); const first = await h.run(); assert.equal(first.report.status, 'completed');
  const service = await createPanelService({ dataDir: h.config.dataDir, clock: () => h.now });
  service.create({ requestId: 'later-user-new-rule', assetId: 'DEMO:ASSET-A', threshold: '100', amount: '10', expiresInMinutes: 60 }); service.close();
  const dbHash = fileChecksum(h.config.dbPath), reportHash = fileChecksum(first.path), sends = h.sends.length;
  const next = await h.run(); assert.equal(next.report.status, 'completed'); assert.equal(next.failure, undefined);
  assert.equal(h.sends.length, sends); assert.equal(fileChecksum(h.config.dbPath), dbHash); assert.equal(fileChecksum(first.path), reportHash);
});
