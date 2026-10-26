// A bounded, resumable operational rehearsal. Production uses only the existing application workers.
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync, writeFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { atomicFile, LocalError, APP_ROOT } from './config.mjs';
import { inspectDatabase } from './storage.mjs';
import { startPanel } from '../web/server.mjs';
import { TelegramTransport } from '../web/telegram.mjs';
import { canonical } from '../event-contract.mjs';
import { mintValid, decimalUnits } from '../market-contract.mjs';
import { POLL_MS } from '../web/market-source.mjs';

export const DEFAULT_MINT = 'HnXDnwTa68tRhLRZdJkVRLAeYrUkCYgFgDavtwD1pump';
const terminal = r => ['finished', 'expired', 'revoked'].includes(r.state);
const digest = v => createHash('sha256').update(canonical(v)).digest('hex');
const tableKey = (table, entry) => table === 'sourceDecisions' ? entry.requestId : entry[0];
const businessTables = ['rules', 'positions', 'operations', 'commands', 'events', 'streams', 'sourceDecisions'];
const fail = (code, message) => { throw new LocalError(code, message); };
const decimal = units => `${Math.floor(units / 1e9)}.${String(units % 1e9).padStart(9, '0')}`;
const snapshot = s => s && ({ id: s.id, observedAtMs: s.observedAtMs, receivedAtMs: s.receivedAtMs,
  priceUnits: s.priceUnits, rawPriceUsd: s.rawPriceUsd, mint: s.mint, pairAddress: s.pairAddress, providerUpdatedAtMs: s.providerUpdatedAtMs });
const fingerprint = (config, t) => digest([resolve(config.dbPath), t.botId, t.generation, t.owner]);
function codeIdentity() {
  const files = ['package.json', ...['', 'ops/', 'web/'].flatMap(dir => readdirSync(join(APP_ROOT, dir))
    .filter(name => name.endsWith('.mjs') && !name.endsWith('.test.mjs')).map(name => dir + name)),
    ...['app.js', 'index.html', 'style.css'].map(name => 'web/public/' + name)].sort();
  const hashes = files.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(join(APP_ROOT, path))).digest('hex') }));
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: APP_ROOT, encoding: 'utf8' });
  return { commit: /^[a-f0-9]{40}$/.test(git.stdout?.trim() ?? '') ? git.stdout.trim() : null, digest: digest(hashes), files: hashes };
}
function protectedState(state, keys) {
  return Object.fromEntries(businessTables.map(table => [table, state[table].filter(entry => keys[table].includes(tableKey(table, entry)))]));
}
async function readState(path) {
  const db = await inspectDatabase(path, { exclusive: true });
  try { if (db.raw.version !== 7) fail('SCHEMA_REQUIRED', 'Нужна настроенная SQLite v7. Этот прогон не мигрирует старую базу.'); return db.state; }
  finally { db.close(); }
}
function blockers(s, ruleId, pendingId) {
  for (const [id, r] of s.rules) if (id !== ruleId && !terminal(r)) fail('EXISTING_RULE', `Незавершённое пользовательское правило ${id}; прогон его не меняет.`);
  for (const [id, p] of s.positions) if (p.ruleId !== ruleId && p.status !== 'closed') fail('EXISTING_POSITION', `Пользовательская позиция ${id} не закрыта; прогон её не меняет.`);
  for (const [id, o] of s.operations) if (o.status === 'unknown') fail('UNKNOWN_BLOCK', `Операция ${id}: unknown; повтор и обход блокировки запрещены.`);
  if (s.telegram.dialog || s.telegram.pending && s.telegram.pending.update_id !== pendingId) fail('TELEGRAM_BUSY', 'Есть незавершённый диалог или pending update. Сохранены без изменений; сначала завершите обычную работу приложения.');
}
function lock(path) {
  for (let retry = 0; retry < 2; retry++) {
    try {
      const fd = openSync(path, 'wx', 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd);
      return () => unlinkSync(path);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(path, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid < 1) fail('CHECK_LOCKED', 'Некорректный lock проверки; не запускайте параллельные экземпляры.');
      try { process.kill(pid, 0); } catch (caught) { if (caught.code === 'ESRCH') { unlinkSync(path); continue; } }
      fail('CHECK_LOCKED', 'Другой процесс проверки ещё работает. Не запускайте второй polling.');
    }
  }
  fail('CHECK_LOCKED', 'Не удалось получить lock проверки.');
}

/** Dependencies are injectable ONLY for offline regression tests; evidence is explicitly labelled. */
export async function runLiveCheck({ config, mint, signal, evidenceMode = 'live', processRestart = evidenceMode === 'live', transport = new TelegramTransport(config.token),
  marketFetch = fetch, start = startPanel, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)),
  waitMs = 120_000, ownerWaitMs = 180_000, totalMs = 600_000, restartMs = POLL_MS + 1500, notify = console.log } = {}) {
  if (!config.token || !config.botId) fail('TELEGRAM_NOT_CONFIGURED', 'Используйте прежний локальный .env с токеном и ID бота. Не передавайте токен в чат или параметры.');
  if (mint !== undefined && !mintValid(mint)) fail('INVALID_MINT', 'Mint должен быть поддерживаемым Solana-адресом.');
  // Do not create a directory/database on a missing or busy installation.
  const initial = await readState(config.dbPath);
  const dir = join(config.dataDir, '.paper-live-check');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const unlock = lock(join(dir, 'lock'));
  const path = join(dir, 'report.json');
  let report, app, owner, failure, inspectFinal = true;
  const save = () => { report.updatedAtMs = now(); atomicFile(path, JSON.stringify(report, null, 2) + '\n'); };
  const mark = (stage, details = {}) => {
    if (!report.stages[stage]) { report.stages[stage] = { atMs: now(), ...details }; save(); notify(`Проверка: ${stage}`); }
  };
  const started = now();
  const guard = () => {
    if (signal?.aborted) fail('INTERRUPTED', 'Прервано; записи сохранены. Продолжение — той же командой.');
    if (now() - started >= totalMs) fail('TOTAL_DEADLINE', 'Истёк общий срок 10 минут; состояние сохранено.');
  };
  try {
    if (existsSync(path)) {
      report = JSON.parse(readFileSync(path, 'utf8'));
      if (report.version !== 1 || !/^papercheck-[a-f0-9]{16}$/.test(report.id)) fail('REPORT_INVALID', 'Неподдерживаемый локальный отчёт; история не изменена.');
      if (mint && mint !== report.mint) fail('CHECK_MINT_PINNED', 'Продолжение использует прежний mint и закреплённый пул.');
    } else {
      blockers(initial);
      const t = initial.telegram;
      if (!t.owner || t.owner.userId !== t.owner.chatId) fail('OWNER_REQUIRED', 'Нужен уже привязанный личный чат владельца. Прогон никого не привязывает.');
      if (t.botId !== config.botId) fail('BOT_CONFIG_MISMATCH', 'ID бота в конфигурации и базе не совпадают.');
      if (t.outbox.some(e => e.status === 'pending')) fail('QUEUE_BUSY', 'Есть прежняя очередь уведомлений; прогон не меняет и не сбрасывает её.');
      const keys = Object.fromEntries(businessTables.map(table => [table, initial[table].map(entry => tableKey(table, entry))]));
      report = { version: 1, id: `papercheck-${randomBytes(8).toString('hex')}`, mint: mint ?? DEFAULT_MINT,
        evidenceMode, createdAtMs: now(), status: 'running', stages: {}, attempts: [], ownerUpdate: null, promptMessageIds: [],
        identity: fingerprint(config, t), protectedKeys: keys, protectedHash: digest(protectedState(initial, keys)),
        userSawResult: 'unconfirmed', scope: 'local service creation/enable/close; real owner /status; not the full Telegram creation dialog' };
      report.ruleId = `web-${report.id}`; save();
    }
    if (report.evidenceMode !== evidenceMode) fail('EVIDENCE_MODE_MISMATCH', 'Нельзя продолжить тестовый отчёт как живой прогон.');
    if (report.status === 'completed') { inspectFinal = false; notify(`Прогон уже завершён. Отчёт: ${path}`); return { path, report }; }
    owner = initial.telegram.owner;
    if (!owner || fingerprint(config, initial.telegram) !== report.identity || initial.telegram.botId !== config.botId)
      fail('OWNER_OR_BOT_CHANGED', 'Изменились база, владелец или бот; продолжение остановлено.');
    if (digest(protectedState(initial, report.protectedKeys)) !== report.protectedHash)
      fail('USER_STATE_CHANGED', 'Пользовательская история изменилась относительно начала проверки; автоматическое продолжение остановлено.');
    blockers(initial, report.ruleId, report.ownerUpdate?.updateId);
    // Also reject a newer user rule, even if terminal, rather than ever changing its selected source.
    const latest = initial.rules.at(-1)?.[0];
    if (latest && !report.protectedKeys.rules.includes(latest) && latest !== report.ruleId)
      fail('CURRENT_RULE_CHANGED', `Текущее правило ${latest} не принадлежит прогону.`);
    report.status = 'running'; report.attempts.push({ startedAtMs: started, processId: process.pid, code: codeIdentity() }); save();
    const checkOwner = t => {
      if (fingerprint(config, t) !== report.identity) fail('OWNER_OR_BOT_CHANGED', 'Привязка изменилась; дальнейшие действия проверки остановлены.');
    };
    const wrapped = { async call(method, body, abort) {
      // All sends go through the application's durable queue to the pre-existing private owner only.
      if (method === 'sendMessage' && String(body.chat_id) !== owner.chatId) fail('RECIPIENT_CHANGED', 'Получатель не совпадает с подтверждённым владельцем.');
      const result = await transport.call(method, body, abort);
      if (method === 'getMe') {
        if (String(result?.id) !== config.botId) fail('BOT_CONFIG_MISMATCH', 'getMe вернул другой ID.');
        mark('getMe', { botId: String(result.id) });
      }
      if (method === 'getWebhookInfo' && !result?.url) mark('webhookAbsent');
      if (method === 'sendMessage' && body.text.includes(`[${report.id}:status]`) && Number.isSafeInteger(result?.message_id)) {
        if (!report.promptMessageIds.includes(result.message_id)) report.promptMessageIds.push(result.message_id);
        mark('statusPromptApiAccepted'); save();
      }
      if (method === 'getUpdates' && Array.isArray(result) && !report.ownerUpdate) {
        const u = result.find(u => u.update_id >= (report.statusOffset ?? Infinity) && u.message?.text === '/status' &&
          u.message.chat?.type === 'private' && String(u.message.chat.id) === owner.chatId &&
          String(u.message.from?.id) === owner.userId && !u.message.from?.is_bot &&
          String(u.message.reply_to_message?.from?.id) === config.botId && report.promptMessageIds.includes(u.message.reply_to_message?.message_id));
        if (u) { report.ownerUpdate = { updateId: u.update_id, receivedAtMs: now(), messageAtMs: u.message.date * 1000 }; save(); }
      }
      return result;
    } };
    const launch = async () => {
      guard(); app = await start({ dataDir: config.dataDir, port: config.port, telegramTransport: wrapped,
        marketFetch, clock: now, expectedBotId: config.botId, beforeWorkers(service) {
          checkOwner(service.telegram.load());
          const s = service.state();
          for (const r of s.rules) if (r.config.id !== report.ruleId && (!report.protectedKeys.rules.includes(r.config.id) || !terminal(r)))
            fail('CURRENT_RULE_CHANGED', 'История изменилась между предварительной проверкой и запуском.');
          if (s.positions.some(p => p.ruleId !== report.ruleId && p.status !== 'closed') || s.rules.some(r => r.operations.some(o => o.status === 'unknown')))
            fail('EXISTING_POSITION', 'Появилась открытая позиция или unknown; запуск проверки остановлен.');
        } });
      const response = await fetch(`${app.url}/api/diagnostics`, { signal: AbortSignal.timeout(5000) });
      const d = await response.json();
      if (!response.ok || resolve(d.dbPath) !== resolve(config.dbPath) || d.storage.schemaVersion !== 7) fail('APP_UNAVAILABLE', 'Локальная диагностика не соответствует выбранной SQLite.');
      mark('application', { schemaVersion: d.storage.schemaVersion });
    };
    const view = () => app.serial(() => {
      guard();
      const t = app.service.telegram.load(); checkOwner(t);
      const s = app.service.state();
      if (s.rules.some(r => r.config.id !== report.ruleId && !report.protectedKeys.rules.includes(r.config.id))) fail('CURRENT_RULE_CHANGED', 'Во время проверки появилось другое правило.');
      return { s, t };
    });
    const wait = async (stage, predicate, timeout = waitMs) => {
      const deadline = now() + timeout;
      while (true) {
        guard(); const v = await view();
        const error = v.s.telegram?.lastError;
        if (['identity_error', 'token_error', 'conflict', 'storage_error'].includes(v.s.telegram?.connection)) fail(error ?? 'TELEGRAM_CONFLICT', 'Telegram остановлен: проверьте doctor; второй polling/webhook не отключается автоматически.');
        const found = predicate(v);
        if (found) return found;
        if (now() >= deadline) fail('WAIT_DEADLINE', `Не завершено: ${stage}; рынок ${v.s.market.error ?? v.s.market.status}, Telegram ${v.s.telegram.connection}.`);
        await sleep(500);
      }
    };
    const enqueue = async (suffix, text) => app.serial(() => {
      guard();
      const t = app.service.telegram.load(); checkOwner(t);
      app.service.telegram.enqueue(t, `${report.id}:${suffix}`, text, app.service.state(), { keyboard: { inline_keyboard: [] } });
      app.service.telegram.save(t);
    });
    const sent = async id => wait(`отправка ${id}`, ({ t }) => {
      const e = t.outbox.find(e => e.id === id);
      if (e?.status === 'failed' || e?.status === 'cancelled') fail('MESSAGE_NOT_SENT', `API не подтвердил отправку ${id}; очередь сохранена, лимит попыток не сброшен.`);
      return e?.status === 'sent' && { apiAccepted: true, attempts: e.attempts };
    });
    const initialLaunchAt = now();
    await launch();
    await wait('идентичность и webhook', ({ s }) => s.telegram.identityVerified);
    mark('identityVerified');
    let v = await view();
    let rule = v.s.rules.find(r => r.config.id === report.ruleId);
    if (!rule) {
      // A crash after select/body persistence does not reuse an old signal or repin a rule.
      const work = await app.serial(() => app.service.beginMarketSelect({ mint: report.mint }));
      const fetched = await work.promise; await app.serial(() => app.service.finishMarketSelect(fetched));
      const m = await wait('пригодный снимок поддерживаемого пула', ({ s }) => s.market.snapshotUsable && s.market);
      if (report.binding && canonical(report.binding) !== canonical(m.binding)) fail('POOL_CHANGED', 'Ранее выбранный пул недоступен; автоматическая замена запрещена.');
      report.binding = m.binding; report.selection = snapshot(m.snapshot);
      if (!report.body) {
        const threshold = m.snapshot.priceUnits * 2;
        if (!Number.isSafeInteger(threshold)) fail('PRICE_RANGE', 'Цена вне точного поддерживаемого диапазона проверки.');
        report.body = { requestId: report.id, mode: 'market-paper', scenario: 'virtual-position', mint: report.mint,
          threshold: decimal(threshold), amount: '1', expiresInMinutes: 30, takeProfit: '10000', stopLoss: '99.99' };
      }
      save(); mark('marketSelection', { snapshot: report.selection, binding: report.binding });
      await app.serial(() => app.service.create(report.body));
      mark('ruleCreated', { ruleId: report.ruleId, virtualAmountUsd: '1', thresholdUsd: report.body.threshold });
    } else {
      if (!report.binding || canonical(rule.config.market) !== canonical(report.binding) || canonical(rule.config.panel.input) !== canonical({
        assetId: `SOLANA:${report.mint}`, thresholdUnits: decimalUnits(report.body.threshold), amountUnits: 1e9,
        expiresInMinutes: 30, mode: 'market-paper', market: report.binding,
        position: { version: 1, takeProfitBps: 1_000_000, stopLossBps: 9999 } }))
        fail('CHECK_RULE_CHANGED', 'Проверочное правило отличается от сохранённого плана.');
      mark('ruleCreated', { ruleId: report.ruleId, recovered: true });
    }
    v = await view(); rule = v.s.rules.find(r => r.config.id === report.ruleId);
    if (!rule.submittedOperationId) {
      if (rule.state === 'draft') await app.serial(() => app.service.command(report.ruleId, 'enable', { requestId: `${report.id}-enable` }));
      else if (rule.state !== 'active') fail('CHECK_RULE_STOPPED', `Проверочное правило ${report.ruleId}: ${rule.state}. Самостоятельное возобновление запрещено.`);
    }
    const getPosition = ({ s }) => s.positions.find(p => p.ruleId === report.ruleId);
    const p = await wait('вход по новому снимку', getPosition);
    if (p.entry.id === report.selection.id || p.entry.observedAtMs <= rule.createdAtMs)
      fail('ENTRY_NOT_NEW', 'Основание входа не является новым наблюдением после создания.');
    mark('virtualEntry', { positionId: p.id, entry: snapshot(p.entry), operationId: p.operationId });
    mark('entryNotification', await sent(`${v.t.generation}:open:${p.id}`));
    if (!report.ownerUpdate) {
      if (report.statusOffset === undefined) { report.statusOffset = (await view()).t.offset; save(); }
      await enqueue('status', `[${report.id}:status]\nПРОВЕРОЧНАЯ виртуальная позиция ${p.id} (${report.ruleId}), 1 USD без реальных сделок.\nОтветьте НА ЭТО сообщение командой /status один раз. После ответа прогон сам запросит закрытие и проверит перезапуск.`);
      await sent(`${report.id}:status`);
      notify('В Telegram ответьте НА СООБЩЕНИЕ проверки командой /status. Других действий не требуется.');
    }
    const received = await wait('настоящий ответ владельца /status на сообщение проверки', () => report.ownerUpdate, ownerWaitMs);
    mark('ownerUpdateReceived', received);
    await wait('обработка /status', ({ t }) => t.offset > received.updateId && t.outbox.some(e => e.id === `reply:${received.updateId}` && e.body.text.includes(report.ruleId)));
    mark('statusProcessed', { updateId: received.updateId });
    mark('statusReplyApiAccepted', await sent(`reply:${received.updateId}`));
    v = await view(); const currentPosition = getPosition(v);
    if (currentPosition.status === 'open') await app.serial(() => app.service.closePosition(p.id, { requestId: `${report.id}-close` }));
    const requested = getPosition(await view());
    if (requested.closeRequest) mark('closeRequested', { positionId: p.id, request: requested.closeRequest });
    const closed = await wait('виртуальное закрытие по следующему пригодному снимку', x => { const p = getPosition(x); return p?.status === 'closed' && p; });
    if (closed.exit.reason !== 'user_request' || !closed.closeRequest || closed.exit.snapshot.id === closed.closeRequest.afterSnapshotId ||
      closed.exit.snapshot.observedAtMs <= closed.closeRequest.requestedAtMs)
      fail('CLOSE_OTHER_REASON', 'Позиция закрылась не по проверяемому ручному запросу и следующему снимку. Фактический результат сохранён.');
    mark('virtualClose', { request: closed.closeRequest, exit: snapshot(closed.exit.snapshot), values: closed.exit.values });
    mark('closeNotification', await sent(`${v.t.generation}:closed:${p.id}`));
    await wait('очередь перед перезапуском', ({ t }) => !t.outbox.some(e => e.status === 'pending'));
    const before = await view();
    const invariant = x => ({ position: getPosition(x), operations: x.s.rules.find(r => r.config.id === report.ruleId).operations,
      notifications: x.t.outbox.filter(e => e.id.includes(`:${p.id}`)).map(e => ({ id: e.id, attempts: e.attempts, status: e.status })) });
    report.restartBaseline ??= digest(invariant(before)); save();
    if (digest(invariant(before)) !== report.restartBaseline) fail('RESULT_CHANGED', 'Сохранённый результат/операции/уведомления изменились до перезапуска.');
    let restartAt;
    if (processRestart) {
      if (!report.restartPending) {
        report.restartPending = { previousProcessId: process.pid, atMs: now() }; save();
        await app.close(); app = null;
        // The CLI launches a fresh Node process only after finally releases both locks.
        return { path, report, restartRequired: true };
      }
      if (report.restartPending.previousProcessId === process.pid)
        fail('PROCESS_RESTART_REQUIRED', 'Продолжение после контрольного перезапуска требует нового процесса Node.');
      restartAt = initialLaunchAt;
    } else {
      await app.close(); app = null;
      restartAt = now();
      await launch(); await wait('идентичность после перезапуска', ({ s }) => s.telegram.identityVerified);
    }
    await wait('новый рыночный снимок после перезапуска', ({ s }) => s.market.snapshotUsable && s.market.snapshot.observedAtMs >= restartAt, waitMs);
    while (now() - restartAt < restartMs) { guard(); await sleep(500); }
    const after = await view();
    if (digest(invariant(after)) !== report.restartBaseline) fail('RESTART_DUPLICATE', 'После перезапуска изменился результат, число операций или отправок уведомлений.');
    mark('restartVerified', { observation: snapshot(after.s.market.snapshot), processRestart, previousProcessId: report.restartPending?.previousProcessId ?? null, processId: process.pid, sameResult: true, sameOperations: true, noNotificationReplay: true });
    await enqueue('result', `ПРОВЕРКА ${report.id} завершена: ${report.ruleId}, позиция ${p.id}.\nВход, команда /status, виртуальное закрытие и сохранность после перезапуска проверены.\nРасчётный результат: ${closed.display.pnlUsd} USD (${closed.display.pnlPercent}%).\nПросмотр человеком автоматически не подтверждается. Локальный report.json содержит этапы без переписки и токена.`);
    mark('resultMessageApiAccepted', await sent(`${report.id}:result`));
    await app.close(); app = null;
    const final = await readState(config.dbPath);
    if (digest(protectedState(final, report.protectedKeys)) !== report.protectedHash) fail('USER_STATE_CHANGED', 'Пользовательские записи изменились; проверка сохранности не пройдена.');
    mark('userHistoryPreserved'); report.status = 'completed';
    if (report.lastFailure) report.lastFailure.resolvedAtMs = now();
    save();
  } catch (error) {
    failure = error;
    if (report) {
      report.status = 'incomplete'; report.lastFailure = { atMs: now(), code: /^[A-Z_0-9]+$/.test(error.code ?? '') ? error.code : 'CHECK_ERROR',
        // Never persist arbitrary transport/error text (it can contain a secret URL).
        reason: error instanceof LocalError ? error.message : 'Проверка остановлена; секретные детали исключены. Выполните doctor.' };
      save();
    }
  } finally {
    try {
      if (app) await app.close();
      if (report && inspectFinal) {
        try {
          const s = await readState(config.dbPath), r = s.rules.find(([id]) => id === report.ruleId)?.[1], p = s.positions.find(([,p]) => p.ruleId === report.ruleId)?.[1];
          report.actual = { ruleId: r?.config.id ?? null, ruleState: r?.state ?? null, operationIds: r?.operationIds ?? [],
            positionId: p?.id ?? null, positionStatus: p?.status ?? null, closeRequest: p?.closeRequest ?? null, entry: snapshot(p?.entry), exit: p?.exit ? snapshot(p.exit.snapshot) : null,
            originalHistoryUnchanged: digest(protectedState(s, report.protectedKeys)) === report.protectedHash };
          save();
        } catch { report.finalInspection = 'unavailable'; save(); }
      }
    } finally { unlock(); }
  }
  if (failure) { notify(`Не завершено: ${report?.lastFailure?.reason ?? (failure instanceof LocalError ? failure.message : 'предварительная проверка не пройдена')}`); }
  notify(`Итог: ${report?.status ?? 'не начат'}.\n${report ? 'Отчёт: ' + path : 'Прогон не начат; отчёт не создан.'}\nПовтор этой же команды продолжает тот же прогон без нового правила. Приложение остановлено; обычный запуск: npm start.`);
  return { path, report, failure };
}
