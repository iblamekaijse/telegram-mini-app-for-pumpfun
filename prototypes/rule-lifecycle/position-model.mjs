// Exact rational model. JSON stores reduced decimal integer strings, never floats.
import { canonical } from './event-contract.mjs';
export function rational(n, d = 1n) {
  n = BigInt(n); d = BigInt(d);
  if (d === 0n) throw new RangeError('Zero denominator');
  if (d < 0n) { n = -n; d = -d; }
  let a = n < 0n ? -n : n, b = d;
  while (b) [a, b] = [b, a % b];
  return { n: String(n / a), d: String(d / a) };
}
const mul = (a, b) => rational(BigInt(a.n) * BigInt(b.n), BigInt(a.d) * BigInt(b.d));
const sub = (a, b) => rational(BigInt(a.n) * BigInt(b.d) - BigInt(b.n) * BigInt(a.d), BigInt(a.d) * BigInt(b.d));
const div = (a, b) => rational(BigInt(a.n) * BigInt(b.d), BigInt(a.d) * BigInt(b.n));
export const usd = units => rational(units, 1_000_000_000n);
export function positionPolicyValid(p) {
  return p?.version === 1 && Number.isSafeInteger(p.takeProfitBps) && p.takeProfitBps > 0 && p.takeProfitBps <= 1_000_000 &&
    Number.isSafeInteger(p.stopLossBps) && p.stopLossBps > 0 && p.stopLossBps < 10_000;
}
export function positionValues(amountUnits, entryUnits, priceUnits, policy) {
  const amount = usd(amountUnits), entry = usd(entryUnits), price = usd(priceUnits);
  const quantity = div(amount, entry), valuation = mul(quantity, price), pnlUsd = sub(valuation, amount);
  return { amount, entry, quantity, price, valuation, pnlUsd, pnlPercent: mul(div(pnlUsd, amount), rational(100)),
    takeProfit: mul(entry, rational(10_000 + policy.takeProfitBps, 10_000)),
    stopLoss: mul(entry, rational(10_000 - policy.stopLossBps, 10_000)) };
}
export function exitReason(entryUnits, priceUnits, policy) {
  const price = BigInt(priceUnits) * 10_000n, entry = BigInt(entryUnits);
  return price >= entry * BigInt(10_000 + policy.takeProfitBps) ? 'take_profit'
    : price <= entry * BigInt(10_000 - policy.stopLossBps) ? 'stop_loss' : null;
}
export function formatRational(value, places = 9) {
  const n = BigInt(value.n), d = BigInt(value.d), scale = 10n ** BigInt(places);
  const rounded = ((n < 0n ? -n : n) * scale * 2n + d) / (2n * d);
  const fraction = (rounded % scale).toString().padStart(places, '0').replace(/0+$/, '');
  return `${n < 0n && rounded ? '-' : ''}${rounded / scale}${fraction ? `.${fraction}` : ''}`;
}
export const sameBinding = (a, b) => !!a && !!b && ['provider', 'chainId', 'dexId', 'mint', 'pairAddress', 'quoteMint', 'priceField'].every(k => a[k] === b[k]);
export const sameExact = (a, b) => canonical(a) === canonical(b);
