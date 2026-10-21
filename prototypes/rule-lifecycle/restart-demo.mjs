import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { demoRule, demoEvent } from './fixtures.mjs';

const directory = mkdtempSync(join(tmpdir(), 'rule-lifecycle-demo-'));
const worker = fileURLToPath(new URL('./test-support/process-worker.mjs', import.meta.url));
function run(job, expectedSignal = null) {
  const child = spawnSync(process.execPath, [worker, JSON.stringify(job)], { encoding: 'utf8', timeout: 10_000 });
  if (child.error || child.signal !== expectedSignal || (!expectedSignal && child.status !== 0)) {
    throw new Error(`Demo child failed: ${child.error ?? child.stderr ?? child.status}`);
  }
  return JSON.parse(child.stdout.trim());
}
const command = (method, ...args) => ({ method, args });
console.log('DEMO: создание → SIGKILL → восстановление отдельным процессом. Реальная торговля ЗАКРЫТА.');
try {
  const storagePath = join(directory, 'state.sqlite');
  const first = run({ storagePath, initialize: true, killAfterActions: true, actions: [
    command('createRule', demoRule(), { requestId: 'create' }),
    command('enable', 'demo-rule-1', { requestId: 'enable' }),
    command('receiveEvent', 'demo-rule-1', demoEvent()),
  ] }, 'SIGKILL');
  console.log('1. Подтверждённое создание и подготовка сохранены; процесс остановлен:', first.crashPoint);
  const second = run({ storagePath, actions: [
    command('getRule', 'demo-rule-1'),
    command('receiveEvent', 'demo-rule-1', demoEvent()),
    command('executePrepared', 'demo-operation-1', { requestId: 'execute' }),
    command('getRule', 'demo-rule-1'),
  ] });
  console.log(JSON.stringify({ stage: 'recovered_then_explicitly_executed', recoveredRule: second.results[0].state,
    ruleAfterExecution: second.results[3].state,
    duplicate: second.results[1].duplicate, operation: second.results[2].status, simulatorCalls: second.simulatorCalls }));
  const third = run({ storagePath, actions: [
    command('executePrepared', 'demo-operation-1', { requestId: 'execute' }),
    command('getRule', 'demo-rule-1'),
  ] });
  console.log(JSON.stringify({ stage: 'another_restart_and_repeated_command', rule: third.results[1].state,
    operation: third.results[0].status, simulatorCalls: third.simulatorCalls }));

  const uncertainPath = join(directory, 'uncertain.sqlite');
  run({ storagePath: uncertainPath, initialize: true, faultPoint: 'before_result_commit', actions: [
    command('createRule', demoRule(), { requestId: 'create' }),
    command('enable', 'demo-rule-1', { requestId: 'enable' }),
    command('receiveEvent', 'demo-rule-1', demoEvent()),
    command('executePrepared', 'demo-operation-1', { requestId: 'execute' }),
  ] }, 'SIGKILL');
  const recovered = run({ storagePath: uncertainPath, actions: [
    command('executePrepared', 'demo-operation-1', { requestId: 'execute' }),
    command('getRule', 'demo-rule-1'),
    command('enable', 'demo-rule-1', { requestId: 'try-enable' }),
  ] });
  console.log(JSON.stringify({ stage: 'result_lost_before_commit', rule: recovered.results[1].state,
    operation: recovered.results[0].status, enableError: recovered.results[2].error, simulatorCalls: recovered.simulatorCalls }));
} finally { rmSync(directory, { recursive: true, force: true }); }
