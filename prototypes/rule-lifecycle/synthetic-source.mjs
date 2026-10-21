import { sourceEventValid, sourceIdValid } from './event-contract.mjs';

/** Finite, deterministic retained log. No network or market data. */
export class SyntheticSource {
  #events;
  #sourceId;
  #retainedFrom = 1;
  #queue = [];
  #connected = false;
  #replay = [];
  #breakAfter = null;

  constructor({ sourceId, events }) {
    if (!sourceIdValid(sourceId) || !Array.isArray(events) ||
      !events.every((e, i) => sourceEventValid(e) && e.sourceId === sourceId && e.position === i + 1) ||
      new Set(events.map(e => e.eventId)).size !== events.length) throw new TypeError('Invalid synthetic log');
    this.#sourceId = sourceId;
    this.#events = structuredClone(events);
  }
  get sourceId() { return this.#sourceId; }
  get connected() { return this.#connected; }
  readRecoveryHistory() {
    // An immutable finite snapshot, not a new starting-point attestation.
    if (this.#retainedFrom !== 1) return { status: 'history_unavailable', retainedFrom: this.#retainedFrom, head: this.#events.length };
    return { status: 'available', sourceId: this.#sourceId, head: this.#events.length, records: structuredClone(this.#events) };
  }
  pruneBefore(position) {
    if (!Number.isSafeInteger(position) || position < this.#retainedFrom || position > this.#events.length + 1) throw new TypeError('Invalid retention floor');
    this.#retainedFrom = position;
  }
  replayOnNextConnect(positions) {
    if (!Array.isArray(positions) || !positions.every(p => Number.isSafeInteger(p) && p >= this.#retainedFrom && p <= this.#events.length)) throw new TypeError('Invalid replay');
    this.#replay = [...positions];
  }
  disconnectAfter(deliveries) {
    if (!Number.isSafeInteger(deliveries) || deliveries < 0) throw new TypeError('Invalid disconnect point');
    this.#breakAfter = deliveries;
  }
  disconnect() { this.#connected = false; }
  connect({ afterPosition }) {
    this.#connected = false;
    if (!Number.isSafeInteger(afterPosition) || afterPosition < 0) throw new TypeError('Invalid resume cursor');
    if (afterPosition < this.#retainedFrom - 1 || afterPosition > this.#events.length) {
      return { status: 'history_unavailable', retainedFrom: this.#retainedFrom, head: this.#events.length };
    }
    this.#queue = [...this.#replay.map(p => this.#events[p - 1]), ...this.#events.slice(afterPosition)];
    this.#replay = [];
    this.#connected = true;
    return { status: 'connected', afterPosition };
  }
  next() {
    if (!this.#connected) return { status: 'disconnected' };
    if (this.#breakAfter === 0) {
      this.#breakAfter = null;
      this.disconnect();
      return { status: 'disconnected' };
    }
    if (!this.#queue.length) return { status: 'end' };
    if (this.#breakAfter !== null) this.#breakAfter--;
    return { status: 'event', event: structuredClone(this.#queue.shift()) };
  }
}
