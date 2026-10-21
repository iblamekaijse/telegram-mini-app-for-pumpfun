import { PRICE_UNIT } from './event-contract.mjs';

// Arbitrary demonstration units, not SOL, real money/quotes, or a trading strategy.
export const DEMO_START_MS = 1_000_000;
export function demoRule(id = 'demo-rule-1', now = DEMO_START_MS) {
  return {
    id, assetId: 'DEMO:ASSET-A',
    condition: { metric: 'priceUnits', operator: 'lte', thresholdUnits: 100 },
    amountUnits: 10,
    limits: {
      maxTotalSpendUnits: 11, minReceiveUnits: 4, maxFeeUnits: 1,
      maxSlippageBps: 50, maxEventAgeMs: 100,
    },
    expiresAtMs: now + 1_000,
  };
}
export function demoEvent(id = 'demo-event-1', now = DEMO_START_MS) {
  return { id, type: 'synthetic-price', assetId: 'DEMO:ASSET-A', observedAtMs: now, priceUnits: 95 };
}
export const DEMO_SOURCE_ID = 'DEMO:price-feed-v1';
export const DEMO_PRICE_BASIS = Object.freeze({ unit: PRICE_UNIT, quoteAssetId: 'DEMO:QUOTE-A', quoteDecimals: 2 });

export function streamRule(id = 'demo-rule-1', now = DEMO_START_MS) {
  const rule = demoRule(id, now);
  rule.condition.priceBasis = { ...DEMO_PRICE_BASIS };
  return rule;
}

export function sourceEvent(position = 1, overrides = {}) {
  return {
    version: 1, sourceId: DEMO_SOURCE_ID, eventId: `price-${position}`, position,
    assetId: 'DEMO:ASSET-A', occurredAtMs: DEMO_START_MS, type: 'synthetic-price',
    payload: { ...DEMO_PRICE_BASIS, priceUnits: 95 }, ...overrides,
  };
}
