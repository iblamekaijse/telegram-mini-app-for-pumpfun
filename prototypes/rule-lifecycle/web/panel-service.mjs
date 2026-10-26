import { TelegramController } from './telegram.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { RuleEngine } from '../rule-engine.mjs';
import { SimulatedExecutor } from '../simulator.mjs';
import { SyntheticSource } from '../synthetic-source.mjs';
import { SourceConsumer } from '../source-consumer.mjs';
import { createTrustedDemoOwnerContext } from '../demo-owner.mjs';
import { DEMO_PRICE_BASIS } from '../fixtures.mjs';
import { MarketSnapshots, STALE_MS } from './market-source.mjs';
import { mintValid, decimalUnits, MARKET_PRICE_BASIS } from '../market-contract.mjs';

import { positionValues, formatRational } from '../position-model.mjs';

export const ASSETS = ['DEMO:ASSET-A', 'DEMO:ASSET-B'];
const outcomes = ['succeeded', 'failed', 'unknown'];
export class PanelError extends Error {
  constructor(code, message, fields = {}, status = 400) {
    super(message); this.code = code; this.fields = fields; this.status = status;
  }
}
function requestKey(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,64}$/.test(value)) throw new PanelError('INVALID_REQUEST_ID', 'Не удалось распознать запрос. Повторите действие.');
  return value;
}
function money(value, field) {
  const text = String(value ?? '').trim().replace(',', '.');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(text)) throw new PanelError('INVALID_FIELDS', 'Проверьте поля формы.', { [field]: 'Введите положительное число, не больше двух знаков после запятой.' });
  const [whole, fraction = ''] = text.split('.');
  const units = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (units < 1) throw new PanelError('INVALID_FIELDS', 'Проверьте поля формы.', { [field]: 'Значение должно быть больше нуля.' });
  return units;
}

/** Thin local UI adapter. All rule/operation decisions remain in RuleEngine. */
export async function createPanelService({ dataDir, clock = Date.now, marketFetch = fetch, telegramConfigured = false }) {
  let initialize = false;
  try { mkdirSync(dataDir); initialize = true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  let engine;
  class PanelSimulator extends SimulatedExecutor {
    submit(intent) {
      const operation = engine.getOperation(intent.operationId);
      if (operation.event.type === 'market-price-snapshot') return { mode: 'demo', status: 'succeeded', kind: 'virtual-condition', reason: 'observed_condition_only' };
      const outcome = operation.event.sourceEvent?.demoOutcome;
      if (!outcomes.includes(outcome)) throw new Error('Missing persisted demo outcome');
      return new SimulatedExecutor({ outcome }).submit(intent);
    }
  }
  engine = RuleEngine[initialize ? 'initialize' : 'open']({ storagePath: join(dataDir, 'state.sqlite'), clock, executor: new PanelSimulator() });
  const rules = () => engine.listRules();
  const current = () => rules().at(-1);
  const openPosition = () => engine.listPositions().find(p => p.status !== 'closed');
  const market = new MarketSnapshots({ fetchImpl: marketFetch, clock, binding: openPosition()?.binding ?? current()?.config.market ?? null });
  const history = id => engine.getEventLog(id).filter(e => e.sourceRecord).map(e => e.sourceRecord).sort((a, b) => a.position - b.position);
  const sourceFor = (id, records = history(id)) => new SyntheticSource({ sourceId: engine.getSourceState(id).sourceId, events: records });
  const consumerFor = (id, source = sourceFor(id)) => new SourceConsumer({ engine, ruleId: id, source });
  const ensureBinding = rule => {
    if (rule.config.market) return;
    try { engine.getSourceState(rule.config.id); }
    catch (error) {
      if (error.code !== 'SOURCE_NOT_BOUND') throw error;
      engine.bindSource(rule.config.id, { sourceId: `DEMO:panel-${rule.config.id}` }, { requestId: `bind:${rule.config.id}` });
    }
  };
  try {
    for (const rule of rules()) {
      if (rule.config.panel?.version !== 1) throw new Error('Panel requires its own data directory');
      ensureBinding(rule);
    }
    // The consumer verifies the retained synthetic log before resuming a prepared intent.
    // Opening the engine itself never dispatches; submitted-without-result recovers unknown.
    if (current()?.config.market) {
      // Never replay a cached pre-restart price signal. Unknown remains blocked by the core.
      if (current().pendingOperationId && current().state === 'active') engine.pause(current().config.id, { requestId: `market-restart:${current().pendingOperationId}` });
    } else if (current()) await consumerFor(current().config.id).drain();
  } catch (error) { engine.close(); throw error; }

  let telegram;
  function requireRule(id) {
    if (!rules().some(rule => rule.config.id === id)) throw new PanelError('RULE_NOT_FOUND', 'Правило не найдено.', {}, 404);
    return engine.getRule(id);
  }
  function state() {
    const selected = market.state();
    const positions = engine.listPositions().map(p => {
      const currentValuation = selected.snapshotUsable && selected.snapshot?.id === p.last.id;
      const values = p.exit?.values ?? positionValues(p.amountUnits, p.entry.priceUnits, p.last.priceUnits, p.policy);
      return { ...p, valuationAvailable: p.status === 'closed' || currentValuation,
        display: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, formatRational(value, key === 'quantity' ? 12 : 9)])) };
    });
    return { mode: 'demo', liveTradingAllowed: false, telegram: telegram?.status(), now: clock(), market: selected, positions, currentRuleId: current()?.config.id ?? null,
      rules: rules().map(rule => ({ ...rule, stream: rule.config.market ? { kind: 'snapshots', continuity: 'not_asserted', connected: market.state().status === 'fresh' } : engine.getSourceState(rule.config.id),
        events: engine.getEventLog(rule.config.id), operations: rule.operationIds.map(id => engine.getOperation(id)),
        decisions: engine.getSourceDecisionLog(rule.config.id) })) };
  }
  function create(body) {
    const key = requestKey(body.requestId);
    const id = `web-${key}`, prior = rules().find(rule => rule.config.id === id);
    const isMarket = body.mode === 'market-paper';
    const fields = {};
    const positionScenario = body.scenario === 'virtual-position';
    if (body.scenario !== undefined && !['condition-only', 'virtual-position'].includes(body.scenario)) fields.scenario = 'Выберите сценарий.';
    if (positionScenario && !isMarket) fields.scenario = 'Виртуальная позиция доступна только на рыночных снимках.';
    let position;
    if (positionScenario) {
      const policy = {};
      for (const [field, max] of [['takeProfit', 1_000_000], ['stopLoss', 9999]]) {
        try {
          policy[field + 'Bps'] = money(body[field], field);
          if (policy[field + 'Bps'] > max) throw new Error();
        } catch { fields[field] = field === 'stopLoss' ? 'Процент больше 0 и меньше 100; до двух знаков после запятой.' : 'Процент больше 0 и не выше 10000; до двух знаков после запятой.'; }
      }
      position = { version: 1, ...policy };
    }
    if (body.mode !== undefined && !['demo', 'market-paper'].includes(body.mode)) fields.mode = 'Выберите режим.';
    if (!isMarket && !ASSETS.includes(body.assetId)) fields.assetId = 'Выберите тестовый актив.';
    const selected = market.state();
    const binding = prior?.config.market ?? selected.binding;
    if (isMarket && (!mintValid(body.mint) || binding?.mint !== body.mint || !prior &&
      !selected.snapshotUsable)) fields.mint = 'Сначала загрузите свежую цену этого mint и поддерживаемый пул.';
    const minutes = Number(body.expiresInMinutes);
    if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1440) fields.expiresInMinutes = 'Укажите целое число от 1 до 1440 минут.';
    const values = {};
    for (const field of ['threshold', 'amount']) {
      try {
        values[field] = isMarket && field === 'threshold' ? decimalUnits(String(body[field] ?? '').trim().replace(',', '.')) : money(body[field], field);
        if (isMarket && field === 'amount') values[field] *= 10_000_000;
        if (!Number.isSafeInteger(values[field])) throw new TypeError();
      }
      catch (error) { Object.assign(fields, error.fields ?? { [field]: field === 'threshold' ? 'Положительная цена USD, до 9 знаков после запятой, без округления.' : 'Сумма слишком велика.' }); }
    }
    if (Object.keys(fields).length) throw new PanelError('INVALID_FIELDS', 'Проверьте поля формы.', fields);
    const input = { assetId: isMarket ? `SOLANA:${body.mint}` : body.assetId, thresholdUnits: values.threshold, amountUnits: values.amount, expiresInMinutes: minutes,
      ...(isMarket ? { mode: 'market-paper', market: binding } : {}), ...(position ? { position } : {}) };
    if (prior && JSON.stringify(prior.config.panel.input) !== JSON.stringify(input)) throw new PanelError('IDEMPOTENCY_CONFLICT', 'Этот запрос уже использован с другими параметрами.', {}, 409);
    if (!prior && openPosition()) throw new PanelError('POSITION_ALREADY_OPEN', 'Сначала закройте открытую виртуальную позицию. Источник и пул закреплены.', {}, 409);
    if (!prior && current() && !['finished', 'expired', 'revoked'].includes(current().state)) {
      throw new PanelError('RULE_ALREADY_OPEN', 'Сначала окончательно отзовите текущее правило. Его история сохранится.', {}, 409);
    }
    const config = prior?.config ?? {
      id, assetId: input.assetId,
      condition: { metric: 'priceUnits', operator: 'lte', thresholdUnits: input.thresholdUnits, priceBasis: { ...(isMarket ? MARKET_PRICE_BASIS : DEMO_PRICE_BASIS) } },
      amountUnits: input.amountUnits,
      limits: { maxTotalSpendUnits: input.amountUnits + (isMarket ? 0 : 1), minReceiveUnits: 1, maxFeeUnits: isMarket ? 0 : 1, maxSlippageBps: 50, maxEventAgeMs: isMarket ? STALE_MS : 30_000 },
      expiresAtMs: clock() + minutes * 60_000,
      panel: { version: 1, input },
      ...(isMarket ? { market: binding } : {}), ...(position ? { position } : {}),
    };
    engine.createRule(config, { requestId: `create:${key}` });
    ensureBinding(engine.getRule(id));
    return state();
  }
  async function price(id, body) {
    const rule = requireRule(id);
    if (rule.config.market) throw new PanelError('WRONG_DATA_MODE', 'Реальное наблюдение нельзя заменить ценой из DEMO-пульта.', {}, 409);
    const key = requestKey(body.requestId), priceUnits = money(body.price, 'price');
    if (!outcomes.includes(body.outcome)) throw new PanelError('INVALID_FIELDS', 'Выберите результат имитатора.', { outcome: 'Недопустимый результат.' });
    const records = history(id), eventId = `panel-price-${key}`, prior = records.find(e => e.eventId === eventId);
    if (prior && (prior.payload.priceUnits !== priceUnits || prior.demoOutcome !== body.outcome)) throw new PanelError('IDEMPOTENCY_CONFLICT', 'Этот запрос уже передавал другую цену или результат.', {}, 409);
    if (!prior && current()?.config.id !== id) throw new PanelError('ARCHIVED_RULE', 'Это правило уже в архиве. Выберите текущее правило.', {}, 409);
    if (engine.getSourceState(id).continuity !== 'continuous') throw new PanelError('SOURCE_DECISION_REQUIRED', 'Поток остановлен. Проверьте историю или окончательно отзовите правило.', {}, 409);
    const record = prior ?? { version: 1, sourceId: engine.getSourceState(id).sourceId, eventId,
      position: records.length + 1, assetId: rule.config.assetId, occurredAtMs: clock(), type: 'synthetic-price',
      payload: { ...DEMO_PRICE_BASIS, priceUnits }, demoOutcome: body.outcome };
    const source = sourceFor(id, prior ? records : [...records, record]);
    if (prior) source.replayOnNextConnect([prior.position]);
    const result = await consumerFor(id, source).drain();
    return { ...state(), delivery: result.deliveries.find(d => d.operationId) ?? result.deliveries.at(-1) ?? null };
  }
  function command(id, action, body) {
    const rule = requireRule(id);
    const key = requestKey(body.requestId);
    if (rule.config.market && !['enable', 'pause', 'revoke'].includes(action)) throw new PanelError('NO_SNAPSHOT_HISTORY', 'Снимки не имеют подтверждённого потока истории. Действие недоступно.', {}, 422);
    let decisionResult = null;
    if (action === 'enable' || action === 'pause') engine[action](id, { requestId: `ui:${key}` });
    else if (action === 'revoke' || action === 'retry_history') {
      const stream = rule.config.market ? null : engine.getSourceState(id);
      if (action === 'revoke' && !body.incidentId) engine.revoke(id, { requestId: `ui:${key}` });
      else decisionResult = engine.decideSourceIssue(id, { incidentId: body.incidentId, decision: action }, {
        requestId: `ui:${key}`, source: sourceFor(id),
        // Privileged localhost DEMO bootstrap; never accepts an ownerId/context from JSON.
        ownerContext: createTrustedDemoOwnerContext({ ruleIds: [id], principalId: 'DEMO:local-web-panel' }),
      });
    } else if (action === 'demo-interruption') {
      const prior = engine.getSourceState(id).issue?.details?.requestId === key ||
        engine.getSourceDecisionLog(id).some(entry => entry.issue.details?.origin === 'local-panel-demo' && entry.issue.details.requestId === key);
      if (!prior) engine.reportSourceIssue(id, 'demo_stream_interruption', { origin: 'local-panel-demo', requestId: key });
    } else throw new PanelError('UNSUPPORTED_ACTION', 'Это действие недоступно. Принятие пропуска не реализовано.', {}, 422);
    return { ...state(), decisionResult };
  }
  async function recordMarket(result) {
    const rule = current(), snapshot = result.snapshot, position = openPosition();
    // Only a NEW successful poll can enter this path; cached state is never re-emitted.
    if (snapshot && position) engine.receivePositionSnapshot(position.id, snapshot);
    if (snapshot && rule?.config.market && !['finished', 'expired', 'revoked'].includes(rule.state) &&
      rule.config.market.mint === snapshot.mint && rule.config.market.pairAddress === snapshot.pairAddress) {
      const delivery = engine.receiveMarketSnapshot(rule.config.id, snapshot);
      if (delivery.disposition === 'prepared') await engine.executePrepared(delivery.operationId, { requestId: `observe:${snapshot.id}` });
    }
    return state();
  }
  async function selectMarket(body) {
    if (!mintValid(body.mint)) throw new PanelError('INVALID_FIELDS', 'Проверьте mint-адрес.', { mint: 'Нужен Solana-адрес: Base58, ровно 32 байта.' });
    if (openPosition()) throw new PanelError('POSITION_ALREADY_OPEN', 'Источник и пул закреплены открытой позицией. Дождитесь её закрытия.', {}, 409);
    if (current() && !['finished', 'expired', 'revoked'].includes(current().state)) throw new PanelError('RULE_ALREADY_OPEN', 'Сначала завершите или окончательно отзовите текущее правило. Его источник закреплён.', {}, 409);
    const result = await market.select(body.mint);
    if (result.limited) throw new PanelError('MARKET_RATE_LIMIT', 'Следующий запрос будет доступен после показанного времени опроса.', {}, 429);
    return recordMarket(result);
  }
  const closePosition = (id, body) => { engine.requestPositionClose(id, { requestId: `close:${requestKey(body.requestId)}` }); return state(); };
  telegram = new TelegramController({ engine, view: state, command, closePosition, clock, configured: telegramConfigured });
  telegram.resume();
  const sync = fn => (...args) => { try { return fn(...args); } finally { telegram.reconcile(); } };
  const asyncSync = fn => async (...args) => { try { return await fn(...args); } finally { telegram.reconcile(); } };
  return { state, telegram, create: sync(create), price: asyncSync(price), command: sync(command), selectMarket: asyncSync(selectMarket),
    closePosition: sync(closePosition),
    pollMarket: asyncSync(async () => current() && !current().config.market && !['finished', 'expired', 'revoked'].includes(current().state) ? state() : recordMarket(await market.poll())),
    close: () => engine.close() };
}
