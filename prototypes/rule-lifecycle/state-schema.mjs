import assert from 'node:assert/strict';
import { canonical, priceBasisValid, sourceIdValid, sourceEventValid } from './event-contract.mjs';

export const emptySnapshot = () => ({ version: 3, nextOperation: 1, nextIncident: 1, sourceDecisions: [], rules: [], operations: [], commands: [], events: [], streams: [] });
const integer = (v, min = 0) => Number.isSafeInteger(v) && v >= min;
const id = v => typeof v === 'string' && v.length > 0 && v.length <= 128 && v.trim() === v;
const asset = v => id(v) && v.startsWith('DEMO:') && v.length > 5;
const ruleStates = new Set(['draft', 'active', 'paused', 'finished', 'expired', 'revoked']);
const operationStates = new Set(['prepared', 'submitted', 'succeeded', 'failed', 'unknown', 'cancelled']);
const dispositions = new Set(['prepared', 'ignored_inactive', 'ignored_reserved', 'ignored_asset', 'ignored_future', 'ignored_stale', 'condition_not_met', 'ignored_incompatible_price', 'ignored_out_of_order', 'ignored_history_recovery', 'ignored_before_resolution']);

function pairs(value) {
  assert(Array.isArray(value));
  assert(value.every(pair => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && pair[1] && typeof pair[1] === 'object'));
  const map = new Map(value);
  assert.equal(map.size, value.length);
  return map;
}
function event(e) {
  assert(e && id(e.id) && e.type === 'synthetic-price' && asset(e.assetId) && integer(e.observedAtMs) && integer(e.priceUnits, 1));
  if (e.sourceEvent) {
    const { receivedAtMs, ...record } = e.sourceEvent;
    assert(integer(receivedAtMs) && sourceEventValid(record));
    assert(e.id === record.eventId && e.assetId === record.assetId && e.observedAtMs === record.occurredAtMs && e.priceUnits === record.payload.priceUnits);
  }
}

/** Versioned format and cross-references; not authentication against a malicious file owner. */
export function validateSnapshot(state) {
  assert([1, 2, 3].includes(state?.version));
  if (state.version === 1) {
    assert(!Object.hasOwn(state, 'streams'));
    state = { ...state, version: 2, streams: [] }; // Lossless v1 upgrade; no source is inferred.
  }
  if (state.version === 2) {
    assert(!Object.hasOwn(state, 'nextIncident') && !Object.hasOwn(state, 'sourceDecisions'));
    let nextIncident = 1;
    state = { ...state, version: 3, sourceDecisions: [], streams: state.streams.map(([ruleId, s]) => [ruleId, {
      ...s, freshAfterMs: null, issue: s.issue ? { ...s.issue, id: `source-incident-${nextIncident++}`, ruleId } : null,
    }]) };
    state.nextIncident = nextIncident;
  }
  assert(integer(state.nextOperation, 1));
  assert(integer(state.nextIncident, 1) && Array.isArray(state.sourceDecisions));
  const rules = pairs(state.rules), operations = pairs(state.operations);
  const commands = pairs(state.commands), events = pairs(state.events);
  const streams = pairs(state.streams);
  for (const [key, r] of rules) {
    const c = r.config, l = c?.limits;
    assert(id(key) && c?.id === key && asset(c.assetId) && ruleStates.has(r.state));
    assert(c.condition?.metric === 'priceUnits' && c.condition.operator === 'lte' && integer(c.condition.thresholdUnits, 1));
    if (c.condition.priceBasis !== undefined) assert(priceBasisValid(c.condition.priceBasis));
    assert(integer(c.amountUnits, 1) && integer(c.expiresAtMs) && integer(r.createdAtMs) && typeof r.reason === 'string');
    assert(l && integer(l.maxTotalSpendUnits, c.amountUnits) && integer(l.minReceiveUnits, 1) && integer(l.maxFeeUnits));
    assert(integer(l.maxSlippageBps) && l.maxSlippageBps <= 10_000 && integer(l.maxEventAgeMs, 1));
    assert(Array.isArray(r.operationIds) && new Set(r.operationIds).size === r.operationIds.length);
    const linked = [...operations.values()].filter(o => o.ruleId === key);
    assert.equal(linked.length, r.operationIds.length);
    for (const operationId of r.operationIds) assert.equal(operations.get(operationId)?.ruleId, key);
    assert(r.pendingOperationId === null || operations.get(r.pendingOperationId)?.status === 'prepared');
    assert.deepEqual(linked.filter(o => o.status === 'prepared').map(o => o.id), r.pendingOperationId ? [r.pendingOperationId] : []);
    const submitted = linked.filter(o => !['prepared', 'cancelled'].includes(o.status));
    assert.equal(submitted.length, r.submittedOperationId ? 1 : 0);
    if (r.submittedOperationId) {
      assert.equal(submitted[0].id, r.submittedOperationId);
      assert.equal(r.pendingOperationId, null);
    } else assert.equal(r.submittedOperationId, null);
    if (r.state === 'finished') assert(['succeeded', 'failed'].includes(submitted[0]?.status));
    if (r.pendingOperationId) assert.equal(r.state, 'active');
    if (submitted[0]?.status === 'unknown') assert(['paused', 'expired', 'revoked'].includes(r.state));
  }
  for (const [key, o] of operations) {
    assert.equal(o.id, key);
    assert(/^demo-operation-[1-9][0-9]*$/.test(key));
    assert(integer(Number(key.slice('demo-operation-'.length)), 1) && Number(key.slice('demo-operation-'.length)) < state.nextOperation);
    assert(rules.has(o.ruleId) && operationStates.has(o.status) && o.mode === 'demo');
    assert(integer(o.createdAtMs) && integer(o.updatedAtMs) && typeof o.reason === 'string');
    event(o.event);
    if (!['prepared', 'cancelled'].includes(o.status)) assert(integer(o.submittedAtMs));
    if (['succeeded', 'failed', 'unknown'].includes(o.status)) {
      assert(o.result?.mode === 'demo' && o.result.status === o.status);
    }
    if (o.status === 'succeeded') {
      const receipt = o.result.receipt;
      assert(receipt && ['spentUnits', 'receivedUnits', 'feeUnits', 'slippageBps'].every(key => integer(receipt[key])));
    }
  }
  for (const [key, c] of commands) {
    assert(id(key) && typeof c.fingerprint === 'string');
    const request = JSON.parse(c.fingerprint);
    assert(['create', 'enable', 'pause', 'revoke', 'execute', 'bindSource', 'sourceDecision'].includes(request.action));
    if (request.action === 'execute') {
      assert.equal(c.operationId, request.operationId);
      assert(operations.has(c.operationId));
      assert(!Object.hasOwn(c, 'result'));
    } else {
      const ruleId = request.action === 'create' ? request.config?.id : request.ruleId;
      assert(rules.has(ruleId) && c.result?.ruleId === ruleId && typeof c.result.action === 'string');
    }
  }
  for (const [key, e] of events) {
    const parts = JSON.parse(key);
    assert(Array.isArray(parts) && [2, 3].includes(parts.length));
    const ruleId = parts[0], eventId = parts.at(-1);
    assert(rules.has(ruleId));
    const source = JSON.parse(e.fingerprint);
    if (parts.length === 2) { event(source); assert.equal(source.id, eventId); }
    else {
      assert(sourceEventValid(source));
      assert(source.sourceId === parts[1] && source.eventId === eventId && e.ruleId === ruleId);
      assert.equal(canonical(e.sourceRecord), canonical(source));
      assert(streams.get(ruleId)?.sourceId === source.sourceId);
      assert(source.position <= streams.get(ruleId).cursor && integer(e.result?.receivedAtMs));
    }
    assert(dispositions.has(e.result?.disposition));
    if (e.result.disposition === 'prepared') {
      const operation = operations.get(e.result.operationId);
      assert(operation?.ruleId === ruleId && operation.event.id === eventId);
    }
  }
  for (const [ruleId, s] of streams) {
    const rule = rules.get(ruleId);
    assert(rule && priceBasisValid(rule.config.condition.priceBasis) && sourceIdValid(s.sourceId));
    assert(integer(s.cursor) && ['continuous', 'decision_required', 'stopped'].includes(s.continuity));
    assert(s.freshAfterMs === null || integer(s.freshAfterMs));
    assert(s.lastOccurredAtMs === null || integer(s.lastOccurredAtMs));
    if (s.continuity === 'continuous') assert.equal(s.issue, null);
    else {
      assert(typeof s.issue?.reason === 'string' && integer(s.issue.detectedAtMs));
      assert.equal(s.issue.ruleId, ruleId);
      assert(/^source-incident-[1-9][0-9]*$/.test(s.issue.id));
      assert(Number(s.issue.id.slice('source-incident-'.length)) < state.nextIncident);
      assert.notEqual(rule.state, 'active');
      assert.equal(rule.pendingOperationId, null);
      if (s.continuity === 'stopped') assert(rule.state === 'revoked' && s.issue.resolution === 'revoked');
    }
    const positions = [...events.values()].filter(e => e.ruleId === ruleId && e.sourceRecord).map(e => e.sourceRecord.position).sort((a, b) => a - b);
    assert.equal(positions.length, s.cursor);
    assert(positions.every((position, i) => position === i + 1));
  }
  const decisionRequests = new Set();
  const incidents = new Map();
  for (const [ruleId, s] of streams) if (s.issue) incidents.set(s.issue.id, ruleId);
  for (const entry of state.sourceDecisions) {
    assert(id(entry.requestId) && !decisionRequests.has(entry.requestId));
    decisionRequests.add(entry.requestId);
    assert(rules.has(entry.ruleId) && streams.has(entry.ruleId));
    assert(entry.issue?.id === entry.incidentId && entry.issue.ruleId === entry.ruleId);
    assert(/^source-incident-[1-9][0-9]*$/.test(entry.incidentId));
    assert(Number(entry.incidentId.slice('source-incident-'.length)) < state.nextIncident);
    assert(!incidents.has(entry.incidentId) || incidents.get(entry.incidentId) === entry.ruleId);
    incidents.set(entry.incidentId, entry.ruleId);
    assert(['revoke', 'retry_history', 'accept_gap'].includes(entry.decision));
    assert(['rule_revoked', 'gap_acceptance_unsupported', 'terminal_rule', 'history_unavailable', 'verification_failed', 'history_verified'].includes(entry.outcome));
    assert(typeof entry.principalId === 'string' && entry.principalId.startsWith('DEMO:') && integer(entry.decidedAtMs));
    for (const view of [entry.before, entry.after]) assert(ruleStates.has(view?.ruleState) && integer(view.cursor) && ['continuous', 'decision_required', 'stopped'].includes(view.continuity));
    const command = commands.get(entry.requestId);
    const request = JSON.parse(command?.fingerprint);
    assert(request.action === 'sourceDecision' && request.ruleId === entry.ruleId && request.incidentId === entry.incidentId && request.decision === entry.decision && request.principalId === entry.principalId);
    assert(command.result.outcome === entry.outcome && command.result.incidentId === entry.incidentId);
  }
  for (const [key, command] of commands) if (JSON.parse(command.fingerprint).action === 'sourceDecision') assert(decisionRequests.has(key));
  return state;
}
