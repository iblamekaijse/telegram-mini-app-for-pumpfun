const outcomes = new Set(['succeeded', 'failed', 'unknown', 'throw']);

/** Synthetic executor only: no wallets, signing, network, or transaction transport. */
export class SimulatedExecutor {
  #outcome;
  #hold;
  #receipt;
  #requests = [];
  #pending = [];

  constructor({ outcome = 'succeeded', hold = false, receipt = {} } = {}) {
    if (!outcomes.has(outcome)) throw new TypeError('Unsupported demo outcome');
    this.#outcome = outcome;
    this.#hold = hold;
    this.#receipt = structuredClone(receipt);
  }

  get mode() { return 'demo'; }
  get callCount() { return this.#requests.length; }
  get requests() { return structuredClone(this.#requests); }

  submit(intent) {
    if (intent.mode !== 'demo' || intent.liveTradingAllowed !== false) {
      throw new TypeError('Only demo intents are supported');
    }
    this.#requests.push(structuredClone(intent));
    if (this.#hold) {
      return new Promise((resolve, reject) => this.#pending.push({ intent, resolve, reject }));
    }
    return this.#result(intent);
  }

  completeNext() {
    const next = this.#pending.shift();
    if (!next) throw new Error('No pending demo operation');
    try { next.resolve(this.#result(next.intent)); }
    catch (error) { next.reject(error); }
  }

  #result(intent) {
    if (this.#outcome === 'throw') throw new Error('Synthetic transport uncertainty');
    if (this.#outcome !== 'succeeded') {
      return { mode: 'demo', status: this.#outcome, reason: `scripted_${this.#outcome}` };
    }
    const receipt = {
      spentUnits: intent.amountUnits,
      receivedUnits: intent.limits.minReceiveUnits,
      feeUnits: 0,
      slippageBps: 0,
      ...this.#receipt,
    };
    if (Object.values(receipt).some(value => !Number.isSafeInteger(value) || value < 0)) {
      throw new TypeError('Invalid synthetic receipt');
    }
    const { spentUnits, receivedUnits, feeUnits, slippageBps } = receipt;
    if (spentUnits !== intent.amountUnits ||
        spentUnits + feeUnits > intent.limits.maxTotalSpendUnits ||
        feeUnits > intent.limits.maxFeeUnits ||
        receivedUnits < intent.limits.minReceiveUnits ||
        slippageBps > intent.limits.maxSlippageBps) {
      return { mode: 'demo', status: 'failed', reason: 'synthetic_limits_exceeded' };
    }
    return { mode: 'demo', status: 'succeeded', receipt };
  }
}
