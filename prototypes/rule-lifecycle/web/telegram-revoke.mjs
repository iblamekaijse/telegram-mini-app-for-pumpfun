/** Eligibility for the Telegram action only; all mutations use the existing panel command service. */
export function canRevokeRule(rule, state) {
  return !!rule && rule.config.id === state.currentRuleId && ['draft', 'active', 'paused'].includes(rule.state) &&
    !rule.submittedOperationId && !rule.operations.some(o => ['submitted', 'succeeded', 'failed', 'unknown'].includes(o.status)) &&
    !state.positions.some(p => p.ruleId === rule.config.id) && rule.stream?.continuity !== 'decision_required';
}
function refusal(rule, state) {
  const position = rule && state.positions.find(p => p.ruleId === rule.config.id);
  if (position) return `Вход уже произошёл. Существует позиция ${position.id}. Отзыв входного правила недоступен. ${position.status === 'closed' ? 'Позиция уже закрыта; результат сохранён в истории.' : 'Для позиции есть отдельное действие «Запросить закрытие позиции»; оно ждёт следующего пригодного снимка.'}`;
  if (rule?.operations.some(o => o.status === 'unknown')) return 'Исход входной операции неизвестен (unknown). Отзыв до передачи недоступен; повтор операции запрещён.';
  if (rule?.submittedOperationId) return 'Входная операция уже передана. Отзыв до передачи недоступен; неизвестный исход не разрешает повтор.';
  if (rule?.state === 'revoked') return `Правило ${rule.config.id} уже отозвано. История сохранена; можно создать новое правило.`;
  return 'Правило изменилось, истекло или относится к прежнему циклу. Отзыв не выполнен; запросите текущее состояние. Новое правило не изменено.';
}

export function handleRevocation(controller, t, button, updateId) {
  const c = controller;
  const response = text => ({ text, keyboard: c.keyboard(t, c.view()) });
  if (button.action === 'revoke') {
    const state = c.view(), rule = state.rules.find(r => r.config.id === button.target);
    if (!canRevokeRule(rule, state)) return response(refusal(rule, state));
    // The saved request button identifies the rule and the lifetime of both confirm/cancel buttons.
    button.expiresAtMs = Math.min(button.expiresAtMs, c.clock() + 300_000);
    return { text: `Отозвать правило ${rule.config.id}?\nАктив: ${rule.config.assetId}\nОтзыв окончательный: включить это правило снова будет нельзя. Для временной остановки есть пауза.\nПозиция не закрывается, черновик настройки не отменяется. Подтверждение действует 5 минут.`,
      keyboard: { inline_keyboard: [
        [c.button(t, 'Подтвердить окончательный отзыв', 'revoke_confirm', button.id)],
        [c.button(t, 'Не отзывать правило', 'revoke_cancel', button.id)],
      ] } };
  }
  const request = t.callbacks.find(b => b.id === button.target && b.action === 'revoke' && b.generation === t.generation);
  if (!request || c.clock() >= request.expiresAtMs) return response('Подтверждение отзыва отменено или устарело. Запросите текущее состояние; правило не изменено.');
  if (button.action === 'revoke_cancel') {
    request.expiresAtMs = c.clock();
    return response(`Отзыв правила ${request.target} отменён. Правило и черновик настройки не изменены.`);
  }
  const state = c.view(), rule = state.rules.find(r => r.config.id === request.target);
  if (!canRevokeRule(rule, state)) {
    request.expiresAtMs = c.clock();
    return response(refusal(rule, state));
  }
  try {
    // Stable across lost final saves, retries and distinct updates for the same confirmation.
    c.command(rule.config.id, 'revoke', { requestId: `telegram-revoke-${request.id}` });
    request.expiresAtMs = c.clock();
    return response(`Правило ${rule.config.id} окончательно отозвано. История сохранена. Выберите «Новое виртуальное правило», чтобы перейти к другому токену. Черновик настройки, если он был, сохранён.`);
  } catch (error) {
    if (!error.code || error.code.startsWith('STORAGE_')) throw error;
    return response(`Отзыв не выполнен: состояние изменилось (${error.code}). Правило и ограничения unknown проверяются прежним сервисом. Запросите текущее состояние.`);
  }
}
