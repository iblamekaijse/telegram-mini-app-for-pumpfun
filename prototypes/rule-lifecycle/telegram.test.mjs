import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createPanelService } from './web/panel-service.mjs';
import { TelegramTransport, runTelegram } from './web/telegram.mjs';
import { startPanel } from './web/server.mjs';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/dexscreener-pumpswap.json', import.meta.url)));
const mint = fixture[0].baseToken.address;
const msg = (update_id, text, user = 42, chat = 42, type = 'private') => ({ update_id, message: { text, from: { id: user }, chat: { id: chat, type } } });
const click = (update_id, data, user = 42, chat = 42) => ({ update_id, callback_query: { id: `callback-${update_id}`, data, from: { id: user }, message: { chat: { id: chat, type: 'private' } } } });
const createBody = (requestId = 'telegram-rule-0001') => ({ requestId, mode: 'market-paper', scenario: 'virtual-position', mint,
  threshold: '100', amount: '1000', expiresInMinutes: 10, takeProfit: '10', stopLoss: '10' });
async function setup(t, { configured = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'telegram-test-')), dataDir = join(root, 'data');
  let now = 100000, price = '120', fail = false;
  const options = { dataDir, telegramConfigured: configured, clock: () => now, marketFetch: async () => {
    if (fail) throw new Error('TEST outage'); return new Response(JSON.stringify([{ ...fixture[0], priceUsd: price }]));
  } };
  let service = await createPanelService(options), closed = false;
  t.after(() => { if (!closed) service.close(); rmSync(root, { recursive: true, force: true }); });
  return { dataDir, options, get s() { return service; }, get bot() { return service.telegram; },
    advance(ms) { now += ms; }, fail(value) { fail = value; },
    async poll(value, ms = 10000) { now += ms; if (value !== undefined) price = value; return service.pollMarket(); },
    async reopen() { service.close(); now++; service = await createPanelService(options); },
    close() { service.close(); closed = true; },
    bind(id = 1) { const link = service.telegram.createCode(); service.telegram.handle(msg(id, `/start ${link.code}`)); return link; },
    async rule() { await service.selectMarket({ mint }); const id = service.create(createBody()).currentRuleId; service.command(id, 'enable', { requestId: 'telegram-enable-0001' }); return id; },
  };
}
const entries = c => c.bot.load().outbox.filter(e => e.method === 'sendMessage');
const button = (c, action, target) => c.bot.load().callbacks.filter(e => e.action === action && (!target || e.target === target)).at(-1).id;

test('explicit one-time expiring code: /start, foreign users and groups cannot claim; only hash is stored', async t => {
  const c = await setup(t);
  c.bot.handle(msg(1, '/start')); assert.equal(c.bot.status().linked, false);
  const first = c.bot.createCode(); assert.ok(!JSON.stringify(c.bot.load()).includes(first.code));
  c.advance(300000); c.bot.handle(msg(2, `/start ${first.code}`)); assert.equal(c.bot.status().linked, false);
  const second = c.bot.createCode();
  c.bot.handle(msg(3, `/start ${second.code}`, 42, 42, 'group')); assert.equal(c.bot.status().linked, false);
  c.bot.handle(msg(4, `/start ${second.code}`)); assert.equal(c.bot.status().linked, true);
  assert.equal(c.bot.load().code, null); assert.deepEqual(c.bot.load().owner, { userId: '42', chatId: '42' });
  const size = entries(c).length;
  c.bot.handle(msg(5, '/status', 99)); c.bot.handle(msg(6, '/status', 42, 99)); c.bot.handle(msg(7, '/status', 42, 42, 'supergroup'));
  assert.equal(entries(c).length, size);
  await c.reopen(); c.bot.handle(msg(8, '/status')); assert.equal(entries(c).length, size + 1);
});
test('disabled Telegram does not prevent panel/position workflow and no code can be issued', async t => {
  const c = await setup(t, { configured: false });
  assert.throws(() => c.bot.createCode(), { code: 'TELEGRAM_NOT_CONFIGURED' });
  await c.rule(); await c.poll('100'); assert.equal(c.s.state().positions[0].status, 'open');
  assert.equal(entries(c).length, 0);
});
test('first bind does not replay history; unlink cancels queue and all old callbacks across rebind', async t => {
  const c = await setup(t); await c.rule(); await c.poll('100'); await c.poll('110'); c.bind();
  assert.equal(entries(c).length, 1); assert.doesNotMatch(entries(c)[0].body.text, /позиция открыта/);
  c.bot.handle(msg(2, '/status')); const old = button(c, 'status');
  c.bot.unlink(); c.bot.handle(click(3, old)); assert.equal(c.bot.load().outbox.filter(e => e.status === 'pending').length, 0);
  c.bind(4); const count = entries(c).length; c.bot.handle(click(5, old));
  assert.equal(entries(c).length, count + 1); assert.match(entries(c).at(-1).body.text, /устарела/);
  assert.equal(c.bot.status().linked, true);
});
test('specific pending rule buttons, duplicate updates, foreign callbacks and stale archived rule are safe', async t => {
  const c = await setup(t); c.bind(); const id = await c.rule(); c.bot.handle(msg(2, '/status'));
  const pause = button(c, 'pause', id);
  c.bot.handle(click(3, pause, 99)); assert.equal(c.s.state().rules[0].state, 'active');
  c.bot.handle(click(4, pause)); c.bot.handle(click(4, pause)); assert.equal(c.s.state().rules[0].state, 'paused');
  const enable = button(c, 'enable', id); c.bot.handle(click(5, enable)); assert.equal(c.s.state().rules[0].state, 'active');
  c.s.command(id, 'revoke', { requestId: 'revoke-old-rule-0001' }); c.s.create(createBody('telegram-rule-0002'));
  c.bot.handle(click(6, pause)); c.bot.handle(click(7, enable));
  assert.equal(c.s.state().rules[1].state, 'draft'); assert.equal(c.s.state().rules[0].state, 'revoked');
  assert.equal(entries(c).filter(e => e.id === 'reply:4').length, 1);
});
test('end to end: panel entry -> durable notification -> Telegram close -> new snapshot -> result -> restart without action repeat', async t => {
  const c = await setup(t); c.bind(); await c.rule(); await c.poll('100');
  assert.match(entries(c).at(-1).body.text, /позиция открыта/);
  const p = c.s.state().positions[0], close = button(c, 'close', p.id);
  c.bot.handle(click(2, close)); c.bot.handle(click(2, close)); c.bot.handle(click(3, close));
  assert.equal(c.s.state().positions[0].status, 'close_requested');
  const saved = c.s.state().positions[0].closeRequest;
  await c.s.pollMarket(); assert.equal(c.s.state().positions[0].status, 'close_requested');
  await c.reopen(); assert.deepEqual(c.s.state().positions[0].closeRequest, saved);
  await c.poll('107'); const result = c.s.state().positions[0];
  assert.equal(result.exit.reason, 'user_request'); assert.equal(result.display.pnlUsd, '70');
  assert.equal(entries(c).filter(e => /Запрос ручного закрытия сохранён/.test(e.body.text)).length, 1);
  assert.equal(entries(c).filter(e => /позиция закрыта/.test(e.body.text)).length, 1);
  const queueCount = entries(c).length; await c.reopen(); await c.poll('80'); c.bot.handle(click(4, close));
  assert.equal(entries(c).length, queueCount + 1); assert.equal(c.s.state().rules[0].operations.length, 1);
  assert.deepEqual(c.s.state().positions[0].exit, result.exit);
});
for (const [price, reason] of [['110', 'TP'], ['90', 'SL']]) test(`notification for ${reason} uses saved result and does not repeat on new polls`, async t => {
  const c = await setup(t); c.bind(); await c.rule(); await c.poll('100'); await c.poll(price); await c.poll(price);
  const notifications = entries(c).filter(e => /позиция закрыта/.test(e.body.text));
  assert.equal(notifications.length, 1); assert.match(notifications[0].body.text, new RegExp(reason));
  await c.reopen(); assert.equal(entries(c).filter(e => /позиция закрыта/.test(e.body.text)).length, 1);
});
test('availability is transition-based, persisted and rate limited by underlying source; repeated failures/snapshots do not spam', async t => {
  const c = await setup(t); await c.rule(); c.bind(); await c.poll('120'); c.fail(true);
  await c.poll(); await c.poll(undefined, 120000); assert.equal(entries(c).filter(e => /стали недоступны/.test(e.body.text)).length, 1);
  await c.reopen(); await c.poll(undefined, 120000); assert.equal(entries(c).filter(e => /стали недоступны/.test(e.body.text)).length, 1);
  c.fail(false); await c.poll('120', 120000); await c.poll('120');
  assert.equal(entries(c).filter(e => /восстановились/.test(e.body.text)).length, 1);
});
test('delivery persists attempt, honors Retry-After and survives restart with bounded retries; no business action is repeated', async t => {
  const c = await setup(t); c.bind(); const entry = c.bot.prepareDelivery(); assert.equal(entry.attempts, 1);
  c.bot.finishDelivery(entry, { status: 429, retryAfter: 60 }); assert.equal(c.bot.prepareDelivery(), null);
  await c.reopen(); c.advance(59998); assert.equal(c.bot.prepareDelivery(), null); c.advance(2);
  let attempt = c.bot.prepareDelivery(); assert.equal(attempt.attempts, 2);
  // Simulate losing sendMessage's response: no finish call. Restart may retry the notification.
  await c.reopen(); c.advance(300000); attempt = c.bot.prepareDelivery(); assert.equal(attempt.attempts, 3);
  c.bot.finishDelivery(attempt, {}); c.advance(300000); attempt = c.bot.prepareDelivery(); c.bot.finishDelivery(attempt, {});
  c.advance(300000); attempt = c.bot.prepareDelivery(); c.bot.finishDelivery(attempt, {});
  assert.equal(c.bot.load().outbox[0].status, 'failed'); assert.equal(c.bot.load().outbox[0].attempts, 5);
  assert.equal(c.bot.prepareDelivery(), null);
});
test('successful delivery and permanent send rejection persist; unlink during a send cannot restore cancelled delivery', async t => {
  const c = await setup(t); c.bind(); const first = c.bot.prepareDelivery(); c.bot.finishDelivery(first);
  await c.reopen(); assert.equal(c.bot.prepareDelivery(), null);
  c.bot.handle(msg(2, '/status')); const second = c.bot.prepareDelivery(); c.bot.finishDelivery(second, { status: 403 });
  assert.equal(c.bot.load().outbox.find(e => e.id === second.id).status, 'failed');
  c.bot.handle(msg(3, '/help')); const third = c.bot.prepareDelivery(); c.bot.unlink(); c.bot.finishDelivery(third);
  assert.equal(c.bot.load().outbox.find(e => e.id === third.id).status, 'cancelled');
});
test('pending update resumes after business commit but before update acknowledgement, without applying an old toggle twice', async t => {
  const c = await setup(t); c.bind(); const id = await c.rule(); c.bot.handle(msg(2, '/status'));
  const update = click(3, button(c, 'pause', id)), state = c.bot.load(); state.pending = update; c.bot.save(state);
  c.s.command(id, 'pause', { requestId: 'telegram-3' });
  await c.reopen(); assert.equal(c.bot.load().pending, null); assert.equal(c.bot.load().offset, 4);
  assert.equal(c.s.state().rules[0].state, 'paused'); assert.equal(entries(c).filter(e => e.id === 'reply:3').length, 1);
  c.bot.handle(update); assert.equal(entries(c).filter(e => e.id === 'reply:3').length, 1);
});
test('v4 SQLite upgrades without discarding rule/position history', async t => {
  const c = await setup(t); c.bind(); const id = await c.rule(); await c.poll('100'); c.close();
  const path = join(c.dataDir, 'state.sqlite'), db = new DatabaseSync(path);
  const original = JSON.parse(db.prepare('SELECT payload FROM snapshot').get().payload);
  const old = { ...original, version: 4 }; delete old.telegram;
  const payload = JSON.stringify(old); db.prepare('UPDATE snapshot SET payload=?,sha256=?').run(payload, createHash('sha256').update(payload).digest('hex')); db.close();
  const restored = await createPanelService(c.options);
  assert.equal(restored.state().positions[0].status, 'open'); assert.equal(restored.state().rules[0].config.id, id);
  assert.equal(restored.telegram.status().linked, false); restored.close();
  const migrated = new DatabaseSync(path); const v5 = JSON.parse(migrated.prepare('SELECT payload FROM snapshot').get().payload); migrated.close();
  assert.equal(v5.version, 6); assert.deepEqual(v5.positions, original.positions); assert.deepEqual(v5.events, original.events);
});
test('transport sanitizes token URLs, API errors and Retry-After; never returns raw upstream descriptions', async () => {
  const token = '123456:DO_NOT_LEAK';
  const broken = new TelegramTransport(token, async url => { throw new Error(url); });
  await assert.rejects(broken.call('getUpdates', {}), e => !JSON.stringify(e).includes(token) && e.message === 'TELEGRAM_UNAVAILABLE');
  const limited = new TelegramTransport(token, async () => new Response(JSON.stringify({ ok: false, error_code: 429, description: token, parameters: { retry_after: 123 } }), { status: 429 }));
  await assert.rejects(limited.call('sendMessage', {}), e => e.status === 429 && e.retryAfter === 123 && !e.message.includes(token));
});
test('HTTP panel stays responsive while Telegram long polling and sending are pending; shutdown aborts both', async t => {
  const root = mkdtempSync(join(tmpdir(), 'telegram-http-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  let polling = false;
  const app = await startPanel({ dataDir: join(root, 'data'), port: 0, telegramToken: '', telegramTransport: { call: (method, body, signal) => {
    polling = true; return new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
  } } });
  try {
    const response = await fetch(app.url + '/api/state'); assert.equal(response.status, 200); assert.equal((await response.json()).telegram.configured, true);
    const issued = await (await fetch(app.url + '/api/telegram/code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    assert.match(issued.telegramLink.code, /^[a-f0-9]{24}$/); assert.ok(polling);
    const state = await (await fetch(app.url + '/api/state')).text(); assert.ok(!state.includes(issued.telegramLink.code));
  } finally { await app.close(); }
});

test('consumed action button cannot pause a resumed rule a second time under a different update ID', async t => {
  const c = await setup(t); c.bind(); const id = await c.rule(); c.bot.handle(msg(2, '/status'));
  const pause = button(c, 'pause', id); c.bot.handle(click(3, pause));
  c.bot.handle(click(4, button(c, 'enable', id))); assert.equal(c.s.state().rules[0].state, 'active');
  c.bot.handle(click(5, pause)); assert.equal(c.s.state().rules[0].state, 'active');
});
test('unknown notification survives restart; saved old enable button cannot bypass submitted-attempt restriction', async t => {
  const c = await setup(t); c.bind();
  const id = c.s.create({ requestId: 'synthetic-unknown-rule', assetId: 'DEMO:ASSET-A', threshold: '1', amount: '10', expiresInMinutes: 10 }).currentRuleId;
  c.bot.handle(msg(2, '/status')); const enable = button(c, 'enable', id);
  c.s.command(id, 'enable', { requestId: 'unknown-enable-0001' });
  await c.s.price(id, { requestId: 'unknown-price-0001', price: '0.9', outcome: 'unknown' });
  assert.equal(entries(c).filter(e => /Исход виртуальной операции неизвестен/.test(e.body.text)).length, 1);
  await c.reopen(); c.bot.handle(click(3, enable));
  assert.equal(c.s.state().rules[0].operations[0].status, 'unknown'); assert.equal(c.s.state().rules[0].state, 'paused');
  assert.equal(entries(c).filter(e => /Исход виртуальной операции неизвестен/.test(e.body.text)).length, 1);
});
test('a failed final update save leaves the update unacknowledged; restart replays the durable pending command', async t => {
  const c = await setup(t); c.bind(); const id = await c.rule(); c.bot.handle(msg(2, '/status'));
  const update = click(3, button(c, 'pause', id)); const realSave = c.bot.save.bind(c.bot);
  c.bot.save = value => { if (value.offset === 4) throw new Error('TEST crash before acknowledgement'); realSave(value); };
  assert.throws(() => c.bot.handle(update), /TEST crash/);
  assert.equal(c.bot.load().offset, 3); assert.equal(c.bot.load().pending.update_id, 3);
  assert.equal(c.s.state().rules[0].state, 'paused'); await c.reopen();
  assert.equal(c.bot.load().offset, 4); assert.equal(c.bot.load().pending, null); assert.equal(c.s.state().rules[0].state, 'paused');
});
for (const status of [401, 409, 429]) test(`runtime classifies Telegram ${status} without stopping panel state access`, async t => {
  const c = await setup(t); let tail = Promise.resolve();
  const serial = fn => { const result = tail.then(fn); tail = result.catch(() => {}); return result; };
  const runner = runTelegram({ controller: c.bot, serial, transport: { async call() { throw { status, retryAfter: 10 }; } } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(c.bot.status().connection, status === 401 ? 'token_error' : status === 409 ? 'conflict' : 'retrying');
  assert.equal(c.bot.status().lastError, `TELEGRAM_${status}`); assert.equal(c.s.state().liveTradingAllowed, false);
  await runner.close();
});
