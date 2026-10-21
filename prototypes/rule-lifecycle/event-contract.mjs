export const PRICE_UNIT = 'quote-atomic-per-whole-base';
const integer = (v, min = 0) => Number.isSafeInteger(v) && v >= min;
export const sourceIdValid = v => typeof v === 'string' && v.startsWith('DEMO:') && v.length > 5 && v.length <= 128 && v.trim() === v;
export function priceBasisValid(basis) {
  return basis?.unit === PRICE_UNIT && sourceIdValid(basis.quoteAssetId) && integer(basis.quoteDecimals) && basis.quoteDecimals <= 9;
}
export function sourceEventValid(e) {
  return e?.version === 1 && sourceIdValid(e.sourceId) && typeof e.eventId === 'string' &&
    e.eventId.length > 0 && e.eventId.length <= 128 && e.eventId.trim() === e.eventId &&
    integer(e.position, 1) && sourceIdValid(e.assetId) && integer(e.occurredAtMs) &&
    e.type === 'synthetic-price' && priceBasisValid(e.payload) && integer(e.payload.priceUnits, 1) &&
    !Object.hasOwn(e, 'receivedAtMs'); // Receipt time is stamped locally, never trusted from the source.
}
export function samePriceBasis(a, b) {
  return a.unit === b.unit && a.quoteAssetId === b.quoteAssetId && a.quoteDecimals === b.quoteDecimals;
}
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
