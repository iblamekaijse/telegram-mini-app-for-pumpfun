import { randomUUID } from 'node:crypto';
import { mintValid, decimalUnits, WSOL_MINT, MARKET_PRICE_BASIS } from '../market-contract.mjs';

export const POLL_MS = 10_000;
export const STALE_MS = 45_000; // Local observation age only; provider price age is unknown.
export const API_ORIGIN = 'https://api.dexscreener.com';
export function eligiblePairs(payload, mint) {
  if (!Array.isArray(payload)) throw new Error('INVALID_RESPONSE');
  return payload.filter(p => p?.chainId === 'solana' && p.dexId === 'pumpswap' && p.baseToken?.address === mint &&
    p.quoteToken?.address === WSOL_MINT && mint !== WSOL_MINT && mintValid(p.pairAddress))
    .sort((a, b) => (Number.isFinite(b.liquidity?.usd) ? b.liquidity.usd : 0) -
      (Number.isFinite(a.liquidity?.usd) ? a.liquidity.usd : 0) || a.pairAddress.localeCompare(b.pairAddress));
}

/** One local subscription, no replay/history/stream completeness claim. */
export class MarketSnapshots {
  #fetch; #clock; #busy = false; #state; #failures = 0;
  constructor({ fetchImpl = fetch, clock = Date.now, binding = null } = {}) {
    this.#fetch = fetchImpl; this.#clock = clock;
    this.#state = { status: binding ? 'waiting' : 'idle', mint: binding?.mint ?? null, binding, token: null, snapshot: null,
      nextPollAtMs: binding ? clock() : 0, lastAttemptAtMs: null, lastSuccessAtMs: null, error: null, interruptions: 0,
      recoveries: 0, recoveredAtMs: null, pollIntervalMs: POLL_MS, staleAfterMs: STALE_MS };
  }
  state() {
    const s = structuredClone(this.#state);
    s.stale = !!s.snapshot && this.#clock() - s.snapshot.observedAtMs > STALE_MS;
    if (s.status === 'fresh' && s.stale) s.status = 'stale';
    return s;
  }
  get due() { return !!this.#state.mint && !this.#busy && this.#clock() >= this.#state.nextPollAtMs; }
  async select(mint) {
    if (!mintValid(mint)) throw new TypeError('INVALID_MINT');
    if (this.#busy) return { limited: true };
    if (this.#state.mint !== mint) Object.assign(this.#state, { binding: null, token: null, snapshot: null, lastSuccessAtMs: null, error: null });
    this.#state.mint = mint;
    if (this.#clock() < this.#state.nextPollAtMs) { this.#state.status = 'waiting'; return { scheduled: true }; }
    return this.poll();
  }
  async poll() {
    if (!this.due) return { limited: true };
    const s = this.#state, started = this.#clock(), previousError = s.error;
    this.#busy = true; s.status = 'loading'; s.lastAttemptAtMs = started; s.nextPollAtMs = started + POLL_MS;
    try {
      const response = await this.#fetch(`${API_ORIGIN}/token-pairs/v1/solana/${s.mint}`, {
        headers: { Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(8000), redirect: 'error',
      });
      if (!response.ok) {
        if (response.status === 429) {
          const header = response.headers.get('retry-after');
          const seconds = /^\d+$/.test(header ?? '') ? Number(header) : Math.ceil((Date.parse(header) - this.#clock()) / 1000);
          s.nextPollAtMs = this.#clock() + Math.max(60_000, Number.isFinite(seconds) ? seconds * 1000 : 0);
        }
        throw new Error(`HTTP_${response.status}`);
      }
      const text = await response.text();
      if (text.length > 2_000_000) throw new Error('INVALID_RESPONSE');
      const pairs = eligiblePairs(JSON.parse(text), s.mint);
      const pair = s.binding ? pairs.find(p => p.pairAddress === s.binding.pairAddress) : pairs[0];
      if (!pair) throw new Error('NO_SUPPORTED_POOL');
      let priceUnits;
      try { priceUnits = decimalUnits(pair.priceUsd); }
      catch { throw new Error('PRICE_UNAVAILABLE_OR_UNSUPPORTED_PRECISION'); }
      const binding = s.binding ?? { mode: 'market-paper', provider: 'dexscreener', chainId: 'solana', dexId: 'pumpswap',
        mint: s.mint, pairAddress: pair.pairAddress, quoteMint: WSOL_MINT, priceField: 'priceUsd' };
      const receivedAtMs = this.#clock();
      const snapshot = { ...binding, id: `observation-${randomUUID()}`, idKind: 'local-observation', type: 'market-price-snapshot',
        assetId: `SOLANA:${s.mint}`, observedAtMs: started, receivedAtMs, providerUpdatedAtMs: null,
        rawPriceUsd: pair.priceUsd, priceUnits, priceBasis: { ...MARKET_PRICE_BASIS } };
      if (previousError) { s.recoveries++; s.recoveredAtMs = receivedAtMs; }
      Object.assign(s, { binding, token: { name: String(pair.baseToken.name ?? '').slice(0, 120), symbol: String(pair.baseToken.symbol ?? '').slice(0, 40) },
        snapshot, lastSuccessAtMs: receivedAtMs, status: 'fresh', error: null });
      this.#failures = 0;
      // Cooldown after completion prevents bursts after a slow response.
      s.nextPollAtMs = receivedAtMs + POLL_MS;
      return { snapshot };
    } catch (error) {
      const reason = ['NO_SUPPORTED_POOL', 'PRICE_UNAVAILABLE_OR_UNSUPPORTED_PRECISION'].includes(error.message) ? error.message :
        /^HTTP_\d+$/.test(error.message) ? error.message : 'PROVIDER_UNAVAILABLE';
      this.#failures++;
      if (!previousError) s.interruptions++;
      Object.assign(s, { status: reason === 'NO_SUPPORTED_POOL' ? 'no_data' : 'error', error: reason });
      s.nextPollAtMs = Math.max(s.nextPollAtMs, this.#clock() + Math.min(120_000, POLL_MS * 2 ** Math.min(this.#failures, 4)));
      return { error: reason };
    } finally { this.#busy = false; }
  }
}
