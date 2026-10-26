import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createPanelService } from './web/panel-service.mjs';
import { startPanel } from './web/server.mjs';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/dexscreener-pumpswap.json', import.meta.url)));
const mint = fixture[0].baseToken.address;
async function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'telegram-dialog-')), dataDir = join(root,'data');
  let now = 100000, priceUsd = '120', fail = false, calls = 0, id = 0, s;
  const options = { dataDir, telegramConfigured: true, clock: () => now, marketFetch: async url => {
    calls++; if (fail) throw new Error('TEST outage'); const requestedMint = url.split('/').at(-1);
    return new Response(JSON.stringify([{ ...fixture[0], priceUsd, baseToken: { ...fixture[0].baseToken, address: requestedMint },
      ...(requestedMint !== mint ? { pairAddress: mint } : {}) }]));
  } };
  s = await createPanelService(options);
  t.after(() => { s.close(); rmSync(root,{recursive:true,force:true}); });
  const message = (text,user=42) => s.telegram.handle({ update_id: ++id, message: { text, from:{id:user},chat:{id:user,type:'private'} } });
  const click = (callback,user=42) => { const u={ update_id: ++id, callback_query: { id:`dialog-${id}`,data:callback,from:{id:user},message:{chat:{id:user,type:'private'}} } }; s.telegram.handle(u); return u; };
  message('/start '+s.telegram.createCode().code);
  return { get s(){return s;}, get bot(){return s.telegram;}, get calls(){return calls;}, dataDir, options, message, click,
    callback(action) { return s.telegram.load().callbacks.filter(c=>c.action===action).at(-1).id; },
    text(){return s.telegram.load().outbox.filter(e=>e.method==='sendMessage'&&!e.id.includes(':market:')).at(-1).body.text;},
    async source(){const job=s.telegram.dialog.beginSource(); if(job) await s.telegram.dialog.finishSource(job,await job.work.promise);},
    async poll(price){now+=10000; priceUsd=price;return s.pollMarket();}, advance(ms){now+=ms;}, fail(v){fail=v;},
    async reopen(){s.close();now++;s=await createPanelService(options);},
    async review(selectedMint=mint){message('/new');message(selectedMint);await this.source();click(this.callback('next'));for(const v of ['100','1000','10','10','10'])message(v);},
  };
}

test('all-Telegram flow: menu -> fields -> confirmation -> separate enable -> entry -> close -> history and restart', async t => {
  const c=await setup(t);c.message('/start');assert.match(c.text(),/Меню/);
  await c.review(); assert.equal(c.bot.load().dialog.step,'review'); assert.equal(c.s.state().rules.length,0);
  assert.match(c.text(),/цена ≤ 100/); const confirm=c.callback('confirm');c.click(confirm);c.click(confirm);
  const s=c.s.state();assert.equal(s.rules.length,1);assert.equal(s.rules[0].state,'draft');assert.equal(c.bot.load().dialog,null);
  c.click(c.callback('enable'));await c.poll('100');assert.equal(c.s.state().positions[0].status,'open');
  c.click(c.callback('close'));assert.equal(c.s.state().positions[0].status,'close_requested');await c.poll('107');
  c.message('История');c.click(c.callback('detail'));assert.match(c.text(),/Зафиксированный результат: 70 USD/);
  assert.match(c.text(),/Основание входа/);assert.match(c.text(),/Основание выхода: запрос владельца/);
  await c.reopen();c.message('/status');assert.match(c.text(),/Зафиксированный результат: 70 USD/);
  assert.equal(c.s.state().rules[0].operations.length,1);
});
test('validation, comma normalization, no rounding, back, menu and notifications preserve the draft',async t=>{
  const c=await setup(t);c.message('/new');c.click(c.callback('back'));assert.match(c.text(),/Черновик сохранён/);c.click(c.callback('continue'));c.message('bad mint');assert.equal(c.bot.load().dialog.step,'mint');assert.match(c.text(),/Ошибка/);
  c.message(mint);await c.source();c.click(c.callback('next'));
  for(const invalid of ['0','1.1234567891','1e-6','1,2,3']){c.message(invalid);assert.equal(c.bot.load().dialog.step,'threshold');}
  c.message('100,5');c.message('1.001');assert.equal(c.bot.load().dialog.step,'amount');
  c.message('1000,25');c.message('1.1');assert.equal(c.bot.load().dialog.step,'expiresInMinutes');
  c.message('/status');assert.equal(c.bot.load().dialog.step,'expiresInMinutes');
  const before=c.bot.load().dialog;c.bot.reconcile();assert.deepEqual(c.bot.load().dialog,before);
  c.message('10');c.message('10000.01');assert.equal(c.bot.load().dialog.step,'takeProfit');
  c.message('10');c.message('100');assert.equal(c.bot.load().dialog.step,'stopLoss');c.message('10');
  const old=c.callback('confirm');c.click(c.callback('back'));assert.equal(c.bot.load().dialog.step,'stopLoss');
  c.message('12');c.click(old);assert.equal(c.s.state().rules.length,0);assert.match(c.text(),/устарела/);
  assert.equal(c.bot.load().dialog.values.threshold,'100.5');assert.equal(c.bot.load().dialog.values.amount,'1000.25');
  c.click(c.callback('confirm'));assert.equal(c.s.state().rules[0].config.condition.thresholdUnits,100500000000);
});
test('cancel, TTL, owner unlink and old navigation do not mutate trade objects',async t=>{
  const c=await setup(t);await c.review();const stale=c.callback('confirm');c.message('/cancel');c.click(stale);assert.equal(c.s.state().rules.length,0);
  c.message('/new');c.advance(1800000);c.bot.resume();assert.equal(c.bot.load().dialog,null);assert.match(c.text(),/Срок черновика истёк/);
  c.message('/new');c.message(mint);const old=c.callback('cancel');c.bot.unlink();assert.equal(c.bot.load().dialog,null);
  c.message('/start '+c.bot.createCode().code);c.click(old);assert.equal(c.bot.load().dialog,null);assert.equal(c.s.state().rules.length,0);
});
test('draft/source jobs survive restart; cooldown and unavailable source preserve values',async t=>{
  const c=await setup(t);c.message('/new');c.message(mint);await c.reopen();assert.equal(c.bot.load().dialog.requestSource,true);
  c.fail(true);await c.source();assert.equal(c.bot.load().dialog.step,'source');assert.equal(c.bot.load().dialog.values.mint,mint);
  assert.match(c.text(),/Пригодного снимка пока нет/);assert.equal(c.calls,1);
  c.click(c.callback('reload'));await c.source();assert.equal(c.calls,1);
  c.advance(120000);c.fail(false);c.click(c.callback('reload'));await c.source();c.click(c.callback('next'));c.message('100');await c.reopen();
  assert.equal(c.bot.load().dialog.step,'amount');c.click(c.callback('continue'));assert.match(c.text(),/виртуальную сумму/);
});
test('panel conflict and stale source refuse confirmation but retain parameters',async t=>{
  const c=await setup(t);await c.review();c.advance(46000);c.click(c.callback('confirm'));assert.equal(c.s.state().rules.length,0);assert.match(c.text(),/свежую цену/);
  c.click(c.callback('reload'));await c.source();
  c.s.create({requestId:'panel-conflict-0001',assetId:'DEMO:ASSET-A',threshold:'1',amount:'10',expiresInMinutes:10});
  c.click(c.callback('confirm'));assert.equal(c.s.state().rules.length,1);assert.equal(c.bot.load().dialog.values.amount,'1000');assert.match(c.text(),/Создание не выполнено/);
  c.message('/cancel');assert.equal(c.s.state().rules[0].state,'draft');
});
test('foreign owner, archived confirmations and source changes cannot create another rule',async t=>{
  const c=await setup(t);await c.review();const confirm=c.callback('confirm');c.click(confirm,99);assert.equal(c.s.state().rules.length,0);
  // Selecting another valid mint in the panel invalidates the displayed source, without deleting draft fields.
  await c.s.selectMarket({mint:'So11111111111111111111111111111111111111112'});c.click(confirm);
  assert.match(c.text(),/Конфликт: источник изменился/);assert.equal(c.s.state().rules.length,0);assert.equal(c.bot.load().dialog.values.mint,mint);
});
test('crash after create commit but before final update save replays the same draft identity exactly once',async t=>{
  const c=await setup(t);await c.review();const confirm=c.callback('confirm');const save=c.bot.save.bind(c.bot);
  c.bot.save=tg=>{if(tg.dialog===null&&tg.pending===null)throw new Error('TEST crash');save(tg);};
  assert.throws(()=>c.click(confirm),/TEST crash/);assert.equal(c.s.state().rules.length,1);
  await c.reopen();assert.equal(c.s.state().rules.length,1);assert.equal(c.bot.load().dialog,null);assert.equal(c.bot.load().pending,null);
  c.click(confirm);assert.equal(c.s.state().rules.length,1);
});
test('history pages and unavailable open valuation use saved object identities and explicit non-current wording',async t=>{
  const c=await setup(t);await c.review();c.click(c.callback('confirm'));c.click(c.callback('enable'));await c.poll('100');
  c.fail(true);await c.poll('100');c.message('/history');c.click(c.callback('detail'));assert.match(c.text(),/Текущая оценка недоступна/);assert.doesNotMatch(c.text(),/Зафиксированный результат/);
  // Add archived synthetic rules only after closing the real position.
  c.fail(false);c.advance(120000);c.s.closePosition(c.s.state().positions[0].id,{requestId:'history-close-0001'});await c.poll('105');
  for(let i=0;i<5;i++){const id=c.s.create({requestId:`history-rule-${i}`,assetId:'DEMO:ASSET-A',threshold:'1',amount:'10',expiresInMinutes:10}).currentRuleId;c.s.command(id,'revoke',{requestId:`history-revoke-${i}`});}
  c.message('/history');assert.match(c.text(),/страница 1\/2/);
  const page=c.bot.load().callbacks.filter(e=>e.action==='history'&&e.target==='1').at(-1);c.click(page.id);assert.match(c.text(),/страница 2\/2/);
});
test('v5 snapshot migrates binding, processed updates, queue, rules and positions without changing history',async t=>{
  const c=await setup(t);await c.review();c.click(c.callback('confirm'));c.click(c.callback('enable'));await c.poll('100');c.message('/status');const saved=c.bot.load();
  // Close the engine before writing a faithful previous-version fixture.
  c.s.close();const db=new DatabaseSync(join(c.dataDir,'state.sqlite'));
  const state=JSON.parse(db.prepare('SELECT payload FROM snapshot').get().payload);state.version=5;state.telegram.version=1;delete state.telegram.dialog;delete state.telegram.botId;
  const payload=JSON.stringify(state);db.prepare('UPDATE snapshot SET payload=?,sha256=?').run(payload,createHash('sha256').update(payload).digest('hex'));db.close();
  const reopened=await createPanelService(c.options);assert.deepEqual(reopened.telegram.load(),saved);assert.equal(reopened.state().positions[0].status,'open');assert.equal(reopened.state().rules[0].operations.length,1);reopened.close();
});
test('pending market HTTP request cannot hold the panel mutation queue',async t=>{
  const root=mkdtempSync(join(tmpdir(),'dialog-http-'));let release;
  const app=await startPanel({dataDir:join(root,'data'),port:0,telegramToken:'',marketFetch:()=>new Promise(resolve=>{release=()=>resolve(new Response(JSON.stringify(fixture)));})});
  const post=(path,body)=>fetch(app.url+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  try{
    const selection=post('/api/market/select',{mint});while(!release)await new Promise(r=>setTimeout(r,5));
    const rule=await post('/api/rules',{requestId:'during-network-0001',assetId:'DEMO:ASSET-A',threshold:'1',amount:'10',expiresInMinutes:10});assert.equal(rule.status,200);
    release();assert.equal((await selection).status,200);
  }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});

test('cancelled lookup cannot resurrect a draft, and reloading review invalidates the old confirmation before network completion',async t=>{
  const c=await setup(t);await c.review();const old=c.callback('confirm');c.click(c.callback('reload'));
  c.click(c.callback('confirm'));assert.equal(c.s.state().rules.length,0);assert.match(c.text(),/Дождитесь проверки/);
  await c.source();c.click(old);assert.equal(c.s.state().rules.length,0);
  c.message('/cancel');c.message('/new');c.message(mint);const job=c.bot.dialog.beginSource();c.message('/cancel');
  if(job)await c.bot.dialog.finishSource(job,await job.work.promise);
  assert.equal(c.bot.load().dialog,null);assert.equal(c.s.state().rules.length,0);
});
test('dialog refuses source selection while a panel-owned rule is active without changing its binding',async t=>{
  const c=await setup(t);await c.review();c.click(c.callback('confirm'));const original=c.s.state().rules[0];
  c.click(c.callback('enable'));c.message('/new');c.message(mint);await c.source();
  assert.equal(c.s.state().rules[0].state,'active');assert.deepEqual(c.s.state().rules[0].config.market,original.config.market);
  assert.equal(c.bot.load().dialog.values.mint,mint);assert.match(c.text(),/источник закреплён/);
});

test('a market request begun before enable cannot enter the rule after the network wait',async t=>{
  const root=mkdtempSync(join(tmpdir(),'dialog-inflight-'));let now=100000,release,slow=false;
  const s=await createPanelService({dataDir:join(root,'data'),clock:()=>now,marketFetch:async()=>{
    if(slow)await new Promise(resolve=>{release=resolve;});return new Response(JSON.stringify([{...fixture[0],priceUsd:'100'}]));
  }});
  try{
    await s.selectMarket({mint});const id=s.create({requestId:'before-enable-0001',mode:'market-paper',scenario:'virtual-position',mint,threshold:'100',amount:'1000',expiresInMinutes:10,takeProfit:'10',stopLoss:'10'}).currentRuleId;
    now+=10000;slow=true;const work=s.beginMarketPoll();
    s.command(id,'enable',{requestId:'during-poll-enable'});release();await s.finishMarket(await work.promise);
    assert.equal(s.state().positions.length,0);assert.equal(s.state().rules[0].operations.length,0);
    now+=10000;slow=false;await s.pollMarket();assert.equal(s.state().positions.length,1);
  }finally{s.close();rmSync(root,{recursive:true,force:true});}
});

const alternateMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
async function waitingRule(c, state='active') {
  await c.review();c.click(c.callback('confirm'));const id=c.s.state().currentRuleId;
  if(state!=='draft')c.click(c.callback('enable'));
  if(state==='paused')c.s.command(id,'pause',{requestId:'revoke-setup-pause'});
  c.message('/status');return id;
}
for(const state of ['draft','active','paused'])test(`Telegram revoke ${state}: explicit concrete confirmation preserves history and allows another mint`,async t=>{
  const c=await setup(t),id=await waitingRule(c,state);
  c.click(c.callback('revoke'));assert.equal(c.s.state().rules[0].state,state);
  assert.ok(c.text().includes(id));assert.match(c.text(),/Отзыв окончательный/);assert.match(c.text(),/временной остановки есть пауза/);
  c.click(c.callback('revoke_confirm'));assert.equal(c.s.state().rules[0].state,'revoked');assert.match(c.text(),/Новое виртуальное правило/);
  c.advance(10000);await c.review(alternateMint);c.click(c.callback('confirm'));
  const s=c.s.state();assert.equal(s.rules.length,2);assert.equal(s.rules[0].config.id,id);assert.equal(s.rules[0].config.market.mint,mint);
  assert.equal(s.rules[1].config.market.mint,alternateMint);assert.equal(s.rules[1].state,'draft');assert.equal(s.positions.length,0);
});
test('cancelling a revoke invalidates its confirmation and never cancels the separate conversation draft',async t=>{
  const c=await setup(t);await waitingRule(c);c.message('/new');const draft=c.bot.load().dialog;
  c.message('/status');c.click(c.callback('revoke'));const confirmation=c.callback('revoke_confirm');
  c.click(c.callback('revoke_cancel'));assert.match(c.text(),/Отзыв правила .* отменён/);
  c.click(confirmation);assert.equal(c.s.state().rules[0].state,'active');assert.deepEqual(c.bot.load().dialog,draft);
  assert.match(c.text(),/отменено или устарело/);
  c.message('/status');c.click(c.callback('revoke'));c.click(c.callback('revoke_confirm'));
  assert.equal(c.s.state().rules[0].state,'revoked');assert.deepEqual(c.bot.load().dialog,draft);
});
test('duplicate updates, old request and old confirmation cannot revoke a new rule',async t=>{
  const c=await setup(t);await waitingRule(c);const oldRequest=c.callback('revoke');c.click(oldRequest);
  const oldConfirm=c.callback('revoke_confirm'),u=c.click(oldConfirm);c.bot.handle(u);c.click(oldConfirm);
  assert.equal(c.bot.load().outbox.filter(e=>e.method==='sendMessage'&&/окончательно отозвано/.test(e.body.text)).length,1);
  c.advance(10000);await c.review(alternateMint);c.click(c.callback('confirm'));const second=c.s.state().currentRuleId;
  c.click(oldConfirm);c.click(oldRequest);assert.equal(c.s.state().rules[1].state,'draft');assert.equal(c.s.state().currentRuleId,second);
});
test('entry between revoke request and confirmation refuses revocation and offers independent position closing',async t=>{
  const c=await setup(t);await waitingRule(c);c.click(c.callback('revoke'));const confirm=c.callback('revoke_confirm');
  await c.poll('100');const before=c.s.state().positions[0];c.click(confirm);
  assert.match(c.text(),/Вход уже произошёл/);assert.ok(c.text().includes(before.id));assert.match(c.text(),/отдельное действие «Запросить закрытие позиции»/);
  assert.deepEqual(c.s.state().positions[0],before);assert.equal(c.s.state().rules[0].state,'finished');
  assert.equal(c.bot.load().outbox.filter(e=>e.method==='sendMessage').at(-1).body.reply_markup.inline_keyboard.flat().some(b=>b.text==='Запросить закрытие позиции'),true);
});
test('expiry and panel replacement between request and confirmation cannot affect the replacement rule',async t=>{
  const c=await setup(t);const first=await waitingRule(c);c.click(c.callback('revoke'));const confirmation=c.callback('revoke_confirm');
  c.s.command(first,'revoke',{requestId:'panel-revoke-confirm-race'});
  c.advance(10000);await c.review(alternateMint);c.click(c.callback('confirm'));c.click(confirmation);
  assert.equal(c.s.state().rules[1].state,'draft');assert.equal(c.s.state().rules[0].state,'revoked');
  c.message('/status');c.click(c.callback('revoke'));const expired=c.callback('revoke_confirm');c.advance(300000);c.click(expired);
  assert.match(c.text(),/устарело/);assert.equal(c.s.state().rules[1].state,'draft');
});
test('foreign confirmation and old owner generation have no revoke authority',async t=>{
  const c=await setup(t);await waitingRule(c);c.click(c.callback('revoke'));const confirm=c.callback('revoke_confirm');
  c.click(confirm,99);assert.equal(c.s.state().rules[0].state,'active');
  c.bot.unlink();c.message('/start '+c.bot.createCode().code);c.click(confirm);assert.equal(c.s.state().rules[0].state,'active');
});
test('revoke confirmation survives restart; crash after revoke commit replays without changing a second object',async t=>{
  const c=await setup(t);await waitingRule(c);c.click(c.callback('revoke'));const confirm=c.callback('revoke_confirm');
  await c.reopen();assert.equal(c.s.state().rules[0].state,'active');
  const save=c.bot.save.bind(c.bot);c.bot.save=value=>{if(value.pending===null)throw new Error('TEST revoke crash');save(value);};
  assert.throws(()=>c.click(confirm),/TEST revoke crash/);assert.equal(c.s.state().rules[0].state,'revoked');
  await c.reopen();assert.equal(c.bot.load().pending,null);assert.equal(c.s.state().rules.length,1);assert.equal(c.s.state().rules[0].state,'revoked');
  c.click(confirm);assert.equal(c.s.state().rules[0].state,'revoked');
});
test('unknown arising after a revoke request remains unknown and cannot be revoked through this pre-handoff action',async t=>{
  const c=await setup(t);
  const id=c.s.create({requestId:'unknown-revoke-0001',assetId:'DEMO:ASSET-A',threshold:'1',amount:'10',expiresInMinutes:10}).currentRuleId;
  c.s.command(id,'enable',{requestId:'unknown-revoke-enable'});c.message('/status');c.click(c.callback('revoke'));const confirm=c.callback('revoke_confirm');
  await c.s.price(id,{requestId:'unknown-revoke-price',price:'0.9',outcome:'unknown'});c.click(confirm);
  assert.match(c.text(),/unknown/);assert.equal(c.s.state().rules[0].state,'paused');assert.equal(c.s.state().rules[0].operations[0].status,'unknown');
  const keys=c.bot.load().outbox.filter(e=>e.method==='sendMessage').at(-1).body.reply_markup.inline_keyboard.flat();assert.equal(keys.some(b=>b.text==='Отозвать правило'),false);
});
