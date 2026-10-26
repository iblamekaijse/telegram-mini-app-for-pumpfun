import { randomBytes } from 'node:crypto';
import { mintValid } from '../market-contract.mjs';
const steps = ['mint', 'source', 'threshold', 'amount', 'expiresInMinutes', 'takeProfit', 'stopLoss', 'review'];
const prompts = { mint: 'Введите mint Solana (Base58, 32 байта).', source: 'Проверьте источник перед вводом параметров.',
  threshold: 'Введите цену входного условия в USD за токен: цена ≤ порогу. До 9 знаков после запятой, без округления.',
  amount: 'Введите виртуальную сумму USD: больше нуля, до 2 знаков после запятой.',
  expiresInMinutes: 'Введите срок ожидания входа: целое число минут от 1 до 1440.',
  takeProfit: 'Введите TP в процентах: больше 0 и не выше 10000, до 2 знаков после запятой.',
  stopLoss: 'Введите SL в процентах: больше 0 и меньше 100, до 2 знаков после запятой.' };
const labels = { draft: 'черновик', active: 'включено', paused: 'пауза', finished: 'попытка завершена', expired: 'срок истёк', revoked: 'отозвано' };
const positions = { open: 'открыта', close_requested: 'запрос закрытия сохранён', closed: 'закрыта' };
const reasons = { take_profit: 'TP', stop_loss: 'SL', user_request: 'запрос владельца' };
const decimals = value => { const n = BigInt(value); return `${n / 1000000000n}.${(n % 1000000000n).toString().padStart(9,'0')}`; };

/** Conversation only; validation, source selection and creation are supplied by the shared panel service. */
export class TelegramDialog {
  constructor(controller) { this.c = controller; }
  target(d) { return `${d.id}:${d.revision}`; }
  menu(t) {
    const b = (text, action) => this.c.button(t, text, action);
    const rows = [[b('Новое виртуальное правило', 'new')], [b('Текущее состояние', 'status'), b('История', 'history')], [b('Помощь', 'help')]];
    if (t.dialog) rows.push([this.c.button(t, 'Продолжить настройку', 'continue', this.target(t.dialog))]);
    return rows;
  }
  expire(t) {
    if (!t.dialog || this.c.clock() < t.dialog.expiresAtMs) return false;
    const id = t.dialog.id; t.dialog = null;
    this.c.enqueue(t, `expired:${id}`, 'Срок черновика истёк (30 минут). Торговое правило и позиция не изменены. Начните новую настройку.', this.c.view());
    return true;
  }
  source(d, s) {
    const m = s.market, b = d.binding;
    return `Mint: ${d.values.mint}\n${b ? `Пул: ${b.pairAddress}\nDEX Screener / PumpSwap · токен/WSOL · priceUsd` : 'Поддерживаемый пул ещё не подтверждён.'}\n` +
      (b && m.binding?.mint === b.mint && m.binding?.pairAddress === b.pairAddress ?
        `Снимок: ${m.snapshotUsable ? 'пригоден' : 'сейчас недоступен'}${m.snapshot ? `; последняя полученная цена ${m.snapshot.rawPriceUsd} USD/токен` : ''}.\n` : 'Выбранный в сервисе источник изменился или ещё не загружен.\n') +
      'Название — только метаданные индекса; идентификация по mint и пулу. Время цены у агрегатора неизвестно.';
  }
  prompt(t, prefix = '') {
    const d = t.dialog, s = this.c.view();
    if (!d) return { text: prefix || 'Незавершённой настройки нет.', keyboard: { inline_keyboard: this.menu(t) } };
    const target = this.target(d), button = (text, action) => this.c.button(t, text, action, target);
    const rows = [];
    let text = prompts[d.step];
    if (d.values[d.step]) text += `\nСохранённое значение: ${d.values[d.step]}`;
    if (d.step === 'source') {
      text = d.requestSource ? 'Загружаем поддерживаемый пул. Можно вернуться или отменить настройку.' : this.source(d, s);
      if (!d.requestSource && d.binding) rows.push([button('Продолжить к цене входа', 'next')]);
      if (!d.requestSource) rows.push([button('Повторить загрузку источника', 'reload')]);
    }
    if (d.step === 'review') {
      const v = d.values;
      text = `Проверьте параметры · версия ${d.revision}\n${this.source(d, s)}\nУсловие: цена ≤ ${v.threshold} USD/токен\nВиртуальная сумма: ${v.amount} USD\nСрок ожидания входа: ${v.expiresInMinutes} мин\nTP: ${v.takeProfit}% · SL: ${v.stopLoss}%\nВиртуальная расчётная модель без исполнения, комиссий и проскальзывания. Создание не включает правило.`;
      rows.push([button('Подтвердить создание', 'confirm')], [button('Обновить источник', 'reload')]);
    }
    rows.push([button('Назад', 'back')]);
    rows.push([button('Отменить настройку', 'cancel')], ...this.menu(t));
    return { text: `${prefix ? prefix + '\n\n' : ''}${text}\n\nЧерновик действует до ${new Date(d.expiresAtMs).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} (МСК).`, keyboard: { inline_keyboard: rows } };
  }
  history(t, page = 0) {
    const s = this.c.view(), rules = [...s.rules].reverse(), pages = Math.max(1, Math.ceil(rules.length / 4));
    page = Math.min(Math.max(0, page), pages - 1);
    const selected = rules.slice(page * 4, page * 4 + 4), rows = [], lines = [];
    for (const r of selected) {
      const p = s.positions.find(p => p.ruleId === r.config.id);
      lines.push(`${r.config.id}: ${labels[r.state]}${p ? `; позиция ${positions[p.status]}${p.exit ? `, ${reasons[p.exit.reason]}, ${p.display.pnlUsd} USD` : ''}` : ''}`);
      rows.push([this.c.button(t, `Подробнее: ${r.config.id.slice(-16)}`, 'detail', r.config.id)]);
    }
    const nav = [];
    if (page) nav.push(this.c.button(t, '← Предыдущие', 'history', String(page - 1)));
    if (page + 1 < pages) nav.push(this.c.button(t, 'Следующие →', 'history', String(page + 1)));
    if (nav.length) rows.push(nav);
    rows.push(...this.menu(t));
    return { text: `История · страница ${page + 1}/${pages}\n${lines.join('\n') || 'Правил пока нет.'}`, keyboard: { inline_keyboard: rows } };
  }
  detail(t, id) {
    const s = this.c.view(), r = s.rules.find(r => r.config.id === id), p = s.positions.find(p => p.ruleId === id);
    if (!r) return this.history(t);
    let text = `Правило: ${id}\nАктив: ${r.config.assetId}\nСостояние: ${labels[r.state]}\nСоздано: ${new Date(r.createdAtMs).toISOString()}\nПараметры: цена ≤ ${r.config.market ? decimals(r.config.condition.thresholdUnits) : r.config.condition.thresholdUnits / 100} ${r.config.market ? 'USD/токен' : 'DEMO:QUOTE-A'}; сумма ${r.config.market ? decimals(r.config.amountUnits) : r.config.amountUnits / 100} ${r.config.market ? 'USD' : 'DEMO:QUOTE-A'}; ожидание входа ${r.config.panel.input.expiresInMinutes} мин${r.config.position ? `; TP ${r.config.position.takeProfitBps / 100}%, SL ${r.config.position.stopLossBps / 100}%` : ''}`;
    if (p) text += `\n\nПозиция: ${p.id} · ${positions[p.status]}\nИсточник: DEX Screener / PumpSwap\nMint: ${p.binding.mint}\nПул: ${p.binding.pairAddress}\nОснование входа: новое наблюдение ${p.entry.id}; ${new Date(p.entry.observedAtMs).toISOString()}\nЦена входа: ${decimals(p.entry.priceUnits)} USD/токен\nКоличество (расчёт): ${p.display.quantity}` +
      (p.exit ? `\nОснование выхода: ${reasons[p.exit.reason]}, ${p.exit.snapshot.id}; ${new Date(p.exit.snapshot.observedAtMs).toISOString()}\nЦена выхода: ${decimals(p.exit.snapshot.priceUnits)} USD/токен\nЗафиксированный результат: ${p.display.pnlUsd} USD (${p.display.pnlPercent}%)`
        : `\n${p.valuationAvailable ? 'Текущая расчётная оценка' : 'Текущая оценка недоступна; последнее сохранённое наблюдение'}: ${decimals(p.last.priceUnits)} USD/токен\n${p.valuationAvailable ? 'Оценочный результат' : 'Сохранённая оценка, не текущий результат'}: ${p.display.pnlUsd} USD (${p.display.pnlPercent}%)${p.closeRequest ? '\nЗапрос закрытия сохранён; ждём новый пригодный снимок.' : ''}`);
    if (r.operations.some(o => o.status === 'unknown')) text += '\nUnknown: повтор попытки запрещён.';
    const rows = [];
    if (r.config.id === s.currentRuleId && !r.submittedOperationId && !['finished','expired','revoked'].includes(r.state)) rows.push([this.c.button(t, r.state === 'active' ? 'Приостановить вход' : r.state === 'draft' ? 'Включить правило' : 'Возобновить вход', r.state === 'active' ? 'pause' : 'enable', id)]);
    if (p?.status === 'open') rows.push([this.c.button(t, 'Запросить закрытие позиции', 'close', p.id)]);
    rows.push(...this.menu(t)); return { text, keyboard: { inline_keyboard: rows } };
  }
  handle(t, text, callback, updateId) {
    this.expire(t);
    const menu = { '/new': 'new', 'Новое виртуальное правило': 'new', '/history': 'history', 'История': 'history',
      '/help': 'help', '/start': 'help', 'Помощь': 'help', '/status': 'status', 'Текущее состояние': 'status', '/cancel': 'cancel' };
    const action = callback?.action ?? menu[text.replace(/@\w+(?=\s|$)/, '')];
    if (['status','help','history','new'].includes(action)) {
      if (action === 'history') return this.history(t, Number(callback?.target || 0) || 0);
      if (action === 'help') return { text: 'Меню: новое виртуальное правило → mint → источник → вход/сумма/срок/TP/SL → подтверждение → отдельное включение. История показывает сохранённые основания и результат. Отмена настройки не меняет торговые объекты. Черновик живёт 30 минут. /status, /help, /new, /history, /cancel также доступны. Отключение доступа — в локальной панели.', keyboard: { inline_keyboard: this.menu(t) } };
      if (action === 'status') return { text: this.c.describe(this.c.view()), keyboard: this.c.keyboard(t, this.c.view()) };
      if (!t.dialog) t.dialog = { id: randomBytes(12).toString('hex'), revision: 0, step: 'mint', expiresAtMs: this.c.clock() + 1800000, values: {}, binding: null, requestSource: false };
      return this.prompt(t, 'Настройка виртуального правила. Создание будет только после подтверждения.');
    }
    if (action === 'detail') return this.detail(t, callback.target);
    const d = t.dialog;
    if (callback && ['continue','back','cancel','next','reload','confirm'].includes(action) && (!d || callback.target !== this.target(d))) return { text: 'Эта версия настройки устарела. Продолжите актуальный черновик из меню.', keyboard: { inline_keyboard: this.menu(t) } };
    if (action === 'cancel') { t.dialog = null; return { text: 'Настройка отменена. Правило и позиция не изменены.', keyboard: { inline_keyboard: this.menu(t) } }; }
    if (action === 'continue') return this.prompt(t);
    if (!d) return null;
    if (action === 'back' && d.step === 'mint') return { text: 'Меню. Черновик сохранён; можно продолжить или отменить настройку.', keyboard: { inline_keyboard: this.menu(t) } };
    if (action === 'back') { d.step = steps[Math.max(0, steps.indexOf(d.step)-1)]; d.revision++; d.requestSource = false; return this.prompt(t); }
    if (action === 'reload') { d.revision++; d.requestSource = true; return this.prompt(t, 'Источник будет повторно проверен с общим cooldown.'); }
    if (action === 'next' && d.step === 'source' && d.binding) { d.revision++; d.step = 'threshold'; return this.prompt(t); }
    if (action === 'confirm' && d.step === 'review') {
      if (d.requestSource) return this.prompt(t, 'Дождитесь проверки источника; параметры не изменены.');
      const requestId = `tgcreate-${d.id}`, prior = this.c.view().rules.find(r => r.config.id === `web-${requestId}`);
      const m = this.c.view().market;
      try {
        if (!prior && (!d.binding || JSON.stringify(m.binding) !== JSON.stringify(d.binding))) return this.prompt(t, 'Конфликт: источник изменился. Параметры сохранены; обновите источник и проверьте карточку снова.');
        const s = this.c.create({ ...d.values, requestId, mode: 'market-paper', scenario: 'virtual-position' });
        t.dialog = null;
        return { text: `Виртуальное правило создано: web-${requestId}. Оно ещё не включено. Для запуска нажмите отдельную кнопку «Включить правило».`, keyboard: this.c.keyboard(t, s) };
      } catch (error) {
        if (!error.code || error.code.startsWith('STORAGE_')) throw error;
        return this.prompt(t, `Создание не выполнено: ${Object.values(error.fields ?? {}).join(' ') || error.message}. Параметры сохранены.`);
      }
    }
    if (callback) return null;
    if (text.startsWith('/')) return this.prompt(t, 'Неизвестная команда. Значения не изменены; используйте меню.');
    if (['source','review'].includes(d.step)) return this.prompt(t, 'Здесь используйте кнопки; параметры не изменены.');
    try {
      if (d.step === 'mint') { if (!mintValid(text.trim())) throw new Error('Нужен Solana mint: Base58, ровно 32 байта.'); }
      else this.c.validateField(d.step, text);
      d.values[d.step] = text.trim().replace(',', '.');
      if (d.step === 'mint') { d.binding = null; d.requestSource = true; }
      d.step = steps[steps.indexOf(d.step)+1]; d.revision++;
      return this.prompt(t);
    } catch (error) {
      if (error.code?.startsWith('STORAGE_')) throw error;
      return this.prompt(t, `Ошибка: ${error.message}. Ранее введённые параметры сохранены.`);
    }
  }
  beginSource() {
    const t = this.c.load(); if (this.expire(t)) { this.c.save(t); return null; }
    const d = t.dialog; if (!t.owner || !d?.requestSource) return null;
    try { return { generation: t.generation, target: this.target(d), work: this.c.beginMarketSelect({ mint: d.values.mint }) }; }
    catch (error) {
      if (!error.code || error.code.startsWith('STORAGE_')) throw error;
      d.requestSource = false; this.sendPrompt(t, `Источник не загружен: ${error.message}. Параметры сохранены.`); return null;
    }
  }
  async finishSource(job, result) {
    try { await this.c.finishMarketSelect(result); }
    catch (error) { if (!error.code || error.code.startsWith('STORAGE_')) throw error; }
    const t = this.c.load();
    if (this.expire(t)) { this.c.save(t); return; }
    const d = t.dialog;
    if (!t.owner || t.generation !== job.generation || !d || this.target(d) !== job.target) return;
    d.requestSource = false;
    const m = this.c.view().market;
    if (m.mint === d.values.mint && m.binding && m.snapshotUsable) {
      // A different pool requires a new review revision; old confirmations never survive reloading.
      d.binding = m.binding;
    }
    this.sendPrompt(t, m.mint === d.values.mint && m.snapshotUsable ? 'Источник проверен. Название по индексу: ' + (m.token?.name ?? 'не указано') : `Пригодного снимка пока нет (${m.error ?? m.status}). Дождитесь общего cooldown и повторите загрузку.`);
  }
  sendPrompt(t, prefix) {
    t.dialog.revision++;
    const reply = this.prompt(t, prefix);
    this.c.enqueue(t, `source:${this.target(t.dialog)}`, reply.text, this.c.view(), { keyboard: reply.keyboard }); this.c.save(t);
  }
}
