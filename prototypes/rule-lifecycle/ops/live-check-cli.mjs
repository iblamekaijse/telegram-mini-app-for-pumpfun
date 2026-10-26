import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { settings, compatible, LocalError } from './config.mjs';
import { runLiveCheck } from './live-check.mjs';

const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => abort.abort());
try {
  if (!compatible()) throw new LocalError('NODE_VERSION', 'Нужен Node.js 24.19.0 или совместимый более новый.');
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--mint'))
    throw new LocalError('ARGUMENT', 'Допускается только --mint ПУБЛИЧНЫЙ_MINT. Токен и получателя параметрами не передавать.');
  const result = await runLiveCheck({ config: settings(), mint: args[1], signal: abort.signal });
  if (result.failure) process.exitCode = 1;
  else if (result.restartRequired) {
    console.log('Контрольный перезапуск: новый процесс Node с прежней SQLite и конфигурацией.');
    const child = spawn(process.execPath, ['--use-env-proxy', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
      { stdio: 'inherit', detached: process.platform !== 'win32' });
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
      if (stopping) return; stopping = true;
      try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal); } catch {}
    });
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code, signal) => done(code ?? (signal ? 1 : 0))); });
    process.exitCode = code;
  }
} catch (error) {
  console.error(`${error instanceof LocalError ? error.code + ': ' + error.message : 'CHECK_ERROR: Прогон не начат. Выполните npm run doctor; секреты и стек исключены.'}`);
  process.exitCode = 1;
}
