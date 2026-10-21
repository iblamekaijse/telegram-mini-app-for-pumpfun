// Local observations of a third-party index. No blockchain cursor or trade ID.
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const MARKET_PRICE_BASIS = Object.freeze({ unit: 'quote-atomic-per-whole-base', quoteAssetId: 'FIAT:USD', quoteDecimals: 9 });
export function mintValid(value) {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const c of value) n = n * 58n + BigInt(alphabet.indexOf(c));
  const leading = value.match(/^1*/)[0].length;
  return leading + (n === 0n ? 0 : Math.ceil(n.toString(2).length / 8)) === 32;
}
export const assetValid = value => typeof value === 'string' &&
  ((value.startsWith('DEMO:') && value.length > 5 && value.length <= 128 && value.trim() === value) ||
    (value.startsWith('SOLANA:') && mintValid(value.slice(7))));
export function decimalUnits(value, decimals = 9) {
  if (typeof value !== 'string' || !/^\d{1,9}(\.\d{1,18})?$/.test(value)) throw new TypeError('Invalid decimal');
  const [whole, fraction = ''] = value.split('.');
  if (/[1-9]/.test(fraction.slice(decimals))) throw new TypeError('Unsupported price precision');
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.slice(0, decimals).padEnd(decimals, '0'));
  if (units < 1n || units > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError('Unsupported price range');
  return Number(units);
}
export function marketBindingValid(b) {
  return b?.mode === 'market-paper' && b.provider === 'dexscreener' && b.chainId === 'solana' && b.dexId === 'pumpswap' &&
    mintValid(b.mint) && b.mint !== WSOL_MINT && mintValid(b.pairAddress) && b.quoteMint === WSOL_MINT && b.priceField === 'priceUsd';
}
export function marketSnapshotValid(e) {
  try {
    return e?.type === 'market-price-snapshot' && typeof e.id === 'string' && e.id.length > 0 && e.id.length <= 128 &&
      e.idKind === 'local-observation' && e.provider === 'dexscreener' && e.providerUpdatedAtMs === null &&
      e.assetId === `SOLANA:${e.mint}` && marketBindingValid(e) &&
      Number.isSafeInteger(e.observedAtMs) && e.observedAtMs >= 0 &&
      Number.isSafeInteger(e.receivedAtMs) && e.receivedAtMs >= e.observedAtMs &&
      e.priceBasis?.unit === MARKET_PRICE_BASIS.unit && e.priceBasis.quoteAssetId === 'FIAT:USD' && e.priceBasis.quoteDecimals === 9 &&
      decimalUnits(e.rawPriceUsd) === e.priceUnits;
  } catch { return false; }
}
