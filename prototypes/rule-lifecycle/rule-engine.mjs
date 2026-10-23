import { SimulatedExecutor } from './simulator.mjs';
import { SnapshotStore, StorageError } from './snapshot-store.mjs';
import { emptySnapshot, validateSnapshot } from './state-schema.mjs';
import { canonical, priceBasisValid, sourceIdValid, sourceEventValid, samePriceBasis } from './event-contract.mjs';
import { authorizedDemoPrincipal } from './demo-owner.mjs';
import { SyntheticSource } from './synthetic-source.mjs';
import { assetValid, marketBindingValid, marketSnapshotValid, MARKET_PRICE_BASIS } from './market-contract.mjs';

import { positionPolicyValid, positionValues, exitReason, sameBinding } from './position-model.mjs';

export const LIVE_TRADING_ALLOWED = false;
const terminalRules = new Set(['finished', 'expired', 'revoked']);

export class RuleError extends Error {
  constructor(code, message = code) { super(message); this.name = 'RuleError'; this.code = code; }
}

function requireValue(condition, code) {
  if (!condition) throw new RuleError(code);
}
function integer(value, min = 0) { return Number.isSafeInteger(value) && value >= min; }
function identifier(value) { return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 128; }
function asset(value) { return identifier(value) && assetValid(value); }
function frozenCopy(value) {
  function freeze(object) {
    if (object && typeof object === 'object') {
      Object.values(object).forEach(freeze);
      Object.freeze(object);
    }
    return object;
  }
  return freeze(structuredClone(value));
}

/** Optional durable local lifecycle. Every execution path is simulation-only. */
export class RuleEngine {
  #clock;
  #executor;
  #rules = new Map();
  #operations = new Map();
  #positions = new Map();
  #startedAt;
  #commands = new Map();
  #events = new Map();
  #streams = new Map();
  #connectedStreams = new Set();
  #inFlight = new Map();
  #nextOperation = 1;
  #nextIncident = 1;
  #sourceDecisions = [];
  #store;
  #storageFailure;
  #closed = false;
  #faultInjector;

  constructor({ clock = Date.now, executor = new SimulatedExecutor(), mode = 'demo',
    storagePath, createStorage = false, faultInjector = () => {} } = {}) {
    requireValue(mode === 'demo', 'LIVE_TRADING_CLOSED');
    requireValue(executor instanceof SimulatedExecutor, 'SIMULATOR_REQUIRED');
    requireValue(typeof clock === 'function', 'INVALID_CLOCK');
    this.#clock = clock;
    this.#startedAt = this.#now();
    this.#executor = executor;
    requireValue(typeof faultInjector === 'function', 'INVALID_FAULT_INJECTOR');
    this.#faultInjector = faultInjector;
    if (createStorage) requireValue(typeof storagePath === 'string' && storagePath.length > 0, 'STORAGE_PATH_REQUIRED');
    if (storagePath !== undefined) {
      this.#store = new SnapshotStore(storagePath, { initialize: createStorage, initialState: emptySnapshot() });
      try {
        const state = validateSnapshot(this.#store.load());
        this.#rules = new Map(state.rules);
        this.#operations = new Map(state.operations);
        this.#positions = new Map(state.positions);
        this.#commands = new Map(state.commands);
        this.#events = new Map(state.events);
        this.#streams = new Map(state.streams);
        this.#nextOperation = state.nextOperation;
        this.#nextIncident = state.nextIncident;
        this.#sourceDecisions = state.sourceDecisions;
        const now = this.#now();
        for (const operation of this.#operations.values()) {
          if (operation.status !== 'submitted') continue;
          operation.status = 'unknown'; operation.reason = 'recovered_unresolved_handoff';
          operation.updatedAtMs = now;
          operation.result = { mode: 'demo', status: 'unknown', reason: operation.reason };
          const rule = this.#rules.get(operation.ruleId);
          if (!terminalRules.has(rule.state)) { rule.state = 'paused'; rule.reason = 'outcome_unresolved'; }
        }
        for (const rule of this.#rules.values()) {
          rule.config = frozenCopy(rule.config);
          this.#refresh(rule, now);
        }
        this.#checkpoint();
      } catch (cause) {
        this.#store.close();
        throw cause instanceof StorageError ? cause : new StorageError('STORAGE_INVALID', cause);
      }
    }
  }

  static initialize(options = {}) {
    requireValue(typeof options.storagePath === 'string' && options.storagePath.length > 0, 'STORAGE_PATH_REQUIRED');
    return new RuleEngine({ ...options, createStorage: true });
  }

  static open(options = {}) {
    requireValue(typeof options.storagePath === 'string' && options.storagePath.length > 0, 'STORAGE_PATH_REQUIRED');
    return new RuleEngine({ ...options, createStorage: false });
  }

  get mode() { return 'demo'; }
  get liveTradingAllowed() { return LIVE_TRADING_ALLOWED; }

  #healthy() {
    if (this.#storageFailure) throw this.#storageFailure;
    requireValue(!this.#closed, 'ENGINE_CLOSED');
    try { this.#store?.assertAvailable(); }
    catch (error) { this.#storageFailure = error; throw error; }
  }

  #snapshot() {
    return {
      version: 4, positions: [...this.#positions], nextOperation: this.#nextOperation, nextIncident: this.#nextIncident,
      rules: [...this.#rules], operations: [...this.#operations],
      commands: [...this.#commands], events: [...this.#events],
      streams: [...this.#streams],
      sourceDecisions: this.#sourceDecisions,
    };
  }

  #checkpoint(beforeCommit) {
    this.#healthy();
    try { this.#store?.save(this.#snapshot(), { beforeCommit }); }
    catch (error) { this.#storageFailure = error; throw error; }
  }

  close() {
    requireValue(this.#storageFailure || ![...this.#operations.values()].some(o => o.status === 'submitted'), 'OPERATIONS_IN_FLIGHT');
    this.#store?.close();
    this.#closed = true;
  }

  #now() {
    const now = this.#clock();
    requireValue(integer(now), 'INVALID_CLOCK');
    return now;
  }

  #rule(id) {
    this.#healthy();
    const rule = this.#rules.get(id);
    requireValue(rule, 'RULE_NOT_FOUND');
    return rule;
  }

  #operation(id) {
    this.#healthy();
    const operation = this.#operations.get(id);
    requireValue(operation, 'OPERATION_NOT_FOUND');
    return operation;
  }

  #once(requestId, command, apply) {
    this.#healthy();
    requireValue(identifier(requestId), 'INVALID_REQUEST_ID');
    const fingerprint = canonical(command);
    const prior = this.#commands.get(requestId);
    if (prior) {
      requireValue(prior.fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT');
      return prior.operationId
        ? this.#inFlight.get(prior.operationId) ?? Promise.resolve(frozenCopy(this.#operation(prior.operationId)))
        : frozenCopy(prior.result);
    }
    if (command.action === 'execute') {
      this.#operation(command.operationId);
      // Included in the same durable snapshot as the pre-handoff marker.
      this.#commands.set(requestId, { fingerprint, operationId: command.operationId });
      try { return apply(); }
      catch (error) { if (!this.#storageFailure) this.#commands.delete(requestId); throw error; }
    }
    const result = apply();
    this.#commands.set(requestId, { fingerprint, result });
    if (command.action === 'sourceDecision') this.#faultInjector('before_owner_decision_commit');
    this.#checkpoint(command.action === 'sourceDecision' ? () => this.#faultInjector('inside_owner_decision_transaction') : undefined);
    if (command.action === 'sourceDecision') this.#faultInjector('after_owner_decision_commit');
    this.#faultInjector('after_command_commit');
    return result;
  }

  #cancelPrepared(rule, reason, now) {
    if (!rule.pendingOperationId) return;
    const operation = this.#operation(rule.pendingOperationId);
    if (operation.status === 'prepared') {
      operation.status = 'cancelled';
      operation.reason = reason;
      operation.updatedAtMs = now;
      rule.pendingOperationId = null;
    }
  }

  #refresh(rule, now, persist = true) {
    if (!terminalRules.has(rule.state) && now >= rule.config.expiresAtMs) {
      rule.state = 'expired';
      rule.reason = 'deadline_reached';
      this.#cancelPrepared(rule, 'rule_expired', now);
      if (persist) this.#checkpoint();
    }
  }

  createRule(config, { requestId } = {}) {
    return this.#once(requestId, { action: 'create', config }, () => {
      const now = this.#now();
      requireValue(config && identifier(config.id) && asset(config.assetId), 'INVALID_ID_OR_ASSET');
      requireValue(config.assetId.startsWith('DEMO:') ? !config.market : marketBindingValid(config.market) &&
        config.assetId === `SOLANA:${config.market.mint}` && canonical(config.condition?.priceBasis) === canonical(MARKET_PRICE_BASIS), 'INVALID_MARKET_BINDING');
      requireValue(config.condition?.metric === 'priceUnits' &&
        config.condition.operator === 'lte' && integer(config.condition.thresholdUnits, 1), 'INVALID_CONDITION');
      if (config.condition.priceBasis !== undefined) requireValue(priceBasisValid(config.condition.priceBasis), 'INVALID_PRICE_BASIS');
      requireValue(integer(config.amountUnits, 1), 'INVALID_AMOUNT');
      const limits = config.limits;
      requireValue(limits && integer(limits.maxTotalSpendUnits, config.amountUnits) &&
        integer(limits.minReceiveUnits, 1) && integer(limits.maxFeeUnits) &&
        integer(limits.maxSlippageBps) && limits.maxSlippageBps <= 10_000 &&
        integer(limits.maxEventAgeMs, 1), 'INVALID_LIMITS');
      requireValue(integer(config.expiresAtMs) && config.expiresAtMs > now, 'INVALID_EXPIRY');
      if (config.position) {
        requireValue(marketBindingValid(config.market) && positionPolicyValid(config.position), 'INVALID_POSITION_POLICY');
        requireValue(![...this.#positions.values()].some(p => p.status !== 'closed'), 'POSITION_ALREADY_OPEN');
      }
      requireValue(!this.#rules.has(config.id), 'RULE_ALREADY_EXISTS');
      this.#rules.set(config.id, {
        config: frozenCopy(config), state: 'draft', reason: 'created', createdAtMs: now,
        pendingOperationId: null, submittedOperationId: null, operationIds: [],
      });
      return frozenCopy({ ruleId: config.id, action: 'created', mode: 'demo' });
    });
  }

  enable(ruleId, { requestId } = {}) {
    const rule = this.#rule(ruleId);
    this.#refresh(rule, this.#now());
    return this.#once(requestId, { action: 'enable', ruleId }, () => {
      requireValue(!rule.submittedOperationId, 'ATTEMPT_ALREADY_SUBMITTED');
      requireValue(this.#streams.get(ruleId)?.continuity !== 'decision_required', 'SOURCE_DECISION_REQUIRED');
      requireValue(['draft', 'paused', 'active'].includes(rule.state), 'INVALID_TRANSITION');
      rule.state = 'active'; rule.reason = 'enabled';
      return frozenCopy({ ruleId, action: 'enabled' });
    });
  }

  pause(ruleId, { requestId } = {}) {
    const rule = this.#rule(ruleId), now = this.#now();
    this.#refresh(rule, now);
    return this.#once(requestId, { action: 'pause', ruleId }, () => {
      requireValue(['active', 'paused'].includes(rule.state), 'INVALID_TRANSITION');
      rule.state = 'paused'; rule.reason = 'user_paused';
      this.#cancelPrepared(rule, 'rule_paused', now);
      return frozenCopy({ ruleId, action: 'paused' });
    });
  }

  revoke(ruleId, { requestId } = {}) {
    const rule = this.#rule(ruleId), now = this.#now();
    requireValue(this.#streams.get(ruleId)?.continuity !== 'decision_required', 'INCIDENT_DECISION_REQUIRED');
    return this.#once(requestId, { action: 'revoke', ruleId }, () => {
      rule.state = 'revoked'; rule.reason = 'user_revoked';
      this.#cancelPrepared(rule, 'rule_revoked', now);
      return frozenCopy({ ruleId, action: 'revoked' });
    });
  }

  receiveEvent(ruleId, event) {
    const rule = this.#rule(ruleId), now = this.#now();
    requireValue(!rule.config.market, 'MARKET_SNAPSHOT_REQUIRED');
    requireValue(!this.#streams.has(ruleId), 'SOURCE_CONTRACT_REQUIRED');
    this.#refresh(rule, now);
    requireValue(event && identifier(event.id) && event.type === 'synthetic-price' &&
      asset(event.assetId) && integer(event.observedAtMs) && integer(event.priceUnits, 1), 'INVALID_EVENT');
    const key = JSON.stringify([ruleId, event.id]), fingerprint = canonical(event);
    const prior = this.#events.get(key);
    if (prior) {
      requireValue(prior.fingerprint === fingerprint, 'EVENT_ID_CONFLICT');
      return frozenCopy({ ...prior.result, duplicate: true });
    }
    const result = frozenCopy(this.#evaluateEvent(rule, event, now));
    this.#events.set(key, { fingerprint, result });
    this.#checkpoint();
    if (result.disposition === 'prepared') this.#faultInjector('after_prepared_commit');
    return result;
  }

  receiveMarketSnapshot(ruleId, event) {
    const rule = this.#rule(ruleId), now = this.#now(), binding = rule.config.market;
    requireValue(marketBindingValid(binding) && !this.#streams.has(ruleId), 'MARKET_SNAPSHOT_REQUIRED');
    requireValue(marketSnapshotValid(event), 'INVALID_MARKET_SNAPSHOT');
    requireValue(['provider', 'chainId', 'dexId', 'mint', 'pairAddress', 'quoteMint', 'priceField'].every(k => event[k] === binding[k]) &&
      samePriceBasis(event.priceBasis, rule.config.condition.priceBasis), 'MARKET_BINDING_MISMATCH');
    this.#refresh(rule, now);
    const key = JSON.stringify([ruleId, event.id]), fingerprint = canonical(event), prior = this.#events.get(key);
    if (prior) {
      requireValue(prior.fingerprint === fingerprint, 'EVENT_ID_CONFLICT');
      return frozenCopy({ ...prior.result, duplicate: true });
    }
    const previous = [...this.#events.values()].filter(e => e.ruleId === ruleId && e.marketSnapshot &&
      !['ignored_future', 'ignored_stale', 'ignored_out_of_order'].includes(e.result.disposition)).at(-1)?.marketSnapshot;
    const result = frozenCopy(event.receivedAtMs > now ? { disposition: 'ignored_future' }
      : previous && event.observedAtMs < previous.observedAtMs ? { disposition: 'ignored_out_of_order' }
      : this.#evaluateEvent(rule, event, now));
    this.#events.set(key, { fingerprint, ruleId, marketSnapshot: frozenCopy(event), result });
    this.#checkpoint(); // Observation and execution intent are committed together.
    if (result.disposition === 'prepared') this.#faultInjector('after_prepared_commit');
    return result;
  }

  #evaluateEvent(rule, event, now) {
    if (rule.config.position && [...this.#positions.values()].some(p => p.status !== 'closed')) return { disposition: 'ignored_reserved' };
    if (rule.state !== 'active') return { disposition: 'ignored_inactive' };
    if (rule.submittedOperationId || rule.pendingOperationId) return { disposition: 'ignored_reserved' };
    if (event.assetId !== rule.config.assetId) return { disposition: 'ignored_asset' };
    if (event.observedAtMs > now) return { disposition: 'ignored_future' };
    if (now - event.observedAtMs > rule.config.limits.maxEventAgeMs) return { disposition: 'ignored_stale' };
    if (event.priceUnits > rule.config.condition.thresholdUnits) return { disposition: 'condition_not_met' };
    const operationId = `demo-operation-${this.#nextOperation++}`;
    this.#operations.set(operationId, {
      id: operationId, ruleId: rule.config.id, status: 'prepared', mode: 'demo',
      event: frozenCopy(event), createdAtMs: now, updatedAtMs: now, reason: 'condition_met',
    });
    rule.pendingOperationId = operationId;
    rule.operationIds.push(operationId);
    return { disposition: 'prepared', operationId };
  }

  bindSource(ruleId, { sourceId } = {}, { requestId } = {}) {
    const rule = this.#rule(ruleId);
    requireValue(!rule.config.market, 'SNAPSHOT_HAS_NO_RECOVERY_CURSOR');
    this.#refresh(rule, this.#now());
    return this.#once(requestId, { action: 'bindSource', ruleId, sourceId }, () => {
      requireValue(sourceIdValid(sourceId), 'INVALID_SOURCE');
      requireValue(rule.state === 'draft' && rule.operationIds.length === 0 && !this.#streams.has(ruleId), 'INVALID_TRANSITION');
      requireValue(priceBasisValid(rule.config.condition.priceBasis), 'PRICE_BASIS_REQUIRED');
      this.#streams.set(ruleId, { sourceId, cursor: 0, continuity: 'continuous', lastOccurredAtMs: null, issue: null, freshAfterMs: null });
      return frozenCopy({ ruleId, action: 'source_bound' });
    });
  }

  #stream(ruleId) {
    this.#rule(ruleId);
    const stream = this.#streams.get(ruleId);
    requireValue(stream, 'SOURCE_NOT_BOUND');
    return stream;
  }

  getSourceState(ruleId) {
    return frozenCopy({ ...this.#stream(ruleId), connected: this.#connectedStreams.has(ruleId) });
  }

  sourceDisconnected(ruleId) { this.#stream(ruleId); this.#connectedStreams.delete(ruleId); }

  sourceConnected(ruleId, { sourceId, afterPosition }) {
    const stream = this.#stream(ruleId);
    requireValue(sourceId === stream.sourceId && afterPosition === stream.cursor, 'RESUME_MISMATCH');
    this.#connectedStreams.add(ruleId); // Transport only; never clears continuity or enables the rule.
  }

  reportSourceIssue(ruleId, reason, details = {}) {
    const stream = this.#stream(ruleId), rule = this.#rule(ruleId), now = this.#now();
    if (stream.continuity === 'stopped') return frozenCopy({ disposition: 'stopped', cursor: stream.cursor, issue: stream.issue });
    if (stream.continuity !== 'decision_required') {
      stream.continuity = 'decision_required';
      stream.issue = frozenCopy({ id: `source-incident-${this.#nextIncident++}`, ruleId, reason, details, detectedAtMs: now });
      if (rule.state === 'active') { rule.state = 'paused'; rule.reason = 'source_decision_required'; }
      this.#cancelPrepared(rule, 'source_decision_required', now);
      this.#checkpoint();
    }
    return frozenCopy({ disposition: 'decision_required', cursor: stream.cursor, issue: stream.issue });
  }

  getSourceDecisionLog(ruleId) {
    this.#rule(ruleId);
    return frozenCopy(this.#sourceDecisions.filter(entry => entry.ruleId === ruleId));
  }

  #verifiedRecovery(stream, ruleId, source) {
    requireValue(source instanceof SyntheticSource, 'SYNTHETIC_RECOVERY_SOURCE_REQUIRED');
    const snapshot = source.readRecoveryHistory();
    if (snapshot.status === 'history_unavailable') return { outcome: 'history_unavailable', details: snapshot };
    if (snapshot.status !== 'available' || snapshot.sourceId !== stream.sourceId ||
        !integer(snapshot.head) || snapshot.head < stream.cursor || !Array.isArray(snapshot.records) ||
        snapshot.records.length !== snapshot.head ||
        !snapshot.records.every((e, index) => sourceEventValid(e) && e.sourceId === stream.sourceId && e.position === index + 1) ||
        new Set(snapshot.records.map(e => e.eventId)).size !== snapshot.head) {
      return { outcome: 'verification_failed', details: { reason: 'invalid_recovery_snapshot' } };
    }
    const recorded = new Map([...this.#events.values()].filter(e => e.ruleId === ruleId && e.sourceRecord)
      .map(e => [e.sourceRecord.position, e.fingerprint]));
    if (snapshot.records.slice(0, stream.cursor).some(e => recorded.get(e.position) !== canonical(e))) {
      return { outcome: 'verification_failed', details: { reason: 'recorded_history_conflict' } };
    }
    return { outcome: 'history_verified', snapshot };
  }

  decideSourceIssue(ruleId, { incidentId, decision, acknowledgeHistoryLoss = false } = {},
    { requestId, ownerContext, source } = {}) {
    const rule = this.#rule(ruleId), stream = this.#stream(ruleId);
    const principalId = authorizedDemoPrincipal(ownerContext, ruleId);
    requireValue(principalId, 'DEMO_OWNER_AUTH_REQUIRED');
    this.#refresh(rule, this.#now());
    return this.#once(requestId, { action: 'sourceDecision', ruleId, incidentId, decision, acknowledgeHistoryLoss, principalId }, () => {
      requireValue(stream.continuity === 'decision_required' && stream.issue?.id === incidentId && stream.issue.ruleId === ruleId, 'STALE_SOURCE_INCIDENT');
      requireValue(['revoke', 'retry_history', 'accept_gap'].includes(decision), 'INVALID_SOURCE_DECISION');
      if (decision === 'accept_gap') requireValue(acknowledgeHistoryLoss === true, 'HISTORY_LOSS_ACK_REQUIRED');
      const issue = frozenCopy(stream.issue);
      const before = { ruleState: rule.state, continuity: stream.continuity, cursor: stream.cursor };
      let decidedAtMs = this.#now();
      let outcome, details = {};
      if (decision === 'revoke') {
        const now = decidedAtMs;
        rule.state = 'revoked'; rule.reason = 'owner_incident_revocation';
        this.#cancelPrepared(rule, 'owner_incident_revocation', now);
        stream.continuity = 'stopped';
        stream.issue = frozenCopy({ ...issue, resolution: 'revoked' });
        this.#connectedStreams.delete(ruleId);
        outcome = 'rule_revoked';
      } else if (decision === 'accept_gap') {
        outcome = 'gap_acceptance_unsupported';
        details = { missingContract: 'verified_new_start_anchor_with_generation_coverage_and_freshness_boundary' };
      } else if (['revoked', 'finished', 'expired'].includes(rule.state)) {
        outcome = 'terminal_rule';
      } else {
        const recovery = this.#verifiedRecovery(stream, ruleId, source);
        requireValue(stream.continuity === 'decision_required' && stream.issue?.id === incidentId, 'STALE_SOURCE_INCIDENT');
        outcome = recovery.outcome; details = recovery.details ?? {};
        if (outcome === 'history_verified') {
          const now = this.#now();
          decidedAtMs = now;
          this.#refresh(rule, now, false);
          const { head, records } = recovery.snapshot;
          for (const record of records.slice(stream.cursor)) {
            const key = JSON.stringify([ruleId, record.sourceId, record.eventId]);
            this.#events.set(key, { fingerprint: canonical(record), ruleId, sourceRecord: frozenCopy(record),
              result: frozenCopy({ disposition: 'ignored_history_recovery', receivedAtMs: now }) });
            if (record.assetId === rule.config.assetId && samePriceBasis(record.payload, rule.config.condition.priceBasis) && record.occurredAtMs <= now) {
              stream.lastOccurredAtMs = Math.max(stream.lastOccurredAtMs ?? 0, record.occurredAtMs);
            }
          }
          stream.cursor = head;
          stream.continuity = 'continuous'; stream.issue = null;
          stream.freshAfterMs = now;
          this.#connectedStreams.delete(ruleId);
          // Restoring data never re-enables a rule or resolves a trading outcome.
          if (!terminalRules.has(rule.state)) {
            rule.state = 'paused';
            rule.reason = rule.submittedOperationId ? 'attempt_remains_blocked' : 'history_verified_requires_enable';
          }
          details = { verifiedFrom: 1, verifiedThrough: head, freshAfterMs: now, requiresEnable: true };
        }
      }
      const result = frozenCopy({ ruleId, action: 'source_decision_recorded', incidentId, decision, outcome,
        ruleState: rule.state, continuity: stream.continuity, cursor: stream.cursor, details });
      this.#sourceDecisions.push(frozenCopy({ requestId, ruleId, incidentId, decision, principalId,
        decidedAtMs, issue, before,
        after: { ruleState: rule.state, continuity: stream.continuity, cursor: stream.cursor }, outcome, details }));
      return result;
    });
  }

  receiveSourceEvent(ruleId, record) {
    const stream = this.#stream(ruleId), rule = this.#rule(ruleId), now = this.#now();
    requireValue(this.#connectedStreams.has(ruleId), 'SOURCE_NOT_CONNECTED');
    this.#refresh(rule, now);
    if (stream.continuity !== 'continuous') return frozenCopy({ disposition: stream.continuity === 'stopped' ? 'stopped' : 'decision_required', cursor: stream.cursor, issue: stream.issue });
    this.#faultInjector('after_source_receive');
    if (!sourceEventValid(record) || record.sourceId !== stream.sourceId) return this.reportSourceIssue(ruleId, 'invalid_source_event');
    const key = JSON.stringify([ruleId, record.sourceId, record.eventId]);
    const fingerprint = canonical(record), prior = this.#events.get(key);
    if (prior && prior.fingerprint !== fingerprint) return this.reportSourceIssue(ruleId, 'event_identity_conflict', { position: record.position });
    if (record.position <= stream.cursor) {
      if (!prior) return this.reportSourceIssue(ruleId, 'unverifiable_replay', { position: record.position });
      return frozenCopy({ ...prior.result, duplicate: true, cursor: stream.cursor, receivedAtMs: now });
    }
    if (record.position !== stream.cursor + 1 || prior) return this.reportSourceIssue(ruleId, 'position_gap', { expected: stream.cursor + 1, received: record.position });
    const normalized = {
      id: record.eventId, type: record.type, assetId: record.assetId,
      observedAtMs: record.occurredAtMs, priceUnits: record.payload.priceUnits,
      sourceEvent: { ...record, receivedAtMs: now },
    };
    let result;
    if (stream.freshAfterMs !== null && record.occurredAtMs <= stream.freshAfterMs) result = { disposition: 'ignored_before_resolution' };
    else if (!samePriceBasis(record.payload, rule.config.condition.priceBasis)) result = { disposition: 'ignored_incompatible_price' };
    else if (record.assetId === rule.config.assetId && stream.lastOccurredAtMs !== null && record.occurredAtMs < stream.lastOccurredAtMs) result = { disposition: 'ignored_out_of_order' };
    else result = this.#evaluateEvent(rule, normalized, now);
    if (record.assetId === rule.config.assetId && samePriceBasis(record.payload, rule.config.condition.priceBasis) && record.occurredAtMs <= now) {
      stream.lastOccurredAtMs = Math.max(stream.lastOccurredAtMs ?? 0, record.occurredAtMs);
    }
    result = frozenCopy({ ...result, receivedAtMs: now });
    this.#events.set(key, { fingerprint, result, ruleId, sourceRecord: frozenCopy(record) });
    stream.cursor = record.position;
    // Cursor, deduplication, rule decision and optional intent are ONE snapshot.
    this.#faultInjector('before_source_commit');
    this.#checkpoint();
    this.#faultInjector('after_source_commit');
    return frozenCopy({ ...result, cursor: stream.cursor });
  }

  executePrepared(operationId, { requestId } = {}) {
    return this.#once(requestId, { action: 'execute', operationId }, () => this.#dispatch(operationId));
  }

  async handleEvent(ruleId, event) {
    const received = this.receiveEvent(ruleId, event);
    const operation = received.disposition === 'prepared'
      ? await this.#dispatch(received.operationId) : null;
    return frozenCopy({ event: received, operation });
  }

  #dispatch(operationId) {
    const operation = this.#operation(operationId), rule = this.#rule(operation.ruleId);
    const now = this.#now();
    this.#refresh(rule, now);
    if (this.#inFlight.has(operationId)) { this.#checkpoint(); return this.#inFlight.get(operationId); }
    if (operation.status !== 'prepared') { this.#checkpoint(); return Promise.resolve(frozenCopy(operation)); }
    if (this.#streams.has(operation.ruleId)) {
      requireValue(this.#streams.get(operation.ruleId).continuity === 'continuous', 'SOURCE_DECISION_REQUIRED');
      requireValue(this.#connectedStreams.has(operation.ruleId), 'SOURCE_NOT_CONNECTED');
    }
    if (rule.config.position && [...this.#positions.values()].some(p => p.status !== 'closed')) this.#cancelPrepared(rule, 'position_already_open', now);
    else if (rule.state !== 'active') this.#cancelPrepared(rule, 'rule_not_active', now);
    else if (now - operation.event.observedAtMs > rule.config.limits.maxEventAgeMs) {
      this.#cancelPrepared(rule, 'event_became_stale', now);
    }
    if (operation.status !== 'prepared') { this.#checkpoint(); return Promise.resolve(frozenCopy(operation)); }
    requireValue(!rule.submittedOperationId, 'ATTEMPT_ALREADY_SUBMITTED');
    // Reserve the one-shot attempt synchronously, before invoking the simulator.
    operation.status = 'submitted'; operation.reason = 'handoff_may_occur';
    operation.submittedAtMs = now; operation.updatedAtMs = now;
    rule.submittedOperationId = operationId; rule.pendingOperationId = null;
    const intent = frozenCopy({
      mode: 'demo', liveTradingAllowed: false, operationId, ruleId: operation.ruleId,
      side: 'buy', assetId: rule.config.assetId, amountUnits: rule.config.amountUnits,
      limits: rule.config.limits, sourceEventId: operation.event.id,
    });
    // COMMIT first. A crash from this point is uncertainty, even if submit never ran.
    this.#checkpoint();
    this.#faultInjector('after_dispatch_commit');
    // Disk I/O may have crossed the deadline or freshness boundary. No handoff yet.
    const handoffNow = this.#now();
    this.#refresh(rule, handoffNow);
    if (rule.state !== 'active' || handoffNow - operation.event.observedAtMs > rule.config.limits.maxEventAgeMs) {
      operation.status = 'cancelled';
      operation.reason = rule.state === 'expired' ? 'rule_expired'
        : rule.state !== 'active' ? 'rule_not_active' : 'event_became_stale';
      operation.updatedAtMs = handoffNow;
      // Only this live process knows it has not invoked submit. Persist that fact.
      // A crash before this COMMIT still restores unknown from the earlier marker.
      rule.submittedOperationId = null;
      this.#checkpoint();
      return Promise.resolve(frozenCopy(operation));
    }
    let resolve, reject;
    const completion = new Promise((done, fail) => { resolve = done; reject = fail; });
    this.#inFlight.set(operationId, completion);
    // No further disk I/O or asynchronous gap after the final eligibility check.
    let response;
    try { response = this.#executor.submit(intent); }
    catch { response = Promise.reject(new Error('Simulator handoff uncertainty')); }
    this.#faultInjector('after_handoff');
    Promise.resolve(response).then(
      result => this.#finish(operation, rule, result),
      () => this.#finish(operation, rule, { mode: 'demo', status: 'unknown', reason: 'simulator_error' }),
    ).then(() => resolve(frozenCopy(operation)), reject);
    return completion;
  }

  #finish(operation, rule, result) {
    let now;
    try { now = this.#now(); this.#refresh(rule, now); }
    catch { now = operation.updatedAtMs; result = { mode: 'demo', status: 'unknown', reason: 'clock_error' }; }
    if (result?.mode !== 'demo' || !['succeeded', 'failed', 'unknown'].includes(result.status)) {
      result = { mode: 'demo', status: 'unknown', reason: 'invalid_simulator_result' };
    }
    if (rule.config.position && result.status === 'succeeded' && result.kind !== 'virtual-condition') {
      result = { mode: 'demo', status: 'unknown', reason: 'invalid_position_simulator_result' };
    }
    if (rule.config.position && result.status === 'succeeded') {
      requireValue(![...this.#positions.values()].some(p => p.status !== 'closed'), 'POSITION_ALREADY_OPEN');
      const id = `position-${operation.id}`;
      this.#positions.set(id, { id, ruleId: rule.config.id, operationId: operation.id, status: 'open',
        binding: rule.config.market, policy: rule.config.position, amountUnits: rule.config.amountUnits,
        entry: operation.event, openedAtMs: now, last: operation.event, observations: [], closeRequest: null, exit: null });
    }
    operation.status = result.status; operation.updatedAtMs = now;
    operation.result = frozenCopy(result); operation.reason = result.reason ?? result.status;
    if (!terminalRules.has(rule.state)) {
      rule.state = result.status === 'unknown' ? 'paused' : 'finished';
      rule.reason = result.status === 'unknown' ? 'outcome_unresolved' : `operation_${result.status}`;
    }
    this.#faultInjector('before_result_commit');
    this.#checkpoint();
    this.#faultInjector('after_result_commit');
  }

  listPositions() { this.#healthy(); return frozenCopy([...this.#positions.values()]); }

  requestPositionClose(positionId, { requestId } = {}) {
    return this.#once(requestId, { action: 'closePosition', positionId }, () => {
      const p = this.#positions.get(positionId);
      requireValue(p, 'POSITION_NOT_FOUND');
      requireValue(p.status !== 'closed', 'POSITION_ALREADY_CLOSED');
      // Repeated requests, even with another key, do not move the freshness boundary.
      if (!p.closeRequest) p.closeRequest = { requestId, requestedAtMs: this.#now(), afterSnapshotId: p.last.id };
      p.status = 'close_requested';
      return frozenCopy({ positionId, ruleId: p.ruleId, action: 'close_requested' });
    });
  }

  receivePositionSnapshot(positionId, event) {
    this.#healthy();
    const p = this.#positions.get(positionId), now = this.#now();
    requireValue(p, 'POSITION_NOT_FOUND');
    requireValue(marketSnapshotValid(event), 'INVALID_MARKET_SNAPSHOT');
    requireValue(sameBinding(p.binding, event), 'MARKET_BINDING_MISMATCH');
    const prior = p.observations.find(o => o.snapshot.id === event.id);
    if (prior) {
      requireValue(canonical(prior.snapshot) === canonical(event), 'EVENT_ID_CONFLICT');
      return frozenCopy({ disposition: prior.disposition, duplicate: true });
    }
    if (event.id === p.entry.id) {
      requireValue(canonical(event) === canonical(p.entry), 'EVENT_ID_CONFLICT');
      return { disposition: 'ignored_entry_snapshot', duplicate: true };
    }
    let disposition = p.status === 'closed' ? 'ignored_closed'
      : event.receivedAtMs > now ? 'ignored_future'
      : now - event.observedAtMs > this.#rule(p.ruleId).config.limits.maxEventAgeMs ? 'ignored_stale'
      : event.observedAtMs < this.#startedAt || event.observedAtMs <= p.last.observedAtMs ? 'ignored_out_of_order' : 'valued';
    if (disposition === 'valued') {
      p.last = frozenCopy(event);
      const reason = p.closeRequest && event.observedAtMs > p.closeRequest.requestedAtMs ? 'user_request'
        : exitReason(p.entry.priceUnits, event.priceUnits, p.policy);
      if (reason) {
        p.status = 'closed'; disposition = 'closed';
        p.exit = { reason, snapshot: frozenCopy(event), closedAtMs: now,
          values: positionValues(p.amountUnits, p.entry.priceUnits, event.priceUnits, p.policy) };
      }
    }
    p.observations.push({ snapshot: frozenCopy(event), disposition });
    this.#faultInjector('before_position_commit');
    this.#checkpoint(() => this.#faultInjector('inside_position_transaction'));
    this.#faultInjector('after_position_commit');
    return frozenCopy({ disposition });
  }

  tick() {
    this.#healthy();
    const now = this.#now();
    for (const rule of this.#rules.values()) this.#refresh(rule, now);
  }

  getRule(ruleId) {
    const rule = this.#rule(ruleId);
    this.#refresh(rule, this.#now());
    return frozenCopy(rule);
  }

  listRules() {
    this.#healthy();
    return frozenCopy([...this.#rules.keys()].map(ruleId => this.getRule(ruleId)));
  }

  getEventLog(ruleId) {
    this.#rule(ruleId);
    return frozenCopy([...this.#events].filter(([key]) => JSON.parse(key)[0] === ruleId)
      .map(([key, entry]) => ({ key, ...entry })));
  }

  getOperation(operationId) {
    const operation = this.#operation(operationId);
    this.#refresh(this.#rule(operation.ruleId), this.#now());
    return frozenCopy(operation);
  }
}
