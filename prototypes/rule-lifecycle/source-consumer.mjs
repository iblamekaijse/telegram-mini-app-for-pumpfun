/** Sequential local adapter. Reconnect is bounded and never clears an execution latch. */
export class SourceConsumer {
  #engine;
  #ruleId;
  #source;
  constructor({ engine, ruleId, source }) {
    if (engine.getSourceState(ruleId).sourceId !== source.sourceId) throw new TypeError('Wrong source');
    this.#engine = engine; this.#ruleId = ruleId; this.#source = source;
    this.#engine.sourceDisconnected(ruleId);
  }
  disconnect() { this.#source.disconnect(); this.#engine.sourceDisconnected(this.#ruleId); }
  decideIssue(decision, { requestId, ownerContext } = {}) {
    return this.#engine.decideSourceIssue(this.#ruleId, decision, { requestId, ownerContext, source: this.#source });
  }
  #blockedStatus() {
    return this.#engine.getSourceState(this.#ruleId).continuity === 'stopped' ? 'stopped' : 'decision_required';
  }
  reconnect() {
    this.disconnect();
    const state = this.#engine.getSourceState(this.#ruleId);
    const result = this.#source.connect({ afterPosition: state.cursor });
    if (result.status === 'history_unavailable') {
      this.#engine.reportSourceIssue(this.#ruleId, 'history_unavailable', result);
    } else {
      this.#engine.sourceConnected(this.#ruleId, { sourceId: this.#source.sourceId, afterPosition: state.cursor });
    }
    return { ...result, executionBlocked: this.#engine.getSourceState(this.#ruleId).continuity !== 'continuous' };
  }
  async #resumePrepared() {
    const id = this.#engine.getRule(this.#ruleId).pendingOperationId;
    if (id) await this.#engine.executePrepared(id, { requestId: `source:${id}` });
  }
  async drain({ maxEvents = 100, maxReconnects = 1 } = {}) {
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || !Number.isSafeInteger(maxReconnects) || maxReconnects < 0) throw new TypeError('Invalid drain limits');
    const deliveries = [];
    let reconnects = 0;
    if (!this.#source.connected || !this.#engine.getSourceState(this.#ruleId).connected) {
      const connection = this.reconnect();
      if (connection.executionBlocked) return { status: this.#blockedStatus(), deliveries, reconnects };
    }
    if (this.#engine.getSourceState(this.#ruleId).continuity !== 'continuous') return { status: this.#blockedStatus(), deliveries, reconnects };
    await this.#resumePrepared();
    while (deliveries.length < maxEvents) {
      const next = this.#source.next();
      if (next.status === 'disconnected') {
        this.#engine.sourceDisconnected(this.#ruleId);
        if (reconnects >= maxReconnects) return { status: 'disconnected', deliveries, reconnects };
        reconnects++;
        if (this.reconnect().executionBlocked) return { status: this.#blockedStatus(), deliveries, reconnects };
        await this.#resumePrepared();
      } else if (next.status === 'end') return { status: 'caught_up', deliveries, reconnects };
      else {
        const result = this.#engine.receiveSourceEvent(this.#ruleId, next.event);
        deliveries.push(result);
        if (['decision_required', 'stopped'].includes(result.disposition)) return { status: result.disposition, deliveries, reconnects };
        await this.#resumePrepared();
      }
    }
    return { status: 'batch_limit', deliveries, reconnects };
  }
}
