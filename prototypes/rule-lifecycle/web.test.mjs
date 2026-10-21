import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPanel } from './web/server.mjs';
import { createPanelService } from './web/panel-service.mjs';

const script = fileURLToPath(new URL('./web/server.mjs', import.meta.url));
const createBody = (requestId = 'create-test-0001') => ({ requestId, assetId: 'DEMO:ASSET-A', threshold: '1.00', amount: '10.00', expiresInMinutes: 10 });
function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 'rule-web-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'panel-data');
}
async function boot(t, dataDir) {
  const child = spawn(process.execPath, [script], { env: { ...process.env, DEMO_DATA_DIR: dataDir, DEMO_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const url = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('\n')) resolve(JSON.parse(output.trim().split('\n')[0]).url); });
    child.once('exit', () => reject(new Error(`Server exited before ready: ${stderr}`)));
  });
  async function stop(signal = 'SIGKILL') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill(signal); await exited;
  }
  t.after(() => stop());
  return { url, stop };
}
async function api(url, path = '/api/state', body, expected = 200, headers = {}) {
  const response = await fetch(url + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const value = await response.json();
  assert.equal(response.status, expected, JSON.stringify(value));
  return value;
}

test('HTTP scenario creates, enables, receives prices, executes once and restores from SQLite in a new server process', { timeout: 15_000 }, async t => {
  const dataDir = directory(t);
  const first = await boot(t, dataDir);
  const html = await (await fetch(first.url)).text();
  assert.match(html, /id="create-form"/); assert.match(html, /DEMO-пульт/);
  assert.equal((await fetch(first.url + '/app.js')).status, 200);
  const [created, duplicated] = await Promise.all([api(first.url, '/api/rules', createBody()), api(first.url, '/api/rules', createBody())]);
  assert.equal(created.rules.length, 1); assert.equal(duplicated.rules.length, 1);
  const id = created.currentRuleId, path = `/api/rules/${id}`;
  assert.equal(created.rules[0].state, 'draft');
  assert.equal(created.rules[0].config.amountUnits, 1000);
  assert.equal(created.rules[0].config.condition.thresholdUnits, 100);
  await api(first.url, path + '/enable', { requestId: 'enable-test-0001' });
  const high = await api(first.url, path + '/price', { requestId: 'price-high-0001', price: '1.20', outcome: 'failed' });
  assert.equal(high.rules[0].operations.length, 0);
  assert.equal(high.delivery.disposition, 'condition_not_met');
  const lowRequest = { requestId: 'price-low-0001', price: '0,90', outcome: 'succeeded' };
  const [executed, repeated] = await Promise.all([api(first.url, path + '/price', lowRequest), api(first.url, path + '/price', lowRequest)]);
  assert.equal(executed.rules[0].state, 'finished');
  assert.equal(executed.rules[0].operations[0].status, 'succeeded');
  assert.equal(repeated.rules[0].operations.length, 1);
  assert.equal(repeated.rules[0].events.length, 2);
  assert.equal(repeated.delivery.duplicate, true);
  assert.deepEqual((await api(first.url)).rules, repeated.rules);
  await first.stop();
  const restored = await boot(t, dataDir);
  const state = await api(restored.url);
  assert.deepEqual(state.rules, repeated.rules);
  const replay = await api(restored.url, path + '/price', lowRequest);
  assert.equal(replay.rules[0].events.length, 2);
  assert.equal(replay.rules[0].operations.length, 1);
  assert.equal(replay.rules[0].operations[0].status, 'succeeded');
});

test('unknown, stream decision and owner recovery stay independent through the HTTP layer and restart', { timeout: 15_000 }, async t => {
  const dataDir = directory(t), first = await boot(t, dataDir);
  const created = await api(first.url, '/api/rules', createBody());
  const path = `/api/rules/${created.currentRuleId}`;
  await api(first.url, path + '/enable', { requestId: 'enable-unknown-0001' });
  const unknown = await api(first.url, path + '/price', { requestId: 'price-unknown-0001', price: '0.80', outcome: 'unknown' });
  assert.equal(unknown.rules[0].operations[0].status, 'unknown');
  const attempt = await api(first.url, path + '/price', { requestId: 'price-unknown-0002', price: '0.70', outcome: 'succeeded' });
  assert.equal(attempt.rules[0].operations.length, 1);
  assert.equal(attempt.delivery.disposition, 'ignored_inactive');
  const blocked = await api(first.url, path + '/demo-interruption', { requestId: 'interrupt-unknown-0001' });
  const incidentId = blocked.rules[0].stream.issue.id;
  assert.equal(blocked.rules[0].stream.continuity, 'decision_required');
  await api(first.url, path + '/accept_gap', { requestId: 'accept-unknown-0001', incidentId }, 422);
  const recovered = await api(first.url, path + '/retry_history', { requestId: 'recover-unknown-0001', incidentId });
  assert.equal(recovered.decisionResult.outcome, 'history_verified');
  assert.equal(recovered.rules[0].stream.continuity, 'continuous');
  assert.equal(recovered.rules[0].operations[0].status, 'unknown');
  const cannotEnable = await api(first.url, path + '/enable', { requestId: 'enable-unknown-0002' }, 409);
  assert.equal(cannotEnable.error, 'ATTEMPT_ALREADY_SUBMITTED');
  await first.stop();
  const second = await boot(t, dataDir);
  assert.equal((await api(second.url)).rules[0].operations[0].status, 'unknown');
  const revoked = await api(second.url, path + '/revoke', { requestId: 'revoke-unknown-0001' });
  assert.equal(revoked.rules[0].state, 'revoked');
  assert.equal(revoked.rules[0].operations[0].status, 'unknown');
  const next = await api(second.url, '/api/rules', createBody('create-test-0002'));
  assert.equal(next.rules.length, 2);
  assert.equal(next.rules[0].operations[0].status, 'unknown');
  assert.equal(next.rules[1].state, 'draft');
});

test('failure ends the attempt and a new explicit demo rule preserves the old history', async t => {
  const app = await startPanel({ dataDir: directory(t), port: 0 }); t.after(() => app.close());
  const created = await api(app.url, '/api/rules', createBody());
  const path = `/api/rules/${created.currentRuleId}`;
  await api(app.url, '/api/rules', createBody('create-second-0001'), 409);
  await api(app.url, path + '/enable', { requestId: 'enable-failure-0001' });
  const failed = await api(app.url, path + '/price', { requestId: 'price-failure-0001', price: '0.50', outcome: 'failed' });
  assert.equal(failed.rules[0].state, 'finished');
  assert.equal(failed.rules[0].operations[0].status, 'failed');
  await api(app.url, path + '/enable', { requestId: 'enable-failure-0002' }, 409);
  const next = await api(app.url, '/api/rules', createBody('create-second-0001'));
  assert.equal(next.rules.length, 2);
  assert.deepEqual(next.rules[0].operations, failed.rules[0].operations);
});

test('incident actions are tied to the displayed case and duplicate revocation keeps its command identity', async t => {
  const app = await startPanel({ dataDir: directory(t), port: 0 }); t.after(() => app.close());
  const created = await api(app.url, '/api/rules', createBody()), path = `/api/rules/${created.currentRuleId}`;
  await api(app.url, path + '/enable', { requestId: 'enable-incident-0001' });
  const first = await api(app.url, path + '/demo-interruption', { requestId: 'interrupt-test-0001' });
  const oldId = first.rules[0].stream.issue.id;
  const recovery = { requestId: 'recover-test-0001', incidentId: oldId };
  await api(app.url, path + '/retry_history', recovery);
  const duplicateInterruption = await api(app.url, path + '/demo-interruption', { requestId: 'interrupt-test-0001' });
  assert.equal(duplicateInterruption.rules[0].stream.continuity, 'continuous');
  const second = await api(app.url, path + '/demo-interruption', { requestId: 'interrupt-test-0002' });
  const newId = second.rules[0].stream.issue.id;
  assert.notEqual(newId, oldId);
  await api(app.url, path + '/retry_history', { ...recovery, requestId: 'recover-stale-0001' }, 409);
  const revoke = { requestId: 'revoke-incident-0001', incidentId: newId };
  await api(app.url, path + '/revoke', revoke);
  const repeated = await api(app.url, path + '/revoke', revoke);
  assert.equal(repeated.rules[0].stream.continuity, 'stopped');
  assert.equal(repeated.rules[0].decisions.length, 2);
});

test('HTTP validation, conflicting request reuse and local-origin checks reject without creating work', async t => {
  const app = await startPanel({ dataDir: directory(t), port: 0 }); t.after(() => app.close());
  const invalid = await api(app.url, '/api/rules', { ...createBody(), amount: '-1', threshold: 'abc', expiresInMinutes: 0 }, 400);
  assert.deepEqual(Object.keys(invalid.fields).sort(), ['amount', 'expiresInMinutes', 'threshold']);
  assert.equal((await api(app.url)).rules.length, 0);
  await api(app.url, '/api/rules', createBody(), 403, { Origin: 'https://example.invalid' });
  const created = await api(app.url, '/api/rules', createBody());
  await api(app.url, '/api/rules', { ...createBody(), amount: '11' }, 409);
  const path = `/api/rules/${created.currentRuleId}`;
  const price = { requestId: 'price-conflict-0001', price: '1.20', outcome: 'succeeded' };
  await api(app.url, path + '/price', price);
  await api(app.url, path + '/price', { ...price, outcome: 'unknown' }, 409);
  assert.equal((await api(app.url)).rules[0].events.length, 1);
});

test('expiry uses core state and is restored; missing or damaged storage cannot become a fresh panel', async t => {
  const dataDir = directory(t); let now = Date.now();
  const service = await createPanelService({ dataDir, clock: () => now });
  service.create({ ...createBody(), expiresInMinutes: 1 });
  now += 60_000;
  assert.equal(service.state().rules[0].state, 'expired'); service.close();
  const reopened = await createPanelService({ dataDir, clock: () => now });
  assert.equal(reopened.state().rules[0].state, 'expired'); reopened.close();
  rmSync(join(dataDir, 'state.sqlite'));
  const missing = spawnSync(process.execPath, [script], { env: { ...process.env, DEMO_DATA_DIR: dataDir, DEMO_PORT: '0' }, encoding: 'utf8', timeout: 5000 });
  assert.equal(missing.status, 1); assert.match(missing.stderr, /История не сброшена/);
  writeFileSync(join(dataDir, 'state.sqlite'), 'invalid history');
  const damaged = spawnSync(process.execPath, [script], { env: { ...process.env, DEMO_DATA_DIR: dataDir, DEMO_PORT: '0' }, encoding: 'utf8', timeout: 5000 });
  assert.equal(damaged.status, 1); assert.match(damaged.stderr, /История не сброшена/);
});
