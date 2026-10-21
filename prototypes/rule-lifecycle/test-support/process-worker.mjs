// Child-process fixture for crash tests and the restart demonstration. DEMO ONLY.
import { appendFileSync, openSync, closeSync, fsyncSync, writeSync } from 'node:fs';
import { RuleEngine } from '../rule-engine.mjs';
import { SimulatedExecutor } from '../simulator.mjs';
import { DEMO_START_MS } from '../fixtures.mjs';
import { SyntheticSource } from '../synthetic-source.mjs';
import { SourceConsumer } from '../source-consumer.mjs';
import { createTrustedDemoOwnerContext } from '../demo-owner.mjs';

const job = JSON.parse(process.argv[2]);
const results = [];
const print = value => writeSync(1, `${JSON.stringify(value)}\n`);
function crash(point) {
  print({ crashPoint: point, results });
  process.kill(process.pid, 'SIGKILL');
}

class TracedSimulator extends SimulatedExecutor {
  submit(intent) {
    // Test-only independent observation of handoffs, not a production execution ledger.
    if (job.tracePath) {
      appendFileSync(job.tracePath, `${JSON.stringify({ operationId: intent.operationId, mode: 'demo' })}\n`);
      const fd = openSync(job.tracePath, 'r');
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    return super.submit(intent);
  }
}

try {
  let now = job.now ?? DEMO_START_MS;
  const simulator = new TracedSimulator({ outcome: job.outcome ?? 'succeeded', hold: job.hold ?? false });
  const options = {
    storagePath: job.storagePath, executor: simulator, clock: () => now,
    faultInjector: point => { if (point === job.faultPoint) crash(point); },
  };
  const engine = job.initialize ? RuleEngine.initialize(options) : RuleEngine.open(options);
  // A privileged test-harness option, not an incoming request's ownerId.
  const ownerContext = job.trustedDemoOwner ? createTrustedDemoOwnerContext(job.trustedDemoOwner) : undefined;
  const source = job.source ? new SyntheticSource(job.source) : null;
  if (job.source?.retainedFrom) source.pruneBefore(job.source.retainedFrom);
  if (job.source?.replay) source.replayOnNextConnect(job.source.replay);
  if (job.source?.disconnectAfter !== undefined) source.disconnectAfter(job.source.disconnectAfter);
  let consumer;
  const getConsumer = () => consumer ??= new SourceConsumer({ engine, source, ruleId: job.ruleId ?? 'demo-rule-1' });
  let pending;
  const allowed = new Set(['createRule', 'enable', 'pause', 'revoke', 'receiveEvent', 'handleEvent', 'executePrepared', 'getRule', 'getOperation', 'tick',
    'bindSource', 'getSourceState', 'receiveSourceEvent', 'sourceConnected', 'sourceDisconnected', 'reportSourceIssue',
    'decideSourceIssue', 'getSourceDecisionLog']);
  for (const { method, args = [] } of job.actions ?? []) {
    try {
      if (method === 'setNow') { now = args[0]; results.push({ ok: true }); }
      else if (method === 'sourceDrain') results.push(await getConsumer().drain(...args));
      else if (method === 'sourceReconnect') results.push(getConsumer().reconnect());
      else if (method === 'ownerDecision') results.push(getConsumer().decideIssue(args[0], { ...args[1], ownerContext }));
      else if (method === 'sourceDisconnect') { getConsumer().disconnect(); results.push(null); }
      else if (method === 'sourceReplay') { source.replayOnNextConnect(...args); results.push(null); }
      else if (method === 'submitWithoutWaiting') {
        pending = engine.executePrepared(...args); results.push({ pending: true });
      } else if (method === 'completeSimulator') {
        simulator.completeNext(); results.push(await pending);
      } else {
        if (!allowed.has(method)) throw new Error('Unsupported fixture action');
        results.push((await engine[method](...args)) ?? null);
      }
    } catch (error) { results.push({ error: error.code ?? error.name }); }
  }
  if (job.killAfterActions) crash('after_acknowledged_actions');
  print({ results, simulatorCalls: simulator.callCount, mode: engine.mode, liveTradingAllowed: engine.liveTradingAllowed });
  if (job.stayAlive) setInterval(() => {}, 1000);
  else engine.close();
} catch (error) {
  print({ error: error.code ?? error.name, message: error.message });
  process.exitCode = 2;
}
