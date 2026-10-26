import { emptyTelegramState } from './telegram-state.mjs';
export const botIdValid = id => typeof id === 'string' && /^[1-9][0-9]{0,15}$/.test(id);
export function botIdentity(result) {
  if (!Number.isSafeInteger(result?.id) || result.id <= 0 || result.is_bot !== true) throw Object.assign(new Error('Некорректный ответ getMe.'), { code: 'BOT_IDENTITY_INVALID' });
  return String(result.id);
}
export function bindBotIdentity(state, id, { switchBotId, adoptBotId } = {}) {
  if (!botIdValid(id)) throw Object.assign(new Error('Не удалось подтвердить ID бота.'), { code: 'BOT_IDENTITY_INVALID' });
  if (state.botId === id) return structuredClone(state);
  const used = state.owner || state.code || state.offset || state.pending || state.callbacks.length || state.outbox.length || state.dialog;
  if (switchBotId === id) return { ...emptyTelegramState(), generation: state.generation + 1, botId: id };
  if (state.botId === null && (!used || adoptBotId === id)) return { ...structuredClone(state), botId: id };
  throw Object.assign(new Error(state.botId ? 'Токен относится к другому боту. Выполните локальную setup со сменой бота.'
    : 'В прежней базе ID бота не записан. Подтвердите его локально через setup перед продолжением.'),
  { code: state.botId ? 'BOT_IDENTITY_MISMATCH' : 'BOT_IDENTITY_REQUIRED' });
}
