// Load the selected file with Node's native --env-file mechanism before server initialization.
// This preserves inherited priority and existing proxy/CA/NODE_OPTIONS configuration too.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { settings, APP_ROOT } from './config.mjs';
try {
  const cfg=settings();
  const child=spawn(process.execPath,['--env-file-if-exists='+cfg.configPath,'--use-env-proxy',join(APP_ROOT,'web/server.mjs')],
    {stdio:'inherit',detached:process.platform!=='win32'});
  let stopping=false;
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{
    if(stopping)return;stopping=true;
    try{if(process.platform==='win32')child.kill(signal);else process.kill(-child.pid,signal);}catch{}
  });
  child.once('error',()=>{console.error('Запуск не выполнен. Проверьте Node.js и пути через npm run doctor.');process.exitCode=1;});
  child.once('exit',(code,signal)=>{process.exitCode=code??(['SIGINT','SIGTERM'].includes(signal)?0:1);});
} catch {
  console.error('Не удалось прочитать настройки запуска. Выполните npm run doctor; содержимое .env не выводится.');process.exitCode=1;
}
