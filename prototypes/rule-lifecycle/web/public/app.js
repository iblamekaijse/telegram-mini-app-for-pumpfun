const $ = id => document.getElementById(id);
const quote = 'DEMO:QUOTE-A';
const number = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = units => number.format(units / 100);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const labels = { draft: 'Черновик', active: 'Включено', paused: 'На паузе', finished: 'Попытка завершена', expired: 'Срок истёк', revoked: 'Отозвано',
  prepared: 'Подготовлена', submitted: 'Ожидаем исход', succeeded: 'Успех', failed: 'Неудача', unknown: 'Исход неизвестен', cancelled: 'Отменена до передачи' };
const dispositions = { prepared: 'Условие выполнено — операция подготовлена', ignored_inactive: 'Цена сохранена; правило не включено', ignored_reserved: 'Новая операция не создана: попытка уже зарезервирована',
  condition_not_met: 'Условие цены пока не выполнено', ignored_stale: 'Событие устарело и не использовано', ignored_future: 'Время события из будущего — исполнение запрещено',
  ignored_asset: 'Событие другого актива пропущено', ignored_incompatible_price: 'Размерность цены не совпадает с правилом', ignored_out_of_order: 'Более старая цена пропущена',
  ignored_history_recovery: 'История проверена; накопленный сигнал не исполняется', ignored_before_resolution: 'Цена возникла до решения владельца — сигнал пропущен' };
let model, signature = '', statusSignature = '', busy = false, connected = false, creating = false, revision = 0;
let feedbackRuleId = null;
let marketFormError = null;
let revokeTarget;
const pendingKeys = new Map();
const openPosition = () => model?.positions?.find(p => p.status !== 'closed');
const positionFor = rule => model?.positions?.find(p => p.ruleId === rule?.config.id);
const exitLabels = { take_profit: 'Тейк-профит', stop_loss: 'Стоп-лосс', user_request: 'По запросу пользователя' };
const displayDecimal = value => String(value).replace('.', ',');
const current = () => model?.rules.find(rule => rule.config.id === model.currentRuleId);
const isMarket = rule => !!rule?.config.market;
const formatFor = (rule, units) => {
  if (!isMarket(rule)) return money(units);
  const value = BigInt(units), fraction = (value % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${new Intl.NumberFormat('ru-RU').format(value / 1_000_000_000n)},${fraction}`;
};
const quoteFor = rule => isMarket(rule) ? 'USD' : quote;
const terminal = rule => ['finished', 'expired', 'revoked'].includes(rule.state);
const operationLabel = (rule, operation) => isMarket(rule) && operation.status === 'succeeded' ? rule.config.position ? 'Виртуальный вход сохранён' : 'Виртуальное условие выполнено' : labels[operation.status];
const pill = (status, label = labels[status] ?? status) => `<span class="state-pill ${escape(status)}">${escape(label)}</span>`;
const date = value => new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const time = value => new Date(value).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function feedback(text, kind = '') { feedbackRuleId = null; $('feedback').textContent = text; $('feedback').className = `feedback ${kind}`; $('feedback').hidden = !text; }
function renderMarketRuleStatus() {
  const rule = current();
  if (!isMarket(rule) || creating) {
    if (feedbackRuleId !== null) feedback('');
    return false;
  }
  const position = positionFor(rule);
  if (position) {
    feedback(position.status === 'closed' ? `Виртуальная позиция закрыта. ${exitLabels[position.exit.reason]}. Результат сохранён.`
      : position.status === 'close_requested' ? 'Запрос закрытия сохранён. Ожидаем следующий новый пригодный снимок.'
      : 'Виртуальная позиция открыта. Входное правило завершено; наблюдаем новые снимки для выхода.');
    feedbackRuleId = rule.config.id; return true;
  }
  const operation = rule.operations.at(-1);
  const result = operation?.status === 'succeeded' ? 'Виртуальное условие выполнено. Условие подтверждено на полученной цене; покупка не проводилась.'
    : operation?.status === 'unknown' ? 'Исход виртуальной операции неизвестен. Повторная попытка заблокирована.'
    : operation?.status === 'failed' ? 'Виртуальное срабатывание завершилось неудачей. Повторной попытки не будет.'
    : operation?.status === 'submitted' ? 'Ожидаем результат виртуальной операции.'
    : operation?.status === 'prepared' ? 'Условие выполнено; виртуальная операция подготовлена.' : '';
  const state = rule.state === 'revoked' ? 'Правило окончательно отозвано.'
    : rule.state === 'expired' ? 'Срок правила истёк.'
    : rule.state === 'paused' ? 'Новые операции приостановлены.'
    : rule.state === 'draft' ? 'Правило создано, но ещё не включено.'
    : rule.state === 'active' && !result ? 'Правило включено. Ожидаем следующий новый рыночный снимок; срабатывание будет виртуальным.' : '';
  feedback([state, result].filter(Boolean).join(' '), ['unknown', 'failed'].includes(operation?.status) ? 'warning' : '');
  feedbackRuleId = rule.config.id;
  return true;
}
function updateControls() {
  const rule = current();
  document.body.classList.toggle('busy', busy);
  document.querySelectorAll('button[data-action], #create-form button[type=submit]').forEach(button => { button.disabled = busy || !connected; });
  $('send-price').disabled = busy || !connected || !rule || isMarket(rule) || rule.stream.continuity !== 'continuous' || terminal(rule);
  $('interrupt-stream').disabled = busy || !connected || !rule || isMarket(rule) || rule.stream.continuity !== 'continuous' || terminal(rule);
  $('find-token').disabled = busy || !connected || !!openPosition();
  if ($('close-position')) $('close-position').disabled = busy || !connected || !openPosition() || openPosition().status === 'close_requested';
  $('confirm-revoke').disabled = busy || !connected;
  $('create-form').querySelector('button[type=submit]').setAttribute('aria-busy', String(busy));
  $('send-price').setAttribute('aria-busy', String(busy));
  renderTelegram();
  $('connection-text').textContent = connected ? 'Сохранено локально' : 'Нет связи с сервером';
  $('connection-dot').classList.toggle('offline', !connected);
  if (!connected && !$('market-card').hidden) $('market-status').textContent = 'Нет связи с панелью';
  $('console-hint').textContent = !rule ? 'Сначала создайте правило.' : rule.stream.continuity !== 'continuous' ? 'Сначала разрешите остановку потока.'
    : terminal(rule) ? 'Попытка закрыта. Для нового теста создайте отдельное правило.'
      : rule.state === 'active' ? 'Событие получит текущее время и сохранится в журнале.' : 'Цена сохранится, но выключенное правило не исполнится.';
}
function formMode() {
  const marketMode = $('data-mode').value === 'market-paper';
  $('scenario').querySelector('[value=virtual-position]').disabled = !marketMode;
  if (!marketMode) $('scenario').value = 'condition-only';
  const positionMode = marketMode && $('scenario').value === 'virtual-position';
  $('position-fields').hidden = !positionMode;
  $('expiry-label').textContent = positionMode ? 'Срок ожидания входа' : 'Срок действия';
  $('synthetic-fields').hidden = marketMode;
  $('market-fields').hidden = !marketMode;
  $('threshold').parentElement.querySelector('span').textContent = marketMode ? 'USD / токен' : quote;
  $('amount').parentElement.querySelector('span').textContent = marketMode ? 'USD · виртуально' : quote;
  document.querySelector('label[for="amount"]').textContent = marketMode ? 'Виртуальная сумма' : 'Сумма покупки';
  $('threshold-help').textContent = marketMode ? 'До 9 знаков после запятой. Условие проверяется только на новых полученных снимках.' : 'За 1 условную единицу актива';
  $('amount').closest('div').parentElement.querySelector('.help').textContent = marketMode ? 'Виртуальная сумма, без расчёта количества токенов и цены исполнения' : 'Условная валюта, не SOL и не USD';
  $('form-limits').textContent = marketMode ? 'Подтверждается только условие на полученном priceUsd. Покупка, комиссия, min-out и доходность не рассчитываются. Пропущенные движения не восстанавливаются.' : 'Ограничения имитации: комиссия до 0,01 DEMO:QUOTE-A; получение не меньше 1 условной единицы актива. Это не рыночная котировка.';
  if (positionMode) {
    $('amount').closest('div').parentElement.querySelector('.help').textContent = 'Тестовая сумма USD для расчётной модели позиции';
    $('form-limits').textContent = 'Вход и выход рассчитываются по новым снимкам закреплённого пула. Без исполнения, комиссий и проскальзывания. Срок ограничивает только ожидание входа.';
  }
  $('demo-console').hidden = marketMode || isMarket(current()) && !creating;
  document.querySelector('.workspace').classList.toggle('market-mode', $('demo-console').hidden);
}
function renderMarket() {
  const s = model?.market;
  $('market-card').hidden = $('data-mode').value !== 'market-paper' && !isMarket(current());
  if (!s) return;
  const statuses = { idle: 'Ожидаем mint', waiting: 'Ожидаем времени опроса', loading: 'Загрузка…', fresh: 'Снимок получен', stale: 'Наблюдение устарело', error: 'Ошибка · повторим опрос', no_data: 'Нет поддерживаемых данных' };
  $('market-status').textContent = statuses[s.status] ?? s.status;
  $('market-status').className = `state-pill ${s.status === 'fresh' ? 'active' : s.status === 'idle' ? '' : 'unknown'}`;
  $('market-availability').textContent = s.snapshotUsable ? openPosition() ? 'Снимок пригоден для наблюдения позиции. Источник и пул закреплены до закрытия.' : 'Имеющийся снимок пригоден для формы нового правила.'
    : 'Пригодного снимка для нового правила пока нет. Дождитесь свежих данных выбранного mint и пула.';
  const b = s.binding;
  $('market-info').innerHTML = s.mint ? `<p><strong>${escape(s.token?.name || 'Токен')}${s.token?.symbol ? ` · ${escape(s.token.symbol)}` : ''}</strong></p><p>Mint: <code>${escape(s.mint)}</code></p>${b ? `<p>Источник: DEX Screener · площадка: PumpSwap (по данным индекса)</p><p>Пул: <code>${escape(b.pairAddress)}</code></p><p>Пара: <code>${escape(b.mint)}</code> / WSOL <code>${escape(b.quoteMint)}</code></p><p>Котировка условия: USD за токен (priceUsd), оценка агрегатора, не WSOL и не цена исполнения.</p>` : ''}` : '<p class="muted">Введите mint в форме и нажмите «Загрузить токен».</p>';
  const errors = { NO_SUPPORTED_POOL: 'Нет индексируемого пула PumpSwap токен/WSOL для этого mint или закреплённый пул больше не возвращается. Другие площадки, обратные пары и bonding curve не поддерживаются. Пул автоматически не заменяется.',
    PRICE_UNAVAILABLE_OR_UNSUPPORTED_PRECISION: 'Источник не вернул подходящую цену USD. Поддерживаются положительные значения до 9 знаков после запятой без округления; слишком малые или точные цены не используются.' };
  $('market-error').textContent = s.error ? (errors[s.error] ?? `Источник недоступен (${s.error}). Виртуальные сигналы не создаются из старой цены; ожидаем новый успешный опрос.`) :
    s.recoveries ? 'Опрос восстановлен. Пропущенные движения неизвестны; используется только новый снимок.' : '';
  $('market-price').textContent = s.snapshot ? `${s.snapshot.rawPriceUsd} USD / токен${s.stale ? ' · устарело' : ''}` : 'Цена пока недоступна';
  const polling = s.pollStatus === 'loading' ? 'Выполняется очередной запрос.' : s.pollStatus === 'waiting'
    ? `Ожидаем разрешённого времени следующего опроса: не раньше ${time(s.nextPollAtMs)}.` : 'Следующий опрос запланирован.';
  $('market-times').textContent = `${s.snapshot ? `Получено ${date(s.snapshot.receivedAtMs)}, ${time(s.snapshot.receivedAtMs)}. Начало запроса ${time(s.snapshot.observedAtMs)}. Время цены у источника неизвестно. ` : ''}${s.mint ? `${polling} Интервал от ${s.pollIntervalMs / 1000} с.` : ''}`;
}
function clearErrors() {
  marketFormError = null;
  document.querySelectorAll('[data-error]').forEach(el => { el.textContent = ''; });
  document.querySelectorAll('[aria-invalid]').forEach(el => el.removeAttribute('aria-invalid'));
}
function clearRecoveredMarketError() {
  const s = model?.market;
  if (!marketFormError || $('data-mode').value !== 'market-paper' || !s?.snapshotUsable ||
      s.mint !== marketFormError.mint || $('mint').value.trim() !== marketFormError.mint) return;
  const previous = marketFormError;
  marketFormError = null;
  document.querySelector('[data-error="mint"]').textContent = '';
  $('mint').removeAttribute('aria-invalid');
  // Do not erase other field errors or an unrelated command/network failure.
  if (![...document.querySelectorAll('[data-error]')].some(el => el.textContent) &&
      $('feedback').classList.contains('error') && $('feedback').textContent === previous.message) {
    feedback('Свежий снимок доступен. Можно повторить создание правила с указанными параметрами.');
  }
}
function showFields(fields) {
  for (const [name, message] of Object.entries(fields)) {
    const output = document.querySelector(`[data-error="${name}"]`);
    if (output) { output.textContent = message; document.querySelector(`[name="${name}"]`)?.setAttribute('aria-invalid', 'true'); }
  }
  document.querySelector('[aria-invalid=true]')?.focus();
}
function renderRule(rule) {
  if (!rule) return;
  const marketRule = isMarket(rule), quote = quoteFor(rule), money = units => formatFor(rule, units);
  const config = rule.config, last = rule.operations.at(-1), unknown = rule.operations.some(op => op.status === 'unknown');
  let notice = '';
  if (unknown) notice += '<div class="notice"><strong>Исход операции неизвестен</strong>Имитатор не сообщил подтверждённый результат. Повторная покупка по этому правилу запрещена, в том числе после перезапуска или проверки потока. Можно изучить журнал и окончательно отозвать правило.</div>';
  if (rule.stream.continuity === 'decision_required') {
    const reason = rule.stream.issue.reason === 'demo_stream_interruption' ? 'В DEMO вручную запрошена проверка непрерывности потока.'
      : rule.stream.issue.reason === 'history_unavailable' ? 'Источник не подтвердил доступность необходимой истории.' : 'Нарушены порядок, идентичность или непрерывность событий.';
    notice += `<div class="notice"><strong>Поток требует решения владельца</strong>${reason} Автоматическое исполнение приостановлено. Проверка доступного журнала не исполнит накопленные сигналы и не снимет неизвестный исход.
      <div class="notice-actions"><button class="button secondary" type="button" data-action="retry_history">Проверить историю</button><button class="button secondary" type="button" disabled title="Нет проверяемого контракта новой точки отсчёта">Принять пропуск · недоступно</button></div></div>`;
  } else if (rule.state === 'draft') notice += `<div class="notice neutral"><strong>Правило создано, но ещё не включено</strong>${marketRule ? 'Включите его. Условие проверится по следующему свежему полученному снимку закреплённого пула.' : 'Включите его, затем передайте тестовую цену через DEMO-пульт.'}</div>`;
  else if (rule.state === 'active') notice += `<div class="notice neutral"><strong>Ожидаем подходящую цену</strong>${marketRule ? 'Только виртуальное срабатывание на полученном priceUsd. Опрос автоматически продолжается, пока работает сервер; пропущенные движения неизвестны.' : 'Включённое правило выполнит только одну попытку покупки. Все проверки и исполнение здесь синтетические.'}</div>`;
  else if (rule.state === 'paused' && !unknown) notice += '<div class="notice neutral"><strong>Новые операции приостановлены</strong>Для продолжения явно включите правило. Уже отправленная операция, если она есть, не отменяется паузой.</div>';
  else if (last?.status === 'failed') notice += '<div class="notice"><strong>Попытка завершилась неудачей</strong>Это правило больше не исполняется. Автоматического повторения не будет.</div>';
  else if (rule.state === 'revoked' && !unknown) notice += '<div class="notice neutral"><strong>Правило окончательно отозвано</strong>Включить его снова нельзя. История событий и операций сохранена.</div>';
  let buttons = '';
  if (['draft', 'paused'].includes(rule.state) && !rule.submittedOperationId && (marketRule || rule.stream.continuity === 'continuous')) buttons += '<button class="button primary" data-action="enable" type="button">Включить правило →</button>';
  if (rule.state === 'active') buttons += '<button class="button secondary" data-action="pause" type="button">Приостановить</button>';
  if (!terminal(rule)) buttons += '<button class="button danger-outline" data-action="revoke" type="button">Отозвать правило</button>';
  if (terminal(rule) && !openPosition()) buttons += `<button class="button primary" data-action="new" type="button">${marketRule ? 'Новое правило' : 'Новое DEMO-правило'} →</button>`;
  $('rule-card').innerHTML = `<div class="card-heading"><div><p class="eyebrow">${marketRule ? 'РЫНОЧНЫЕ СНИМКИ · ВИРТУАЛЬНО' : 'СИНТЕТИЧЕСКАЯ РАЗОВАЯ ПОКУПКА'}</p><h2>Ваше правило</h2></div>${pill(rule.state)}</div>
    ${config.position ? `<p class="help">Сценарий: виртуальная позиция. Тейк-профит ${displayDecimal(config.position.takeProfitBps / 100)}%, стоп-лосс ${displayDecimal(config.position.stopLossBps / 100)}%. Срок ограничивает ожидание входа; завершение входного правила не закрывает позицию.</p>` : ''}
    <div class="rule-asset"><span class="asset-mark" aria-hidden="true">${escape(config.assetId.slice(-1))}</span>${escape(config.assetId)}</div>
    <div class="rule-grid"><div><p class="label">Цена не выше</p><p class="value">${money(config.condition.thresholdUnits)}<small>${quote} за 1 ед. актива</small></p></div>
    <div><p class="label">${marketRule ? 'Виртуальная сумма' : 'Сумма покупки'}</p><p class="value">${money(config.amountUnits)}<small>${quote}</small></p></div>
    <div><p class="label">${config.position ? 'Ожидание входа до' : 'Действует до'}</p><p class="value">${date(config.expiresAtMs)}<small>По местному времени браузера</small></p></div>
    <div><p class="label">Результат операции</p><p class="value" id="operation-result">${last ? escape(operationLabel(rule, last)) : 'Ещё нет операции'}<small>${marketRule ? last?.status === 'succeeded' ? config.position ? 'Модельный вход сохранён отдельно от состояния позиции; реальной покупки нет' : 'Только проверка условия на полученной цене; покупка не проводилась' : 'Отдельно от состояния правила; реальные сделки не выполняются' : last ? 'Отдельно от состояния правила' : 'Покупка пока не передавалась имитатору'}</small></p></div></div>
    ${notice}<div class="rule-actions">${buttons}</div>${marketRule ? `<p class="help">Источник закреплён: DEX Screener, PumpSwap, пул <code>${escape(config.market.pairAddress)}</code>. ${config.position ? 'Расчётная позиция показана отдельно; реальное исполнение и onchain-баланс не моделируются.' : 'Виртуальная сумма — параметр правила; цена исполнения неизвестна. Нет расчёта исполнения, получения токенов или доходности.'} Возраст локального наблюдения ≤ 45 с, возраст цены агрегатора неизвестен.</p>` : `<details class="rule-detail"><summary>Ограничения имитации</summary><p>Общий расход ≤ ${money(config.limits.maxTotalSpendUnits)} ${quote}; комиссия ≤ ${money(config.limits.maxFeeUnits)} ${quote}; получение ≥ ${config.limits.minReceiveUnits} услов. ед. актива. Возраст события ≤ ${config.limits.maxEventAgeMs / 1000} с. Проверки локальные, не блокчейн.</p></details>`}`;
  const lastEvent = rule.events.filter(entry => entry.sourceRecord).at(-1);
  const observed = marketRule ? positionFor(rule)?.last ?? rule.events.filter(e => e.marketSnapshot).at(-1)?.marketSnapshot : null;
  $('last-price').textContent = marketRule ? observed?.rawPriceUsd ?? '—' : lastEvent ? money(lastEvent.sourceRecord.payload.priceUnits) : '—';
  $('price-unit').textContent = `${quote} за 1 ед. ${config.assetId}`;
  $('price-time').innerHTML = marketRule ? observed ? `<strong>Получено ${time(observed.receivedAtMs)}</strong>Время цены неизвестно${positionFor(rule)?.status !== 'closed' && positionFor(rule) && !positionFor(rule).valuationAvailable ? '<br>Нет актуальной оценки позиции' : ''}${model.now - observed.observedAtMs > 45_000 ? '<br>Локальное наблюдение устарело' : ''}` : 'Ожидаем новый<br>рыночный снимок' : lastEvent ? `<strong>Получено ${time(lastEvent.result.receivedAtMs)}</strong>Возникло ${time(lastEvent.sourceRecord.occurredAtMs)}` : 'Ожидаем первое<br>тестовое событие';
}
function renderJournal() {
  const rows = [];
  for (const rule of model.rules) {
    const marketRule = isMarket(rule), quote = quoteFor(rule), money = units => formatFor(rule, units);
    const archived = rule.config.id !== model.currentRuleId;
    const suffix = `${rule.config.assetId}${archived ? ' · предыдущее правило' : ''}`;
    rows.push({ at: rule.createdAtMs, rank: 0, icon: '+', title: 'Правило создано', description: `${suffix} · ${marketRule ? 'рыночные снимки, виртуальное условие' : 'синтетическая разовая покупка'}`, status: '' });
    for (const entry of rule.events.filter(e => e.marketSnapshot)) rows.push({ at: entry.marketSnapshot.receivedAtMs, rank: 1, icon: '⌁', title: `Наблюдение ${entry.marketSnapshot.rawPriceUsd} USD / токен`,
      description: `${dispositions[entry.result.disposition] ?? 'Снимок обработан'} · DEX Screener · пул ${entry.marketSnapshot.pairAddress} · локальный ID наблюдения ${entry.marketSnapshot.id}`, status: '' });
    for (const event of rule.events.filter(e => e.sourceRecord)) rows.push({ at: event.result.receivedAtMs, rank: 1, icon: '⌁',
      title: `Цена ${money(event.sourceRecord.payload.priceUnits)} ${quote}`, description: `${dispositions[event.result.disposition] ?? 'Событие обработано'} · ${suffix}`, status: '' });
    for (const op of rule.operations) {
      let description = `Операция ${op.id.replace('demo-operation-', '')} · ${suffix}`;
      if (op.result?.receipt) description += ` · расход ${money(op.result.receipt.spentUnits)} ${quote}, получение ${op.result.receipt.receivedUnits} услов. ед.`;
      if (op.status === 'unknown') description += ' · повтор запрещён';
      rows.push({ at: op.updatedAtMs, rank: 2, icon: op.status === 'succeeded' ? '✓' : op.status === 'unknown' ? '?' : '→',
        title: op.status === 'succeeded' ? marketRule ? operationLabel(rule, op) : 'Покупка имитирована' : `Операция: ${labels[op.status]}`, description: description + (marketRule ? ' · покупка не проводилась, цена исполнения неизвестна' : ''), status: op.status, statusLabel: operationLabel(rule, op) });
    }
    for (const entry of rule.decisions) rows.push({ at: entry.decidedAtMs, rank: 3, icon: '↻', title: entry.outcome === 'history_verified' ? 'История проверена владельцем DEMO'
      : entry.outcome === 'rule_revoked' ? 'Правило окончательно отозвано' : 'Решение по потоку сохранено',
      description: `${suffix} · ${entry.outcome === 'history_verified' ? 'Нужны отдельное включение и свежие данные' : 'История решения сохранена'}`, status: '' });
  }
  for (const p of model.positions ?? []) {
    for (const observation of p.observations) rows.push({ at: observation.snapshot.receivedAtMs, rank: 1, icon: '⌁',
      title: `Наблюдение позиции ${observation.snapshot.rawPriceUsd} USD / токен`,
      description: `${p.id} · ${observation.disposition === 'closed' ? 'Снимок стал основанием выхода' : observation.disposition === 'valued' ? 'Оценка обновлена, выход не выполнен' : 'Не использован для оценки и выхода'} · пул ${p.binding.pairAddress} · локальный ID ${observation.snapshot.id}`, status: '' });
    rows.push({ at: p.openedAtMs, rank: 4, icon: '↗', title: 'Открыта виртуальная позиция', description: `${p.id} · модельный вход ${p.display.entry} USD, сумма ${p.display.amount} USD`, status: '' });
    if (p.closeRequest) rows.push({ at: p.closeRequest.requestedAtMs, rank: 4, icon: '→', title: 'Запрос закрытия сохранён', description: `${p.id} · ожидается новый пригодный снимок`, status: '' });
    if (p.exit) rows.push({ at: p.exit.closedAtMs, rank: 5, icon: '✓', title: `Виртуальная позиция закрыта · ${exitLabels[p.exit.reason]}`, description: `${p.id} · модельный результат ${p.display.pnlUsd} USD · ${p.display.pnlPercent}%`, status: '' });
  }
  rows.sort((a, b) => b.at - a.at || b.rank - a.rank);
  $('journal-count').textContent = `Всего: ${rows.length}`;
  if (rows.length) $('journal-list').innerHTML = rows.slice(0, 40).map(row => `<div class="log-row"><span class="log-icon" aria-hidden="true">${escape(row.icon)}</span><div><p class="log-title">${escape(row.title)}</p><p class="log-description">${escape(row.description)}</p>${row.status ? `<div class="log-meta">${pill(row.status, row.statusLabel)}</div>` : ''}</div><time class="log-time">${time(row.at)}<br>${date(row.at).split(',')[0]}</time></div>`).join('');
  const archived = model.rules.filter(rule => rule.config.id !== model.currentRuleId);
  $('archive').hidden = !archived.length;
  $('archive-list').innerHTML = archived.map(rule => `<div class="archive-row"><span>${escape(rule.config.assetId)} · ${date(rule.createdAtMs)}</span>${pill(rule.state)}</div>`).join('');
}
function renderPositions() {
  const positions = model.positions ?? [], p = openPosition() ?? positions.at(-1);
  $('position-card').hidden = !p;
  if (p) {
    const v = p.display, closed = p.status === 'closed';
    const metric = (label, value) => `<div><p class="label">${label}</p><p class="value">${escape(value)}</p></div>`;
    $('position-card').innerHTML = `<div class="card-heading"><div><p class="eyebrow">ВИРТУАЛЬНО · РАСЧЁТНАЯ МОДЕЛЬ</p><h2>Виртуальная позиция</h2></div>${pill(closed ? 'finished' : 'active', closed ? 'Закрыта' : p.status === 'close_requested' ? 'Ожидаем закрытия' : 'Открыта')}</div>
      <p class="help">Расчёт по цене агрегатора без учёта исполнения, комиссий и проскальзывания. Условное количество не является onchain-балансом.</p>
      <p class="help">Mint: <code>${escape(p.binding.mint)}</code><br>Закреплённый пул: <code>${escape(p.binding.pairAddress)}</code></p>
      <div class="rule-grid">${metric('Сумма входа', displayDecimal(v.amount) + ' USD')}${metric('Условное количество', displayDecimal(v.quantity) + ' токенов')}${metric('Модельная цена входа', displayDecimal(v.entry) + ' USD / токен')}
      ${metric(closed ? 'Модельная цена выхода' : 'Последняя оценка цены', p.valuationAvailable ? displayDecimal(v.price) + ' USD / токен' : 'Нет актуальной оценки')}
      ${metric(closed ? 'Оценка при закрытии' : 'Оценка позиции', p.valuationAvailable ? displayDecimal(v.valuation) + ' USD' : 'Нет актуальной оценки')}
      ${metric(closed ? 'Сохранённый результат' : 'Модельный результат', p.valuationAvailable ? displayDecimal(v.pnlUsd) + ' USD · ' + displayDecimal(v.pnlPercent) + '%' : 'Ожидаем новый пригодный снимок')}
      ${metric('Тейк-профит / стоп-лосс', displayDecimal(v.takeProfit) + ' / ' + displayDecimal(v.stopLoss) + ' USD / токен')}</div>
      <p class="help">Вход: ${date(p.entry.receivedAtMs)} · ${time(p.entry.receivedAtMs)}. ${closed ? `Выход: ${date(p.exit.snapshot.receivedAtMs)} · ${time(p.exit.snapshot.receivedAtMs)}. ${exitLabels[p.exit.reason]}.` : 'Срок ожидания входа больше не ограничивает позицию. Источник и пул закреплены до закрытия.'}</p>
      ${!closed ? `<div class="notice neutral"><strong>${p.status === 'close_requested' ? 'Запрос закрытия сохранён' : 'Наблюдение позиции'}</strong>${p.status === 'close_requested' ? 'Расчёт по следующему новому пригодному снимку. Сохранённая старая цена не используется.' : 'Уровни выхода проверяются по новым снимкам. При скачке используется наблюдаемая цена, пропущенные движения неизвестны.'}</div><button class="button primary" id="close-position" type="button">${p.status === 'close_requested' ? 'Ожидаем снимок для закрытия' : 'Закрыть виртуальную позицию'}</button>` : ''}`;
  }
  const closed = positions.filter(p => p.status === 'closed');
  $('position-history').hidden = !closed.length;
  $('position-history-list').innerHTML = closed.map(p => `<details class="position-record"><summary>${escape(p.binding.mint)} · ${exitLabels[p.exit.reason]} · ${escape(displayDecimal(p.display.pnlUsd))} USD · ${escape(displayDecimal(p.display.pnlPercent))}%</summary><p class="help">${escape(p.id)}<br>Пул: ${escape(p.binding.pairAddress)}<br>Сумма ${escape(p.display.amount)} USD · количество ${escape(p.display.quantity)} · вход ${escape(p.display.entry)} USD · выход ${escape(p.display.price)} USD<br>Вход ${date(p.entry.receivedAtMs)}, выход ${date(p.exit.snapshot.receivedAtMs)}. Основания и точные дроби сохранены в SQLite.</p></details>`).join('');
}
function render(data, force = false) {
  model = data;
  renderTelegram(); connected = true;
  const next = JSON.stringify([data.currentRuleId, data.rules, data.positions, data.market, Math.floor(data.now / 1000)]);
  if (force || next !== signature) {
    signature = next;
    const rule = current();
    $('create-card').hidden = !!rule && !creating;
    $('rule-card').hidden = !rule || creating;
    $('cancel-create').hidden = !rule;
    renderRule(rule); renderPositions(); renderJournal(); formMode(); renderMarket();
  }
  const rule = current();
  const nextStatus = JSON.stringify([data.currentRuleId, rule?.state, rule?.operations.map(operation => [operation.id, operation.status]), positionFor(rule)?.status, creating]);
  if (nextStatus !== statusSignature) { statusSignature = nextStatus; renderMarketRuleStatus(); }
  clearRecoveredMarketError();
  updateControls();
}
async function load() {
  const version = revision;
  try {
    const response = await fetch('/api/state');
    const data = await response.json();
    if (!response.ok) throw new Error(data.message);
    if (!busy && version === revision) {
      const restored = !connected && !!model;
      render(data);
      if (restored && !renderMarketRuleStatus()) feedback('Соединение восстановлено. Показано сохранённое состояние.');
    }
  } catch (error) {
    if (version === revision) { connected = false; updateControls(); feedback(error.message === 'Failed to fetch' ? 'Сервер недоступен. Показаны последние полученные данные; действия остановлены.' : error.message, 'error'); }
  }
}
async function mutate(path, body, { form = null, message = '' } = {}) {
  if (busy || !connected) return;
  busy = true; revision++; clearErrors(); feedback('Сохраняем и обрабатываем запрос…'); updateControls();
  const identity = JSON.stringify([path, body]);
  if (!pendingKeys.has(identity)) pendingKeys.set(identity, crypto.randomUUID());
  try {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, requestId: pendingKeys.get(identity) }) });
    const data = await response.json();
    if (!response.ok) {
      showFields(data.fields ?? {});
      if (path === '/api/rules' && data.fields?.mint) marketFormError = { mint: body.mint, message: data.message };
      throw new Error(data.message);
    }
    pendingKeys.delete(identity); if (path !== '/api/market/select') creating = false; render(data, true);
    if (form === 'price') {
      const disposition = data.delivery?.disposition;
      const rule = current(), operation = rule.operations.at(-1);
      const text = disposition === 'prepared' && operation ? operation.status === 'succeeded' ? 'Условие выполнено. Имитатор сообщил об успешной покупке.'
        : operation.status === 'failed' ? 'Условие выполнено. Имитатор сообщил о неудаче; автоматического повтора нет.' : 'Условие выполнено, но исход неизвестен. Повторная попытка заблокирована.'
        : dispositions[disposition] ?? 'Событие обработано. Состояние сохранено.';
      feedback(text, operation?.status === 'unknown' || operation?.status === 'failed' ? 'warning' : '');
    } else if (data.decisionResult?.decision === 'retry_history') {
      const result = data.decisionResult;
      const unknown = current().operations.some(op => op.status === 'unknown');
      if (result.outcome !== 'history_verified') feedback(result.outcome === 'terminal_rule' ? 'Правило уже закрыто или его срок истёк. Исполнение не возобновлено.' : 'Историю не удалось подтвердить. Исполнение остаётся остановленным.', 'warning');
      else if (unknown) feedback('История потока проверена. Неизвестный исход операции сохраняется; повторное исполнение правила запрещено.', 'warning');
      else if (terminal(current())) feedback('История проверена, но правило уже закрыто. Включить его снова нельзя.', 'warning');
      else feedback('История проверена. Для продолжения явно включите правило и передайте новое свежее событие.');
    } else if (path !== '/api/market/select' && renderMarketRuleStatus()) { /* Current persisted rule/operation state is the status message. */ }
    else feedback(path === '/api/market/select' && data.market.error ? 'Рыночные данные не загружены. Причина показана в карточке источника; синтетической подмены нет.' : path === '/api/market/select' && data.market.snapshotUsable ? 'Снимок выбранного mint и пула пригоден. Ожидание следующего опроса не мешает созданию правила.' : path === '/api/market/select' && data.market.pollStatus === 'waiting' ? 'Mint выбран. Новый запрос запланирован с соблюдением интервала; ожидаем данные.' : message || 'Изменение сохранено.', data.market?.error && path === '/api/market/select' ? 'warning' : '');
  } catch (error) {
    feedback(error.message === 'Failed to fetch' ? 'Связь прервалась. Исход запроса не подтверждён. Обновите состояние; повтор того же действия использует прежний ключ запроса.' : error.message, 'error');
  } finally { busy = false; updateControls(); }
}
$('create-form').addEventListener('submit', event => {
  event.preventDefault(); mutate('/api/rules', Object.fromEntries(new FormData(event.currentTarget)), { message: 'Правило создано. Теперь включите его.' });
});
$('position-card').addEventListener('click', event => {
  if (event.target.closest('#close-position') && !event.target.disabled && openPosition()) mutate(`/api/positions/${openPosition().id}/close`, {});
});
$('scenario').addEventListener('change', () => { clearErrors(); formMode(); });
$('price-form').addEventListener('submit', event => {
  event.preventDefault(); if (current()) mutate(`/api/rules/${current().config.id}/price`, Object.fromEntries(new FormData(event.currentTarget)), { form: 'price' });
});
$('rule-card').addEventListener('click', event => {
  const button = event.target.closest('[data-action]'); if (!button || button.disabled) return;
  const action = button.dataset.action, rule = current();
  if (action === 'new') { creating = true; render(model, true); clearErrors(); $('create-card').querySelector('h2').textContent = 'Новое правило'; $('data-mode').focus(); return; }
  if (action === 'revoke') { revokeTarget = { ruleId: rule.config.id, incidentId: rule.stream.continuity === 'decision_required' ? rule.stream.issue.id : undefined }; $('revoke-dialog').showModal(); return; }
  const incidentId = rule.stream.continuity === 'decision_required' ? rule.stream.issue.id : undefined;
  mutate(`/api/rules/${rule.config.id}/${action}`, { incidentId }, { message: action === 'enable' ? 'Правило включено. Передайте тестовую цену через DEMO-пульт.'
    : action === 'pause' ? 'Новые операции приостановлены. Переданная операция не отменяется.' : 'История проверена. Для продолжения нужны явное включение и свежие данные; неизвестный исход остаётся заблокированным.' });
});
$('confirm-revoke').addEventListener('click', () => {
  $('revoke-dialog').close();
  mutate(`/api/rules/${revokeTarget.ruleId}/revoke`, { incidentId: revokeTarget.incidentId }, { message: 'Правило окончательно отозвано. История и исход ранее переданной операции сохранены.' });
});
$('cancel-revoke').addEventListener('click', () => $('revoke-dialog').close());
$('cancel-create').addEventListener('click', () => { creating = false; render(model, true); });
$('interrupt-stream').addEventListener('click', () => mutate(`/api/rules/${current().config.id}/demo-interruption`, {}, { message: 'Создан DEMO-случай проверки истории. Исполнение остановлено до решения владельца.' }));
$('refresh').addEventListener('click', load);
$('data-mode').addEventListener('change', () => { $('threshold').value = $('data-mode').value === 'market-paper' ? '' : '1.00'; clearErrors(); formMode(); renderMarket(); });
$('find-token').addEventListener('click', () => {
  $('market-card').hidden = false;
  if (model?.market?.mint !== $('mint').value.trim() || !model.market.snapshotUsable) $('market-status').textContent = 'Загрузка…';
  mutate('/api/market/select', { mint: $('mint').value.trim() }, { message: 'Источник загружен. Укажите своё тестовое условие в USD, создайте и включите правило.' });
});
load(); setInterval(() => { if (!busy) load(); }, 2000);

function renderTelegram() {
  const t = model?.telegram; if (!t) return;
  const states = { disabled: 'Не настроен: добавьте TELEGRAM_BOT_TOKEN в локальный .env по инструкции', connecting: 'Подключение…', connected: 'Соединение работает', retrying: 'Telegram недоступен; повторим подключение', token_error: 'Ошибка доступа к боту: проверьте токен и права', conflict: 'Другой экземпляр получает updates: остановите его', storage_error: 'Ошибка хранения Telegram: действия остановлены' };
  $('telegram-status').textContent = `${states[t.connection] ?? t.connection}. ${t.linked ? 'Владелец привязан' : 'Владелец не привязан'}. В очереди: ${t.queued}; не доставлено: ${t.failed}.`;
  $('telegram-code').disabled = busy || !connected || !t.configured || t.linked;
  $('telegram-unlink').disabled = busy || !connected || !t.linked && !t.codeExpiresAtMs;
  if (t.linked || !t.codeExpiresAtMs || t.codeExpiresAtMs <= model.now) $('telegram-link').textContent = '';
  if (model.telegramLink) $('telegram-link').textContent = `В личном чате своего бота отправьте /start ${model.telegramLink.code} (до ${time(model.telegramLink.expiresAtMs)}). Код одноразовый; не передавайте его другим.`;
}
$('telegram-code').addEventListener('click', () => mutate('/api/telegram/code', {}));
$('telegram-unlink').addEventListener('click', () => mutate('/api/telegram/unlink', {}, { message: 'Привязка отключена. Старые кнопки больше не дают доступа.' }));
