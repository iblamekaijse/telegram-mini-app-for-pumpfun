import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { setupLocal, doctor, backupLocal, restoreLocal } from './ops/local.mjs';
import { settings, editConfig, atomicFile } from './ops/config.mjs';
import { secretPrompt } from './ops/prompt.mjs';
import { fileChecksum, checksum, inspectDatabase } from './ops/storage.mjs';
import { createPanelService } from './web/panel-service.mjs';
import { startPanel } from './web/server.mjs';
import { runTelegram } from './web/telegram.mjs';
const TOKEN='777000:TEST_SECRET_NEVER_PRINT_abcdefghijklmnopqrstuvwxyz';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/dexscreener-pumpswap.json',import.meta.url)));
const mint=fixture[0].baseToken.address;
const msg=(update_id,text)=>({update_id,message:{text,from:{id:42},chat:{id:42,type:'private'}}});
const fake=(id=777000,webhook='')=>({calls:[],async call(method){this.calls.push(method);if(method==='getMe')return{id,is_bot:true,username:'test_bot'};if(method==='getWebhookInfo')return{url:webhook};throw new Error('Unexpected test method');}});
function area(t){
 const root=mkdtempSync(join(tmpdir(),'local-ops-')),data=join(root,'data');t.after(()=>rmSync(root,{recursive:true,force:true}));
 const output=[];return{root,data,output,options:{cwd:root,env:{DEMO_DATA_DIR:data},output:s=>output.push(s),confirm:async()=>'',transport:fake()}};
}
async function seeded(t,a,{bind=true,position=false}={}){
 let now=100000,priceUsd='120';
 const opts={dataDir:a.data,telegramConfigured:true,clock:()=>now,marketFetch:async()=>new Response(JSON.stringify([{...fixture[0],priceUsd}]))};
 const s=await createPanelService(opts);let closed=false;t.after(()=>{if(!closed)s.close();});
 if(bind){s.telegram.acceptBot('777000');s.telegram.handle(msg(1,'/start '+s.telegram.createCode().code));}
 if(position){await s.selectMarket({mint});const id=s.create({requestId:'ops-position-rule',mode:'market-paper',scenario:'virtual-position',mint,threshold:'100',amount:'1000',expiresInMinutes:10,takeProfit:'10',stopLoss:'10'}).currentRuleId;s.command(id,'enable',{requestId:'ops-position-enable'});now+=10000;priceUsd='100';await s.pollMarket();}
 return{s,opts,close(){s.close();closed=true;}};
}

test('setup creates private configuration, validates getMe, resolves paths, and repeated setup preserves unrelated settings',async t=>{
 const a=area(t);let prompted=0;const opts={...a.options,prompt:async()=>{prompted++;return TOKEN;}};
 const first=await setupLocal(opts);assert.equal(prompted,1);assert.equal(first.dbPath,join(a.data,'state.sqlite'));assert.equal(statSync(first.configPath).mode&0o777,0o600);assert.equal(existsSync(a.data),false);
 const cfg=settings(a.options);assert.equal(cfg.token,TOKEN);assert.equal(cfg.botId,'777000');
 atomicFile(cfg.configPath,cfg.text+'OTHER_SETTING="keep this"\n');await setupLocal({...opts,prompt:async()=>{throw new Error('Unexpected prompt');}});
 assert.equal(settings(a.options).file.OTHER_SETTING,'keep this');assert.ok(!a.output.join('\n').includes(TOKEN));assert.deepEqual(a.options.transport.calls,['getMe','getWebhookInfo','getMe','getWebhookInfo']);
});
test('hidden terminal input turns off echo, supports correction, restores raw mode and never writes secret text',async()=>{
 class Input extends EventEmitter{isTTY=true;isRaw=false;setRawMode(value){this.isRaw=value;}resume(){queueMicrotask(()=>this.emit('data',Buffer.from('abcX\u007fdef\r')));}pause(){}}
 const input=new Input(),output=[];const value=await secretPrompt('Token: ',{input,output:{write:s=>{if(s==='Token: ')assert.equal(input.isRaw,true);output.push(s);}}});
 assert.equal(value,'abcdef');assert.equal(input.isRaw,false);assert.equal(output.join(''),'Token: \n');
 const cancelled=new Input();cancelled.resume=function(){queueMicrotask(()=>this.emit('data',Buffer.from('\u0003')));};
 await assert.rejects(secretPrompt('Token: ',{input:cancelled,output:{write(){}}}),{code:'CANCELLED'});assert.equal(cancelled.isRaw,false);
});
test('setup fails safely on denied API or missing noninteractive token; existing .env is unchanged and errors contain no secret URL',async t=>{
 const a=area(t);atomicFile(join(a.root,'.env'),`TELEGRAM_BOT_TOKEN=${TOKEN}\nKEEP=1\n`);const original=fileChecksum(join(a.root,'.env'));
 await assert.rejects(setupLocal({...a.options,transport:{async call(){throw {status:401,message:'https://api.telegram.org/bot'+TOKEN};}}}),e=>e.code==='TELEGRAM_API'&&!e.message.includes(TOKEN));
 assert.equal(fileChecksum(join(a.root,'.env')),original);assert.ok(!a.output.join('').includes(TOKEN));
 await assert.rejects(secretPrompt('Token: ',{input:{isTTY:false},output:{write(){}}}),{code:'TOKEN_REQUIRED'});
});
test('same-bot token rotation preserves owner, offset, callbacks, dialog, queue and trading positions',async t=>{
 const a=area(t),c=await seeded(t,a,{position:true});c.s.telegram.handle(msg(2,'/new'));const before=c.s.telegram.load(),history=c.s.state().positions;c.close();
 await setupLocal({...a.options,env:{DEMO_DATA_DIR:a.data,TELEGRAM_BOT_TOKEN:TOKEN},replaceToken:true,prompt:async()=>TOKEN+'rotated'});
 const reopened=await createPanelService(c.opts);assert.deepEqual(reopened.telegram.load(),before);assert.deepEqual(reopened.state().positions[0].entry,history[0].entry);reopened.close();
});
test('different bot requires exact explicit local confirmation, clears only Telegram data and preserves trade history',async t=>{
 const a=area(t),c=await seeded(t,a,{position:true});const old=c.s.state().positions[0],owner=c.s.telegram.load();c.close();
 const opts={...a.options,env:{DEMO_DATA_DIR:a.data,TELEGRAM_BOT_TOKEN:TOKEN},transport:fake(888000)};
 await assert.rejects(setupLocal(opts),{code:'BOT_IDENTITY_MISMATCH'});assert.equal(existsSync(join(a.root,'.env')),false);
 await setupLocal({...opts,switchBotId:'888000'});const reopened=await createPanelService(c.opts);const tg=reopened.telegram.load();
 assert.equal(tg.botId,'888000');assert.equal(tg.owner,null);assert.equal(tg.offset,0);assert.deepEqual(tg.outbox,[]);assert.deepEqual(tg.callbacks,[]);assert.ok(tg.generation>owner.generation);
 assert.deepEqual(reopened.state().positions[0].entry,old.entry);assert.equal(reopened.state().rules.length,1);reopened.close();
});
test('legacy v6 identity is not inferred; explicit adoption preserves prior Telegram records',async t=>{
 const a=area(t),c=await seeded(t,a,{position:true});const before=c.s.telegram.load();c.close();
 const db=new DatabaseSync(join(a.data,'state.sqlite'));const raw=JSON.parse(db.prepare('SELECT payload FROM snapshot').get().payload);raw.version=6;raw.telegram.version=2;delete raw.telegram.botId;
 const payload=JSON.stringify(raw);db.prepare('UPDATE snapshot SET payload=?,sha256=?').run(payload,checksum(payload));db.close();
 const opts={...a.options,env:{DEMO_DATA_DIR:a.data,TELEGRAM_BOT_TOKEN:TOKEN}};
 await assert.rejects(setupLocal(opts),{code:'BOT_IDENTITY_REQUIRED'});
 await setupLocal({...opts,adoptBotId:'777000'});const re=await createPanelService(c.opts);assert.deepEqual(re.telegram.load(),before);assert.equal(re.state().positions[0].status,'open');re.close();
});
test('runtime blocks mismatch and legacy pending updates before polling, sending or running source jobs',async t=>{
 const a=area(t),c=await seeded(t,a);const snapshot=c.s.telegram.load();snapshot.pending=msg(2,'/new');c.s.telegram.save(snapshot);
 let tail=Promise.resolve();const serial=fn=>{const p=tail.then(fn);tail=p.catch(()=>{});return p;};const transport=fake(888000);
 const runner=runTelegram({controller:c.s.telegram,transport,serial});await new Promise(r=>setTimeout(r,40));
 assert.equal(c.s.telegram.status().connection,'identity_error');assert.equal(c.s.telegram.status().lastError,'BOT_IDENTITY_MISMATCH');assert.deepEqual(transport.calls,['getMe','getWebhookInfo']);
 assert.deepEqual(c.s.telegram.load(),snapshot);await runner.close();
 const legacy={...snapshot,botId:null};c.s.telegram.save(legacy);const legacyTransport=fake();const legacyRunner=runTelegram({controller:c.s.telegram,transport:legacyTransport,serial});await new Promise(r=>setTimeout(r,40));assert.equal(c.s.telegram.status().lastError,'BOT_IDENTITY_REQUIRED');assert.deepEqual(legacyTransport.calls,['getMe','getWebhookInfo']);assert.deepEqual(c.s.telegram.load(),legacy);await legacyRunner.close();
});
test('doctor reports webhook without deleting it, consumes no updates, sends nothing and changes no files',async t=>{
 const a=area(t),c=await seeded(t,a,{position:true});c.close();await setupLocal({...a.options,env:{DEMO_DATA_DIR:a.data,TELEGRAM_BOT_TOKEN:TOKEN}});
 const dbPath=join(a.data,'state.sqlite'),envPath=join(a.root,'.env'),before=[fileChecksum(dbPath),fileChecksum(envPath)],files=readdirSync(a.data);
 const transport=fake(777000,'https://example.invalid/SECRET');const report=await doctor({...a.options,transport,panel:async()=>null});
 assert.equal(report.find(e=>e.name==='Webhook').state,'ошибка');assert.ok(!JSON.stringify(report).includes('SECRET'));assert.ok(!JSON.stringify(report).includes(TOKEN));
 assert.deepEqual(transport.calls,['getMe','getWebhookInfo']);assert.deepEqual([fileChecksum(dbPath),fileChecksum(envPath)],before);assert.deepEqual(readdirSync(a.data),files);
 const denied=await doctor({...a.options,panel:async()=>null,transport:{async call(method){if(method==='getMe')return{id:777000,is_bot:true};throw{status:403,message:TOKEN};}}});assert.equal(denied.find(c=>c.name==='Webhook').state,'ошибка');assert.ok(!JSON.stringify(denied).includes(TOKEN));
});
test('doctor reads legacy version without migration, and missing storage/config have separate not-configured outcomes',async t=>{
 const a=area(t);const absent=await doctor({...a.options,panel:async()=>null});assert.equal(absent.find(e=>e.name==='Конфигурация').state,'не настроено');assert.equal(existsSync(a.data),false);
 const c=await seeded(t,a,{bind:false});c.close();const db=new DatabaseSync(join(a.data,'state.sqlite'));const raw=JSON.parse(db.prepare('SELECT payload FROM snapshot').get().payload);raw.version=6;raw.telegram.version=2;delete raw.telegram.botId;const payload=JSON.stringify(raw);db.prepare('UPDATE snapshot SET payload=?,sha256=?').run(payload,checksum(payload));db.close();
 const before=fileChecksum(join(a.data,'state.sqlite'));const report=await doctor({...a.options,panel:async()=>null});assert.match(report.find(e=>e.name==='Хранилище').detail,/версия 6/);assert.equal(fileChecksum(join(a.data,'state.sqlite')),before);
 const unsupported=await doctor({...a.options,nodeVersion:'22.0.0'});assert.equal(unsupported[0].state,'ошибка');
});
test('running doctor uses the live read-only diagnostic endpoint, adds no market request and never opens another engine',async t=>{
 const a=area(t);let markets=0;const app=await startPanel({dataDir:a.data,port:0,telegramToken:'',marketFetch:async()=>{markets++;throw new Error('Unexpected');}});
 try{
  const port=new URL(app.url).port;const report=await doctor({...a.options,env:{DEMO_DATA_DIR:a.data,DEMO_PORT:port},transport:fake()});
  assert.equal(report.find(e=>e.name==='Панель').state,'исправно');assert.equal(report.find(e=>e.name==='Хранилище').state,'исправно');assert.equal(markets,0);
  const api=await(await fetch(app.url+'/api/diagnostics')).json();assert.equal(api.storage.schemaVersion,7);assert.equal(api.telegram.ownerLinked,undefined);
 }finally{await app.close();}
});
test('backup requires a stopped app, keeps SQLite/config private and restores into a new independent directory',async t=>{
 const a=area(t),c=await seeded(t,a,{position:true});atomicFile(join(a.root,'.env'),`TELEGRAM_BOT_TOKEN=${TOKEN}\nDEMO_DATA_DIR=${a.data}\n`);
 await assert.rejects(backupLocal(join(a.root,'busy-copy'),a.options),{code:'STORAGE_BUSY'});assert.equal(existsSync(join(a.root,'busy-copy')),false);
 const tg=c.s.telegram.load(),p=c.s.state().positions[0];c.close();const copy=await backupLocal(join(a.root,'copy'),a.options);
 assert.equal(statSync(join(copy.path,'configuration.env')).mode&0o777,0o600);assert.equal(statSync(copy.path).mode&0o777,0o700);
 const restored=await restoreLocal(copy.path,join(a.root,'restored'),a.options);const cfg=settings({cwd:a.root,env:{DEMO_ENV_FILE:restored.configPath}});
 assert.equal(cfg.dbPath,restored.dbPath);assert.equal(cfg.token,TOKEN);assert.notEqual(cfg.dbPath,join(a.data,'state.sqlite'));
 const re=await createPanelService({dataDir:dirnameForDb(restored.dbPath),clock:()=>120001,telegramConfigured:true});assert.deepEqual(re.telegram.load(),tg);assert.deepEqual(re.state().positions[0].entry,p.entry);re.close();
});
function dirnameForDb(path){return resolve(path,'..');}
test('corrupt/future-version copy and absent restore history never turn into empty state; existing targets need exact confirmation',async t=>{
 const a=area(t),c=await seeded(t,a);c.close();const copy=await backupLocal(join(a.root,'copy'),a.options),target=join(a.root,'restored');
 await restoreLocal(copy.path,target,a.options);const original=fileChecksum(join(target,'data','state.sqlite'));
 await assert.rejects(restoreLocal(copy.path,target,a.options),{code:'CONFIRM_PATH'});assert.equal(fileChecksum(join(target,'data','state.sqlite')),original);
 await restoreLocal(copy.path,target,{...a.options,confirmPath:target});assert.equal(fileChecksum(join(target,'data','state.sqlite')),original);assert.ok(readdirSync(a.root).some(name=>name.startsWith('restored.before-restore-')));
 writeFileSync(join(copy.path,'state.sqlite'),'broken');await assert.rejects(restoreLocal(copy.path,join(a.root,'bad'),a.options),{code:'BACKUP_INVALID'});assert.equal(existsSync(join(a.root,'bad')),false);
 const fresh=await backupLocal(join(a.root,'future'),a.options),db=new DatabaseSync(join(fresh.path,'state.sqlite'));const row=JSON.parse(db.prepare('SELECT payload FROM snapshot').get().payload);row.version=999;const payload=JSON.stringify(row);db.prepare('UPDATE snapshot SET payload=?,sha256=?').run(payload,checksum(payload));db.close();
 const manifest=JSON.parse(readFileSync(join(fresh.path,'manifest.json')));manifest.files.database.sha256=fileChecksum(join(fresh.path,'state.sqlite'));manifest.schemaVersion=999;writeFileSync(join(fresh.path,'manifest.json'),JSON.stringify(manifest));
 await assert.rejects(restoreLocal(fresh.path,join(a.root,'future-restored'),a.options),{code:'STORAGE_INVALID'});
});
test('explicit overwrite requires the exact live database path and preserves a recoverable pre-restore copy',async t=>{
 const a=area(t),c=await seeded(t,a);c.close();const copy=await backupLocal(join(a.root,'copy'),a.options);
 await assert.rejects(restoreLocal(copy.path,undefined,{...a.options,overwriteDbPath:join(a.data,'state.sqlite')}),{code:'CONFIRM_PATH'});
 const restored=await restoreLocal(copy.path,undefined,{...a.options,overwriteDbPath:join(a.data,'state.sqlite'),confirmPath:join(a.data,'state.sqlite'),previousBackupDestination:join(a.root,'before')});
 assert.equal(restored.dbPath,join(a.data,'state.sqlite'));assert.ok(existsSync(join(restored.previousBackup,'manifest.json')));
});
test('configured webhook prevents runtime polling or message delivery without clearing webhook',async t=>{
 const a=area(t),c=await seeded(t,a);let tail=Promise.resolve();const serial=fn=>{const p=tail.then(fn);tail=p.catch(()=>{});return p;};const transport=fake(777000,'https://example.invalid/webhook');
 const runner=runTelegram({controller:c.s.telegram,serial,transport});await new Promise(r=>setTimeout(r,40));assert.equal(c.s.telegram.status().lastError,'TELEGRAM_WEBHOOK');assert.deepEqual(transport.calls,['getMe','getWebhookInfo']);await runner.close();
});

test('doctor distinguishes a verified API from unknown legacy bot identity and from unverified runtime startup',async t=>{
 const a=area(t),c=await seeded(t,a);const tg=c.s.telegram.load();tg.botId=null;c.s.telegram.save(tg);c.close();
 atomicFile(join(a.root,'.env'),`TELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_BOT_ID=777000\n`);
 const report=await doctor({...a.options,transport:fake(),panel:async()=>null});assert.equal(report.find(c=>c.name==='Telegram API').state,'исправно');assert.equal(report.find(c=>c.name==='Идентичность бота').state,'ошибка');
 const live=await doctor({...a.options,transport:fake(),panel:async()=>({dbPath:join(a.data,'state.sqlite'),storage:{schemaVersion:7,botId:'777000',rules:0,positions:0},telegram:{configured:true,connection:'connecting'},market:{status:'idle',snapshotUsable:false}})});
 assert.equal(live.find(c=>c.name==='Telegram runtime').state,'не проверено');
});
test('setup cannot modify configuration while the history is locked by a running app',async t=>{
 const a=area(t),c=await seeded(t,a);atomicFile(join(a.root,'.env'),`TELEGRAM_BOT_TOKEN=${TOKEN}\n`);const before=fileChecksum(join(a.root,'.env'));
 await assert.rejects(setupLocal(a.options),{code:'STORAGE_BUSY_OR_INVALID'});assert.equal(fileChecksum(join(a.root,'.env')),before);assert.equal(c.s.telegram.load().botId,'777000');
});
test('setup -> live local panel/Telegram virtual cycle -> stopped copy -> restored startup keeps history and access',async t=>{
 const a=area(t);const setupTransport=fake();await setupLocal({...a.options,prompt:async()=>TOKEN,transport:setupTransport});
 const cfg=settings(a.options);let now=100000,priceUsd='120',update=0;const inbox=[],sent=[];
 const transport={async call(method,body,signal){
  if(method==='getMe')return{id:777000,is_bot:true,username:'test_bot'};
  if(method==='getWebhookInfo')return{url:''};
  if(method==='getUpdates')return inbox.filter(e=>e.update_id>=body.offset);
  if(method==='sendMessage'||method==='answerCallbackQuery'){sent.push({method,body});return{};}
  throw new Error('Unexpected fake API call');
 }};
 const boot=async(config)=>startPanel({dataDir:config.dataDir,port:0,telegramToken:TOKEN,expectedBotId:config.botId,telegramTransport:transport,clock:()=>now,marketFetch:async()=>new Response(JSON.stringify([{...fixture[0],priceUsd}]))});
 let app=await boot(cfg);
 const api=async(path,body)=>{const res=await fetch(app.url+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});assert.equal(res.status,200);return res.json();};
 const until=async(fn)=>{const end=Date.now()+12000;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,30));}throw new Error('Local E2E readiness timeout');};
 try{
  await until(async()=> (await api('/api/state')).telegram.identityVerified);
  const issued=await api('/api/telegram/code',{});inbox.push(msg(++update,'/start '+issued.telegramLink.code));await until(async()=> (await api('/api/state')).telegram.linked);
  await api('/api/market/select',{mint});const created=await api('/api/rules',{requestId:'local-ops-e2e-rule',mode:'market-paper',scenario:'virtual-position',mint,threshold:'100',amount:'1000',expiresInMinutes:10,takeProfit:'10',stopLoss:'10'});
  await api(`/api/rules/${created.currentRuleId}/enable`,{requestId:'local-e2e-enable'});now+=10000;priceUsd='100';await until(async()=> (await api('/api/state')).positions[0]?.status==='open');
  const opening=await until(()=>sent.find(e=>e.method==='sendMessage'&&e.body.text.includes('Виртуальная позиция открыта')));const close=opening.body.reply_markup.inline_keyboard.flat().find(b=>b.text==='Запросить закрытие позиции');
  inbox.push({update_id:++update,callback_query:{id:'12345',data:close.callback_data,from:{id:42},message:{chat:{id:42,type:'private'}}}});
  await until(async()=> (await api('/api/state')).positions[0]?.status==='close_requested');now+=10000;priceUsd='107';await until(async()=> (await api('/api/state')).positions[0]?.status==='closed');
  await until(async()=> (await api('/api/state')).telegram.queued===0);
  const before=await api('/api/state');assert.equal(before.positions[0].display.pnlUsd,'70');await app.close();app=null;
  const copy=await backupLocal(join(a.root,'e2e-copy'),a.options),restored=await restoreLocal(copy.path,join(a.root,'e2e-restored'),a.options);
  const restoredCfg=settings({cwd:a.root,env:{DEMO_ENV_FILE:restored.configPath}}),reads=fake();const check=await doctor({cwd:a.root,env:{DEMO_ENV_FILE:restored.configPath},transport:reads,panel:async()=>null});assert.ok(!check.some(c=>c.state==='ошибка'));assert.deepEqual(reads.calls,['getMe','getWebhookInfo']);
  const sentBefore=sent.length;now++;app=await boot(restoredCfg);const after=await api('/api/state');assert.equal(after.telegram.linked,true);assert.equal(after.telegram.botId,'777000');assert.deepEqual(after.positions[0].exit,before.positions[0].exit);assert.equal(after.rules[0].operations.length,1);
  await new Promise(r=>setTimeout(r,400));assert.equal(sent.length,sentBefore);
  inbox.push(msg(++update,'/status'));await until(()=>sent.length>sentBefore);assert.ok(sent.some(e=>e.body.text?.includes('Зафиксированный результат: 70 USD')));
 }finally{if(app)await app.close();}
});
