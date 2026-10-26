import { createHash, randomBytes } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(12).toString('hex');
const reasonLabels = { take_profit: 'TP', stop_loss: 'SL', user_request: 'запрос владельца' };
const usd = units => `${BigInt(units) / 1000000000n}.${(BigInt(units) % 1000000000n).toString().padStart(9, '0')}`;
const identity = value => Number.isSafeInteger(value) && value > 0;

/** Durable single-owner adapter. All methods except transport calls run on the panel command queue. */
export class TelegramController {
  constructor({ engine, view, command, closePosition, clock = Date.now, configured = false }) {
    Object.assign(this, { engine, view, command, closePosition, clock, configured });
    this.connection = configured ? 'connecting' : 'disabled'; this.lastError = null;
  }
  load() { return this.engine.getTelegramState(); }
  save(t) { this.engine.saveTelegramState(t); }
  status() {
    const t = this.load();
    return { configured: this.configured, connection: this.connection, lastError: this.lastError, linked: !!t.owner,
      codeExpiresAtMs: t.code?.expiresAtMs ?? null,
      queued: t.outbox.filter(e => e.status === 'pending').length, failed: t.outbox.filter(e => e.status === 'failed').length };
  }
  createCode() {
    if (!this.configured) throw Object.assign(new Error('Telegram не настроен: задайте TELEGRAM_BOT_TOKEN локально.'), { code: 'TELEGRAM_NOT_CONFIGURED' });
    const t = this.load();
    if (t.owner) throw Object.assign(new Error('Сначала отключите прежнюю привязку.'), { code: 'TELEGRAM_ALREADY_LINKED' });
    const code = random(); t.code = { hash: hash(code), expiresAtMs: this.clock() + 300_000 }; this.save(t);
    return { code, expiresAtMs: t.code.expiresAtMs };
  }
  unlink() {
    const t = this.load(); t.generation++; t.owner = null; t.code = null; t.callbacks = [];
    for (const e of t.outbox) if (e.status === 'pending') e.status = 'cancelled';
    this.save(t);
  }
  facts(s) {
    const events = [];
    for (const p of s.positions) {
      const details = `\nПозиция: ${p.id}\nDEX Screener / PumpSwap\nАктив: ${p.binding.mint}\nПул: ${p.binding.pairAddress}`;
      events.push({ id: `open:${p.id}`, text: `Виртуальная позиция открыта.${details}\nВход: ${usd(p.entry.priceUnits)} USD/токен\nСумма: ${usd(p.amountUnits)} USD\nРасчётное количество: ${p.display.quantity}\nTP: ${p.policy.takeProfitBps / 100}% · SL: ${p.policy.stopLossBps / 100}%` });
      if (p.closeRequest) events.push({ id: `request:${p.id}`, text: `Запрос ручного закрытия сохранён.${details}\nОжидаем следующий новый пригодный рыночный снимок; закрытие ещё не рассчитано.` });
      if (p.exit) events.push({ id: `closed:${p.id}`, text: `Виртуальная позиция закрыта: ${reasonLabels[p.exit.reason]}.${details}\nВход: ${usd(p.entry.priceUnits)} USD/токен\nВыход: ${usd(p.exit.snapshot.priceUnits)} USD/токен\nРасчётный результат: ${p.display.pnlUsd} USD (${p.display.pnlPercent}%)\nБез исполнения, комиссий и проскальзывания.` });
    }
    for (const r of s.rules) for (const o of r.operations) if (o.status === 'unknown') events.push({ id: `unknown:${o.id}`,
      text: `Исход виртуальной операции неизвестен. Повтор запрещён.\nПравило: ${r.config.id}\nАктив: ${r.config.assetId}\nИсточник: ${r.config.market ? 'DEX Screener / PumpSwap' : 'синтетический DEMO'}\nПричина: ${o.reason}` });
    return events;
  }
  button(t, text, action, target = '') {
    const entry = { id: random(), generation: t.generation, action, target, expiresAtMs: this.clock() + 86400_000 };
    t.callbacks.push(entry); return { text, callback_data: entry.id };
  }
  keyboard(t, s) {
    const rows = [[this.button(t, 'Актуальное состояние', 'status')]], r = s.rules.find(r => r.config.id === s.currentRuleId);
    if (r && !r.submittedOperationId && !['finished', 'expired', 'revoked'].includes(r.state)) {
      rows.push([this.button(t, r.state === 'active' ? 'Приостановить вход' : 'Возобновить вход', r.state === 'active' ? 'pause' : 'enable', r.config.id)]);
    }
    const p = s.positions.find(p => p.status === 'open');
    if (p) rows.push([this.button(t, 'Запросить закрытие позиции', 'close', p.id)]);
    return { inline_keyboard: rows };
  }
  enqueue(t, id, text, s, { callbackId } = {}) {
    if (!t.owner || t.outbox.some(e => e.id === id)) return;
    const body = callbackId ? { callback_query_id: callbackId, text: text.slice(0, 180) }
      : { chat_id: t.owner.chatId, text: `ВИРТУАЛЬНЫЙ РЕЖИМ · без реальных сделок\n\n${text}`.slice(0, 4000), reply_markup: this.keyboard(t, s) };
    t.outbox.push({ id, generation: t.generation, chatId: t.owner.chatId, method: callbackId ? 'answerCallbackQuery' : 'sendMessage',
      body, attempts: 0, nextAtMs: this.clock(), status: 'pending' });
  }
  reconcile() {
    const t = this.load(); if (!t.owner) return;
    const s = this.view(); let changed = false;
    for (const e of this.facts(s)) if (!t.seen.includes(e.id)) {
      t.seen.push(e.id); this.enqueue(t, `${t.generation}:${e.id}`, e.text, s); changed = true;
    }
    const m = s.market;
    if (m.binding) {
      const key = `${m.binding.mint}:${m.binding.pairAddress}`, usable = m.snapshotUsable;
      // A fresh process initially has no observation; wait for its first poll before reporting a transition.
      if (m.lastAttemptAtMs !== null && m.pollStatus !== 'loading') {
        if (t.market?.key === key && t.market.usable !== usable) {
          t.marketSequence++;
          this.enqueue(t, `${t.generation}:market:${t.marketSequence}`,
            `Рыночные данные ${usable ? 'восстановились' : 'стали недоступны'}.\nDEX Screener / PumpSwap\nАктив: ${m.binding.mint}\nПул: ${m.binding.pairAddress}\nПричина: ${usable ? 'новый пригодный снимок; пропущенные движения неизвестны' : m.error ?? m.status}`, s);
        }
        if (t.market?.key !== key || t.market.usable !== usable) { t.market = { key, usable }; changed = true; }
      }
    }
    if (changed) this.save(t);
  }
  describe(s) {
    const r = s.rules.find(r => r.config.id === s.currentRuleId), p = s.positions.at(-1);
    return `${r ? `Правило: ${r.config.id}\nАктив: ${r.config.assetId}\nСостояние входа: ${r.state}\nИсточник: ${r.config.market ? 'DEX Screener / PumpSwap' : 'синтетический DEMO'}` : 'Правил пока нет.'}` +
      (p ? `\n\nПозиция: ${p.id}\nСостояние: ${p.status}\nАктив: ${p.binding.mint}\nВход: ${usd(p.entry.priceUnits)} USD/токен\nПоследняя наблюдаемая цена: ${usd(p.last.priceUnits)} USD/токен\nОценка: ${p.valuationAvailable ? 'доступна' : 'сейчас недоступна; показана сохранённая'}\nРасчётный результат: ${p.display.pnlUsd} USD (${p.display.pnlPercent}%)${p.exit ? `\nПричина выхода: ${reasonLabels[p.exit.reason]}` : ''}` : '\nОткрытых позиций нет.') +
      '\n\nЗакрытие: запрос сейчас, расчёт по следующему новому пригодному снимку. Unknown запрещает повтор попытки.';
  }
  handle(update) {
    const t0 = this.load();
    if (!Number.isSafeInteger(update?.update_id) || update.update_id < t0.offset) return;
    // Persist before executing. On crash, replay this update with the same business request ID.
    if (!t0.pending) { t0.pending = update; this.save(t0); }
    else if (t0.pending.update_id !== update.update_id) throw new Error('TELEGRAM_PENDING_UPDATE');
    let t = this.load(); const q = update.callback_query, message = q?.message ?? update.message, user = q?.from ?? message?.from;
    const privateChat = message?.chat?.type === 'private' && identity(message.chat.id) && identity(user?.id) && !user.is_bot;
    const text = message?.text ?? '';
    if (privateChat && !q && !t.owner && /^\/start [a-f0-9]{24}$/.test(text) && t.code &&
      this.clock() < t.code.expiresAtMs && hash(text.slice(7)) === t.code.hash) {
      t.generation++; t.owner = { userId: String(user.id), chatId: String(message.chat.id) }; t.code = null;
      const s = this.view(); t.seen = this.facts(s).map(e => e.id);
      t.market = s.market.binding ? { key: `${s.market.binding.mint}:${s.market.binding.pairAddress}`, usable: s.market.snapshotUsable } : null;
      this.enqueue(t, `${t.generation}:linked`, 'Привязка подтверждена. /help — команды, /status — состояние. Старая история уведомлений не рассылается.', s);
    } else if (privateChat && t.owner?.userId === String(user.id) && t.owner?.chatId === String(message.chat.id)) {
      let reply = null;
      if (!q && /^\/(start|help)(?:@\w+)?$/.test(text)) reply = '/status — правило и позиция. Кнопки приостанавливают/возобновляют ожидающий вход или сохраняют запрос закрытия конкретной позиции. Отключить доступ можно только в локальной панели.';
      else if (!q && /^\/status(?:@\w+)?$/.test(text)) reply = this.describe(this.view());
      else if (q) {
        const c = t.callbacks.find(c => c.id === q.data && c.generation === t.generation && this.clock() < c.expiresAtMs);
        reply = 'Кнопка устарела. Запросите /status.';
        if (c && (c.action === 'status' || c.usedUpdateId === undefined || c.usedUpdateId === update.update_id)) {
          if (c.action !== 'status' && c.usedUpdateId === undefined) { c.usedUpdateId = update.update_id; this.save(t); }
          const s = this.view(), r = s.rules.find(r => r.config.id === c.target), p = s.positions.find(p => p.id === c.target);
          try {
            const requestId = `telegram-${update.update_id}`;
            if (c.action === 'status') reply = this.describe(s);
            else if (c.action === 'close' && p && p.status !== 'closed') {
              this.closePosition(p.id, { requestId }); reply = 'Запрос закрытия сохранён. Ожидаем новый пригодный снимок.';
            } else if (['enable', 'pause'].includes(c.action) && r && r.config.id === s.currentRuleId && !r.submittedOperationId &&
              (c.action === 'pause' ? r.state === 'active' : ['paused', 'draft'].includes(r.state))) {
              this.command(r.config.id, c.action, { requestId }); reply = c.action === 'pause' ? 'Ожидающее входное правило приостановлено.' : 'Ожидающее входное правило включено.';
            }
          } catch (error) {
            if (error.code?.startsWith('STORAGE_') || !error.code) throw error;
            reply = `Действие не выполнено (${/^[A-Z_]+$/.test(error.code) ? error.code : 'COMMAND_REJECTED'}). Запросите /status. Unknown не разрешает повтор.`;
          }
        }
        this.enqueue(t, `ack:${update.update_id}`, reply, this.view(), { callbackId: q.id });
      }
      if (reply) this.enqueue(t, `reply:${update.update_id}`, reply, this.view());
    }
    t.offset = update.update_id + 1; t.pending = null; this.save(t);
    this.reconcile();
  }
  resume() { const pending = this.load().pending; if (pending) this.handle(pending); this.reconcile(); }
  prepareDelivery() {
    const t = this.load();
    const e = t.outbox.find(e => e.status === 'pending' && e.nextAtMs <= this.clock());
    if (!e) return null;
    if (!t.owner || e.generation !== t.generation || e.chatId !== t.owner.chatId) { e.status = 'cancelled'; this.save(t); return null; }
    if (e.attempts >= 5) { e.status = 'failed'; this.save(t); return null; }
    // Persist the attempt BEFORE network I/O. A lost response can cause a duplicate message, never a trade.
    e.attempts++; e.nextAtMs = this.clock() + Math.min(300_000, 1000 * 2 ** e.attempts); this.save(t);
    return structuredClone(e);
  }
  finishDelivery(entry, error = null) {
    const t = this.load(), e = t.outbox.find(e => e.id === entry.id);
    if (!e || e.status !== 'pending' || e.generation !== t.generation) return;
    if (!error) e.status = 'sent';
    else {
      e.lastError = safeCode(error);
      if (error.retryAfter) e.nextAtMs = this.clock() + error.retryAfter * 1000;
      if (e.attempts >= 5 || [400, 401, 403].includes(error.status)) e.status = 'failed';
    }
    this.save(t);
  }
}

export const safeCode = error => [400, 401, 403, 409, 429].includes(error?.status) ? `TELEGRAM_${error.status}` : 'TELEGRAM_UNAVAILABLE';
export class TelegramTransport {
  constructor(token, fetchImpl = fetch) { this.token = token; this.fetch = fetchImpl; }
  async call(method, body, signal) {
    try {
      const response = await this.fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35_000)]) : AbortSignal.timeout(12_000), redirect: 'error',
      });
      const value = await response.json();
      if (!response.ok || !value.ok) throw Object.assign(new Error('Telegram API failure'), {
        status: value.error_code ?? response.status,
        retryAfter: Number.isSafeInteger(value.parameters?.retry_after) && value.parameters.retry_after > 0 ? value.parameters.retry_after : null,
      });
      return value.result;
    } catch (error) {
      // Fetch/JSON errors can contain the secret URL. Never propagate their message/cause.
      throw Object.assign(new Error(safeCode(error)), { status: error.status, retryAfter: error.retryAfter });
    }
  }
}

/** Poll and delivery have separate async loops, neither holds the panel serializer across network I/O. */
export function runTelegram({ controller: c, transport, serial }) {
  const abort = new AbortController(); let stopped = false, pollBusy = false, sendBusy = false, pollAt = 0, sendAt = 0, failures = 0;
  const connection = error => { c.connection = error ? [401, 403].includes(error.status) ? 'token_error' : error.status === 409 ? 'conflict' : 'retrying' : 'connected'; c.lastError = error ? safeCode(error) : null; };
  const delay = e => Math.max(e.retryAfter ? e.retryAfter * 1000 : 0, e.status === 409 ? 30_000 : Math.min(60_000, 1000 * 2 ** Math.min(++failures, 6)));
  async function poll() {
    if (stopped || pollBusy || Date.now() < pollAt) return;
    pollBusy = true;
    try {
      const offset = await serial(() => { c.resume(); return c.load().offset; });
      const updates = await transport.call('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, abort.signal);
      if (!Array.isArray(updates)) throw new Error('INVALID_UPDATES');
      for (const update of updates.sort((a, b) => a.update_id - b.update_id)) {
        if (stopped) break;
        await serial(() => c.handle(update));
      }
      connection(null); failures = 0; pollAt = Date.now() + 200;
    } catch (error) { if (!stopped) { connection(error); pollAt = Date.now() + delay(error); } }
    finally { pollBusy = false; }
  }
  async function send() {
    if (stopped || sendBusy || Date.now() < sendAt) return;
    sendBusy = true;
    try {
      const e = await serial(() => { c.reconcile(); return c.prepareDelivery(); });
      if (e) {
        let error;
        try { await transport.call(e.method, e.body, abort.signal); }
        catch (caught) { error = caught; connection(error); sendAt = Date.now() + delay(error); }
        await serial(() => c.finishDelivery(e, error));
      }
    } catch { if (!stopped) { c.lastError = 'TELEGRAM_STORAGE_UNAVAILABLE'; c.connection = 'storage_error'; sendAt = Date.now() + 5000; } }
    finally { sendBusy = false; }
  }
  const timer = setInterval(() => { void poll(); void send(); }, 300); timer.unref();
  void poll(); void send();
  return { close: async () => { stopped = true; clearInterval(timer); abort.abort();
    // Wait for in-progress local persistence before the database is closed.
    while (pollBusy || sendBusy) await new Promise(resolve => setTimeout(resolve, 10));
  } };
}
