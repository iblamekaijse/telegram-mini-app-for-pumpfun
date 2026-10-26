import assert from 'node:assert/strict';
export const emptyTelegramState = () => ({ version: 1, generation: 0, owner: null, code: null, offset: 0,
  pending: null, callbacks: [], seen: [], market: null, marketSequence: 0, outbox: [] });
export function validateTelegramState(t) {
  const n = v => Number.isSafeInteger(v) && v >= 0;
  const identity = v => typeof v === 'string' && /^[1-9][0-9]{0,15}$/.test(v);
  assert(t?.version === 1 && n(t.generation) && n(t.offset) && n(t.marketSequence));
  assert(t.owner === null || identity(t.owner.userId) && identity(t.owner.chatId));
  assert(t.code === null || /^[a-f0-9]{64}$/.test(t.code.hash) && n(t.code.expiresAtMs));
  assert(t.pending === null || n(t.pending.update_id) && t.pending.update_id >= t.offset);
  assert(Array.isArray(t.callbacks) && new Set(t.callbacks.map(c => c.id)).size === t.callbacks.length);
  for (const c of t.callbacks) assert(/^[a-f0-9]{24}$/.test(c.id) && n(c.generation) &&
    ['status', 'enable', 'pause', 'close'].includes(c.action) && typeof c.target === 'string' && n(c.expiresAtMs) && (c.usedUpdateId === undefined || n(c.usedUpdateId)));
  assert(Array.isArray(t.seen) && t.seen.every(v => typeof v === 'string') && new Set(t.seen).size === t.seen.length);
  assert(t.market === null || typeof t.market.key === 'string' && typeof t.market.usable === 'boolean');
  assert(Array.isArray(t.outbox) && new Set(t.outbox.map(e => e.id)).size === t.outbox.length);
  for (const e of t.outbox) assert(typeof e.id === 'string' && n(e.generation) && identity(e.chatId) &&
    ['sendMessage', 'answerCallbackQuery'].includes(e.method) && e.body && typeof e.body === 'object' &&
    n(e.attempts) && n(e.nextAtMs) && ['pending', 'sent', 'failed', 'cancelled'].includes(e.status));
  return t;
}
