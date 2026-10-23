// OFFLINE process/crash harness only; never loaded by the panel.
import { RuleEngine } from '../rule-engine.mjs';
import { SimulatedExecutor } from '../simulator.mjs';
const job = JSON.parse(process.argv[2]);
class VirtualExecutor extends SimulatedExecutor {
  submit() { return { mode: 'demo', status: 'succeeded', kind: 'virtual-condition' }; }
}
const engine = RuleEngine[job.initialize ? 'initialize' : 'open']({ storagePath: job.storagePath,
  clock: () => job.now, executor: new VirtualExecutor(),
  faultInjector: point => { if (point === job.faultPoint) process.kill(process.pid, 'SIGKILL'); } });
if (job.action === 'enter') {
  engine.createRule(job.config, { requestId: 'worker-create' }); engine.enable(job.config.id, { requestId: 'worker-enable' });
  const delivery = engine.receiveMarketSnapshot(job.config.id, job.entry);
  await engine.executePrepared(delivery.operationId, { requestId: 'worker-execute' });
}
if (job.action === 'snapshot') engine.receivePositionSnapshot(engine.listPositions()[0].id, job.event);
if (job.action === 'retry') await engine.executePrepared('demo-operation-1', { requestId: 'worker-execute' });
const rules = engine.listRules();
console.log(JSON.stringify({ rules, positions: engine.listPositions(), operations: rules.flatMap(r => r.operationIds.map(id => engine.getOperation(id))) }));
engine.close();
