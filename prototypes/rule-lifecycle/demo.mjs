import { RuleEngine } from './rule-engine.mjs';
import { SimulatedExecutor } from './simulator.mjs';
import { demoRule, demoEvent, DEMO_START_MS } from './fixtures.mjs';

console.log('ДЕМО: только синтетические события и условные единицы.');
console.log('Кошельков и транзакций нет. Допуск к реальной торговле: ЗАКРЫТ.\n');
function scenario(options = {}) {
  let now = DEMO_START_MS;
  const simulator = new SimulatedExecutor(options);
  const engine = new RuleEngine({ clock: () => now, executor: simulator });
  const config = demoRule();
  engine.createRule(config, { requestId: 'create-1' });
  engine.enable(config.id, { requestId: 'enable-1' });
  return { engine, simulator, config, advance: ms => { now += ms; } };
}
function show(label, { engine, simulator, config }, operationId) {
  console.log(JSON.stringify({
    scenario: label, mode: engine.mode, liveTradingAllowed: engine.liveTradingAllowed,
    rule: engine.getRule(config.id).state,
    operation: operationId ? engine.getOperation(operationId).status : null,
    simulatorCalls: simulator.callCount,
  }, null, 2));
}

for (const outcome of ['succeeded', 'failed', 'unknown']) {
  const s = scenario({ outcome });
  const { operation } = await s.engine.handleEvent(s.config.id, demoEvent());
  const operationId = operation.id;
  // Both deliveries are repeated deliberately, without creating a new purchase.
  s.engine.receiveEvent(s.config.id, demoEvent());
  await s.engine.executePrepared(operationId, { requestId: 'execute-1' });
  show(`Результат ${outcome}; повторные запросы`, s, operationId);
}

for (const action of ['pause', 'expire', 'revoke']) {
  const s = scenario();
  const { operationId } = s.engine.receiveEvent(s.config.id, demoEvent());
  if (action === 'expire') { s.advance(1_000); s.engine.tick(); }
  else s.engine[action](s.config.id, { requestId: action });
  await s.engine.executePrepared(operationId, { requestId: 'execute-after-stop' });
  show(`${action} до передачи имитатору`, s, operationId);
}

const s = scenario({ hold: true });
const { operationId } = s.engine.receiveEvent(s.config.id, demoEvent());
const pending = s.engine.executePrepared(operationId, { requestId: 'execute-1' });
s.engine.pause(s.config.id, { requestId: 'pause-in-flight' });
show('Пауза после передачи: операция продолжает ожидать результат', s, operationId);
s.simulator.completeNext();
await pending;
show('Результат ранее переданной операции после паузы', s, operationId);
