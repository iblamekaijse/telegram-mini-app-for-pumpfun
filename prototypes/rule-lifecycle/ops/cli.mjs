import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { compatible, LocalError } from './config.mjs';
import { setupLocal, doctor, backupLocal, restoreLocal } from './local.mjs';
export async function main(args = process.argv.slice(2)) {
  try {
    if(!compatible())throw new LocalError('NODE_VERSION','Нужен Node.js 24.19.0 или совместимый более новый. Активируйте нужную версию.');
    const command=args.shift(),options={};let source;
    while(args.length){
      const arg=args.shift();
      if(arg==='--replace-token')options.replaceToken=true;
      else if(['--switch-bot','--adopt-bot','--to','--confirm-path','--overwrite-db'].includes(arg)){
        const value=args.shift();if(!value||value.startsWith('--'))throw new LocalError('ARGUMENT','После параметра нужен ID или путь. Используйте справку в LOCAL_USE.md.');
        options[{'--switch-bot':'switchBotId','--adopt-bot':'adoptBotId','--to':'destination','--confirm-path':'confirmPath','--overwrite-db':'overwriteDbPath'}[arg]]=value;
      }else if(command==='restore'&&!source&&!arg.startsWith('--'))source=arg;
      else throw new LocalError('ARGUMENT','Неизвестный параметр. Токен не передаётся аргументами; используйте скрытый ввод setup.');
    }
    if(command==='setup')await setupLocal(options);
    else if(command==='doctor'){
      const checks=await doctor();for(const check of checks)console.log(`${check.name}: ${check.state} — ${check.detail}`);
      if(checks.some(c=>c.state==='ошибка'))process.exitCode=1;
    }else if(command==='backup'){
      const copy=await backupLocal(options.destination);console.log(`Копия: ${copy.path}\nВерсия данных: ${copy.schemaVersion??'база ещё не создана'}. База: ${copy.database?'проверена':'нет'}. Локальная конфигурация: ${copy.configuration?'сохранена с правами 600':'отсутствует'}. Секреты не выводятся.`);
    }else if(command==='restore'){
      if(!source)throw new LocalError('ARGUMENT','Укажите каталог копии: npm run restore -- /путь/копии [--to /новый/каталог].');
      const restored=await restoreLocal(source,options.destination,options);
      console.log(`Восстановлено: ${restored.path}\nБаза: ${restored.dbPath}\nКонфигурация: ${restored.configPath}\nВерсия: ${restored.schemaVersion}.${restored.previousBackup?' Предыдущее состояние сохранено: '+restored.previousBackup:''} Торговая история и ограничения доступа сохранены.\nЗапуск из каталога приложения: DEMO_ENV_FILE='${restored.configPath.replace(/'/g,"'\\''")}' DEMO_DATA_DIR='${resolve(restored.dbPath,'..').replace(/'/g,"'\\''")}' npm start`);
    }else throw new LocalError('ARGUMENT','Доступны npm run setup, npm run doctor, npm run backup, npm run restore.');
  }catch(error){console.error(`${error instanceof LocalError?error.code:'LOCAL_OPERATION_FAILED'}: ${error instanceof LocalError?error.message:'Операция не завершена. Проверьте права, пути, доступность сети и остановите приложение; секреты и стек не выводятся.'}`);process.exitCode=1;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
