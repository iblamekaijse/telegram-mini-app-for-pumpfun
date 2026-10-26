import { existsSync, mkdirSync, statSync, readFileSync, copyFileSync, chmodSync, renameSync, rmSync, constants, realpathSync, mkdtempSync } from 'node:fs';
import { resolve, dirname, join, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { get } from 'node:http';
import { settings, compatible, atomicFile, editConfig, LocalError } from './config.mjs';
import { inspectDatabase, fileChecksum, checksum } from './storage.mjs';
import { bindBotIdentity, botIdentity } from '../telegram-identity.mjs';
import { TelegramTransport } from '../web/telegram.mjs';
import { validateSnapshot } from '../state-schema.mjs';
import { secretPrompt, confirmPrompt } from './prompt.mjs';
const identityMessages = { BOT_IDENTITY_MISMATCH:'Токен принадлежит другому боту. Для явной смены выполните setup -- --switch-bot ID_НОВОГО_БОТА; торговая история сохранится, Telegram-привязка и очередь будут сброшены.',
  BOT_IDENTITY_REQUIRED:'В прежней базе не записан ID бота. Для сохранения Telegram-доступа подтвердите прежнего бота через setup -- --adopt-bot ID_БОТА; для нового используйте --switch-bot ID_БОТА.' };
const apiError = e => new LocalError('TELEGRAM_API', e.status===401||e.status===403?'Telegram отклонил токен (401/403). Проверьте или перевыпустите его в BotFather, затем выполните npm run setup -- --replace-token.'
  :e.status===429?`Telegram ограничил запросы (429). ${Number.isSafeInteger(e.retryAfter)&&e.retryAfter>0?'Повторите через '+e.retryAfter+' с.':'Дождитесь Retry-After и повторите команду.'}`:'Telegram API недоступен. Проверьте интернет/proxy и повторите; секретные URL не выводятся.');
export function panelRequest(port, timeout=1200) {
  return new Promise(resolveResult=>{
    const req=get({hostname:'127.0.0.1',port,path:'/api/diagnostics',timeout},res=>{
      let text='';res.on('data',chunk=>{text+=chunk;if(text.length>100000)req.destroy();});res.on('end',()=>{try{resolveResult(res.statusCode===200?JSON.parse(text):null);}catch{resolveResult(null);}});
    });req.on('timeout',()=>req.destroy());req.on('error',()=>resolveResult(null));
  });
}
export async function setupLocal(options={}) {
  const cfg=settings(options), output=options.output??(s=>process.stdout.write(s+'\n'));
  output(`Конфигурация: ${cfg.configPath}\nИстория: ${cfg.dbPath}`);
  let token=cfg.token;
  if(options.replaceToken||!token)token=(await (options.prompt??secretPrompt)('Токен BotFather (ввод скрыт): ')).trim();
  if(!token||/[\r\n\0]/.test(token))throw new LocalError('TOKEN_REQUIRED','Токен не задан или содержит перевод строки. Повторите setup; настройки не сброшены.');
  const inherited=(options.env??process.env).TELEGRAM_BOT_TOKEN;
  if(inherited&&inherited!==token)output('Переменная TELEGRAM_BOT_TOKEN текущей оболочки перекрывает .env. Перед запуском уберите её: unset TELEGRAM_BOT_TOKEN.');
  const transport=options.transport??new TelegramTransport(token);let me;
  try{me=await transport.call('getMe',{});}catch(e){throw apiError(e);}
  const id=botIdentity(me);output(`Проверен бот ID ${id}${/^[A-Za-z0-9_]+$/.test(me.username??'')?' @'+me.username:''}. getMe не проверяет полный пользовательский цикл.`);
  let next;
  if(existsSync(cfg.dbPath)){
    const { SnapshotStore }=await import('../snapshot-store.mjs');
    let store;try{store=new SnapshotStore(cfg.dbPath);}catch{throw new LocalError('STORAGE_BUSY_OR_INVALID','База занята или не прошла проверку. Остановите приложение, выполните doctor; история не сбрасывается.');}
    try{
      const state=validateSnapshot(store.load());
      let action={switchBotId:options.switchBotId,adoptBotId:options.adoptBotId};
      try{next=bindBotIdentity(state.telegram,id,action);}
      catch(e){
        if(!['BOT_IDENTITY_REQUIRED','BOT_IDENTITY_MISMATCH'].includes(e.code))throw e;
        output(identityMessages[e.code]);
        const answer=await (options.confirm??confirmPrompt)(e.code==='BOT_IDENTITY_REQUIRED'
          ?`Если это прежний бот и нужно сохранить доступ, введите его ID ${id}; Enter — отмена: `
          :`Для смены бота с удалением только Telegram-доступа/очереди введите «СМЕНИТЬ ${id}»; Enter — отмена: `);
        if(e.code==='BOT_IDENTITY_REQUIRED'&&answer===id)action={adoptBotId:id};
        else if(answer===`СМЕНИТЬ ${id}`)action={switchBotId:id};else throw new LocalError(e.code,identityMessages[e.code]);
        next=bindBotIdentity(state.telegram,id,action);
      }
      if(options.switchBotId&&options.switchBotId!==id||options.adoptBotId&&options.adoptBotId!==id)throw new LocalError('BOT_CONFIRMATION','Подтверждённый ID не совпадает с getMe. Повторите с точным ID.');
      atomicFile(cfg.configPath,editConfig(cfg.text,{TELEGRAM_BOT_TOKEN:token,TELEGRAM_BOT_ID:id,DEMO_DATA_DIR:cfg.dataDir,DEMO_PORT:cfg.port}));
      store.save({...state,telegram:next});
    }finally{store.close();}
  }else{
    if(existsSync(cfg.dataDir))throw new LocalError('STORAGE_MISSING','Каталог данных существует без state.sqlite. Восстановите историю; setup не создаёт замену.');
    if(options.switchBotId&&options.switchBotId!==id||options.adoptBotId&&options.adoptBotId!==id)throw new LocalError('BOT_CONFIRMATION','Подтверждённый ID не совпадает с getMe.');
    atomicFile(cfg.configPath,editConfig(cfg.text,{TELEGRAM_BOT_TOKEN:token,TELEGRAM_BOT_ID:id,DEMO_DATA_DIR:cfg.dataDir,DEMO_PORT:cfg.port}));
  }
  let webhook='не проверено';try{const w=await transport.call('getWebhookInfo',{});webhook=w.url?'активен: удалите webhook штатным способом перед long polling; автоматического удаления нет':'отсутствует';}catch{}
  output(`Конфигурация сохранена с правами 600. Webhook: ${webhook}.\nЗапуск: npm start. Остановка: Ctrl+C. Затем получите код привязки в локальной панели и отправьте его своему боту. Существующая привязка того же бота сохраняется.`);
  return {configPath:cfg.configPath,dbPath:cfg.dbPath,botId:id,webhook};
}
export async function doctor(options={}) {
  const checks=[],add=(name,state,detail)=>checks.push({name,state,detail});
  if(!compatible(options.nodeVersion)){add('Node.js','ошибка','Нужен Node.js 24.19.0 или совместимый более новый. Активируйте Node 24.19.0 и повторите.');return checks;}
  add('Node.js','исправно',options.nodeVersion??process.versions.node);
  let cfg;try{cfg=settings(options);}catch{add('Конфигурация','ошибка','Проверьте путь/синтаксис .env и права; затем npm run setup.');return checks;}
  if(!existsSync(cfg.configPath))add('Конфигурация','не настроено',`${cfg.configPath}; создайте через npm run setup.`);
  else add('Конфигурация',statSync(cfg.configPath).mode&0o077?'ошибка':'исправно',statSync(cfg.configPath).mode&0o077?`${cfg.configPath}: ограничьте права командой chmod 600 для этого файла.`:cfg.configPath);
  const panel=await (options.panel??panelRequest)(cfg.port);let stored;
  if(panel&&panel.dbPath===cfg.dbPath){stored=panel.storage;add('Панель','исправно',`Работает, порт ${cfg.port}.`);add('Хранилище','исправно',`${cfg.dbPath}; версия ${stored.schemaVersion}, правил ${stored.rules}, позиций ${stored.positions}.`);}
  else{
    add('Панель',panel?'ошибка':'не проверено',panel?'На порту другая база. Используйте тот же DEMO_ENV_FILE/DEMO_PORT.':'Не отвечает; если приложение остановлено, это ожидаемо. Запуск: npm start.');
    if(!existsSync(cfg.dbPath))add('Хранилище',existsSync(cfg.dataDir)?'ошибка':'не настроено',existsSync(cfg.dataDir)?'Каталог существует без файла истории; восстановите копию, не удаляйте каталог.':`${cfg.dbPath}: будет создано при первом запуске.`);
    else{try{const db=await inspectDatabase(cfg.dbPath);try{stored={schemaVersion:db.raw.version,botId:db.state.telegram.botId};add('Хранилище','исправно',`${cfg.dbPath}; поддерживаемая версия ${db.raw.version}. Чтение без миграции.`);}finally{db.close();}}catch(e){add('Хранилище','ошибка',e.message);}}
  }
  if(panel?.dbPath===cfg.dbPath){add('Telegram runtime',!panel.telegram.configured?'не настроено':panel.telegram.connection==='connected'?'исправно':['identity_error','token_error','conflict','storage_error'].includes(panel.telegram.connection)?'ошибка':'не проверено',`${panel.telegram.connection}${panel.telegram.lastError?' · '+panel.telegram.lastError:''}; при ошибке выполните setup/doctor и остановите второй экземпляр.`);add('Рынок',panel.market.snapshotUsable?'исправно':panel.market.status==='idle'?'не настроено':'не проверено',`${panel.market.status}${panel.market.error?' · '+panel.market.error:''}. Используется известное состояние, новый опрос не запущен.`);}
  else add('Рынок','не проверено','Приложение не ответило; doctor не опрашивает рынок.');
  if(!cfg.token){add('Telegram API','не настроено','Добавьте токен скрытым вводом через npm run setup.');add('Webhook','не проверено','Без токена не проверяется.');return checks;}
  const transport=options.transport??new TelegramTransport(cfg.token);
  let id;
  try{id=botIdentity(await transport.call('getMe',{}));add('Telegram API','исправно',`getMe: бот ID ${id}; доставка сообщений и полный цикл этим не подтверждены.`);}
  catch(e){add('Telegram API','ошибка',apiError(e).message);add('Webhook','не проверено','API-проверка не завершена.');return checks;}
  const expected=stored?stored.botId:cfg.botId, matches=expected===id&&(!cfg.botId||cfg.botId===id);
  add('Идентичность бота',matches?'исправно':'ошибка',matches?`ID ${id} совпадает.`:stored&&!stored.botId?'Старый ID не зафиксирован; подтвердите прежнего бота в npm run setup.':'ID не совпадает или не сохранён: выполните npm run setup; смена требует явного подтверждения.');
  try{const w=await transport.call('getWebhookInfo',{});add('Webhook',w.url?'ошибка':'исправно',w.url?'Активен webhook: удалите его штатным способом перед long polling. Doctor его не снимает.':'Отсутствует.');}
  catch(e){add('Webhook','ошибка',apiError(e).message);}

  return checks;
}

export async function backupLocal(destination, options={}) {
  const cfg=settings(options), target=resolve(destination??join(homedir(),'pumpfun-backups',`backup-${Date.now()}`));
  if(existsSync(target))throw new LocalError('TARGET_EXISTS','Каталог копии уже существует. Выберите новый путь.');
  let guard;if(existsSync(cfg.dbPath))guard=await inspectDatabase(cfg.dbPath,{exclusive:true});
  else if(existsSync(cfg.dataDir))throw new LocalError('STORAGE_MISSING','Каталог без базы не является исправной историей. Восстановите существующую копию.');
  try{
    mkdirSync(target,{recursive:true,mode:0o700});chmodSync(target,0o700);
    const manifest={version:1,createdAt:new Date().toISOString(),source:{dbPath:cfg.dbPath,configPath:cfg.configPath},schemaVersion:guard?.raw.version??null,files:{}};
    if(guard){copyFileSync(cfg.dbPath,join(target,'state.sqlite'),constants.COPYFILE_EXCL);chmodSync(join(target,'state.sqlite'),0o600);manifest.files.database={name:'state.sqlite',sha256:fileChecksum(join(target,'state.sqlite'))};}
    if(existsSync(cfg.configPath)){copyFileSync(cfg.configPath,join(target,'configuration.env'),constants.COPYFILE_EXCL);chmodSync(join(target,'configuration.env'),0o600);manifest.files.configuration={name:'configuration.env',sha256:fileChecksum(join(target,'configuration.env'))};
      if(manifest.files.configuration.sha256!==checksum(cfg.text)||fileChecksum(cfg.configPath)!==checksum(cfg.text))throw new LocalError('CONFIG_CHANGED','Конфигурация изменилась во время копирования. Повторите в новый каталог при остановленном приложении.');}
    if(guard){const verify=await inspectDatabase(join(target,'state.sqlite'));verify.close();}
    atomicFile(join(target,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');return {path:target,schemaVersion:manifest.schemaVersion,database:!!guard,configuration:!!manifest.files.configuration};
  }catch(e){throw e instanceof LocalError?e:new LocalError('BACKUP_FAILED','Копия не завершена. Не используйте неполный каталог; проверьте права и свободное место.');}
  finally{guard?.close();}
}
export async function restoreLocal(source, destination, options={}) {
  const from=resolve(source),target=resolve(destination??join(homedir(),'pumpfun-restored',`restored-${Date.now()}`));
  let manifest;try{manifest=JSON.parse(readFileSync(join(from,'manifest.json'),'utf8'));}catch{throw new LocalError('BACKUP_INVALID','Нет корректного manifest.json. Восстановление не выполнено.');}
  if(manifest.version!==1||!manifest.files?.database)throw new LocalError('BACKUP_INVALID','Копия не содержит поддерживаемую историю. Восстановление не создаёт пустую базу.');
  for(const [kind,name]of [['database','state.sqlite'],['configuration','configuration.env']]){
    const f=manifest.files[kind];if(f&&(f.name!==name||!existsSync(join(from,name))||fileChecksum(join(from,name))!==f.sha256))throw new LocalError('BACKUP_INVALID','Копия повреждена или файлы не совпадают с manifest. История не изменена.');
  }
  const checked=await inspectDatabase(join(from,'state.sqlite'));const sourceVersion=checked.raw.version;checked.close();
  if(sourceVersion!==manifest.schemaVersion)throw new LocalError('BACKUP_INVALID','Версия manifest не совпадает с базой. Копия не восстанавливается.');
  if(options.overwriteDbPath){
    const cfg=settings(options), exact=resolve(options.overwriteDbPath);
    if(exact!==cfg.dbPath||options.confirmPath!==exact)throw new LocalError('CONFIRM_PATH','Для перезаписи укажите --overwrite-db и --confirm-path с точным абсолютным путём действующей базы из doctor.');
    if(!existsSync(exact))throw new LocalError('STORAGE_MISSING','Действующая база отсутствует; используйте восстановление в новый каталог.');
    const before=await backupLocal(options.previousBackupDestination,options);
    const { SnapshotStore }=await import('../snapshot-store.mjs');let store;
    try{store=new SnapshotStore(exact);}catch{throw new LocalError('STORAGE_BUSY','База занята. Остановите приложение; перезапись не выполняется.');}
    try{
      const raw=await inspectDatabase(join(from,'state.sqlite'));
      try{
        const text=manifest.files.configuration?readFileSync(join(from,'configuration.env'),'utf8'):'';
        atomicFile(cfg.configPath,editConfig(text,{DEMO_DATA_DIR:cfg.dataDir}));
        store.save(raw.raw);
      }finally{raw.close();}
      return {path:cfg.dataDir,configPath:cfg.configPath,dbPath:exact,schemaVersion:manifest.schemaVersion,previousBackup:before.path};
    }finally{store.close();}
  }
  // Restore has an explicit overwrite mode, but only into an existing installation directory, never a parent/root.
  const overwrite=existsSync(target);
  if(overwrite&&options.confirmPath!==target)throw new LocalError('CONFIRM_PATH',`Каталог существует. Для перезаписи требуется --confirm-path с точным путём ${target}. По умолчанию используйте новый каталог.`);
  if(target===from||relative(target,from)===''||!relative(target,from).startsWith('..')&&!isAbsolute(relative(target,from)))throw new LocalError('TARGET_INVALID','Каталог восстановления не должен содержать исходную копию.');
  let guard;
  if(overwrite){
    let marker;try{marker=JSON.parse(readFileSync(join(target,'.local-restore.json'),'utf8'));}catch{}
    if(marker?.version!==1||marker.target!==target||!existsSync(join(target,'data','state.sqlite')))throw new LocalError('TARGET_INVALID','Перезапись допускается только для каталога прежнего восстановления с data/state.sqlite. Для рабочей установки используйте новый каталог и DEMO_ENV_FILE.');
    guard=await inspectDatabase(join(target,'data','state.sqlite'),{exclusive:true});
  }
  let stage;
  try{
    mkdirSync(dirname(target),{recursive:true,mode:0o700});stage=mkdtempSync(join(dirname(target),'.restore-'));chmodSync(stage,0o700);mkdirSync(join(stage,'data'),{mode:0o700});
    copyFileSync(join(from,'state.sqlite'),join(stage,'data','state.sqlite'));chmodSync(join(stage,'data','state.sqlite'),0o600);
    const text=manifest.files.configuration?readFileSync(join(from,'configuration.env'),'utf8'):'';
    atomicFile(join(stage,'.env'),editConfig(text,{DEMO_DATA_DIR:join(target,'data')}));
    const check=await inspectDatabase(join(stage,'data','state.sqlite'));check.close();
    atomicFile(join(stage,'.local-restore.json'),JSON.stringify({version:1,target})+'\n');
    if(overwrite){
      // Keep the old directory as a recoverable sibling. Its database lock remains held until replacement completes.
      const previous=`${target}.before-restore-${Date.now()}`;renameSync(target,previous);
      try{renameSync(stage,target);}catch(e){renameSync(previous,target);throw e;}
    }else renameSync(stage,target);
    stage=undefined;return {path:target,configPath:join(target,'.env'),dbPath:join(target,'data','state.sqlite'),schemaVersion:manifest.schemaVersion};
  }finally{guard?.close();if(stage)rmSync(stage,{recursive:true,force:true});}
}
