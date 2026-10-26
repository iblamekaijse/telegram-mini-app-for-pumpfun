"""Full bot-only workflow through test getUpdates/sendMessage, real panel/SQLite and Chromium observer.
Telegram client, market provider and prices are simulated; no live token or real Telegram UI.
"""
import json
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
ROOT = Path(__file__).resolve().parent.parent
RESULTS = ROOT / 'results'
mint = json.loads((ROOT / 'fixtures/dexscreener-pumpswap.json').read_text())[0]['baseToken']['address']

def control(proc, **cmd):
    proc.stdin.write(json.dumps(cmd) + '\n');proc.stdin.flush()
    return json.loads(proc.stdout.readline())

def wait_message(proc, marker, after=0):
    end=time.monotonic()+18
    while time.monotonic()<end:
        messages=control(proc)['sent']
        for e in messages[after:]:
            if e['method']=='sendMessage' and marker in e['body'].get('text',''):
                return e['body'], len(messages)
        time.sleep(.1)
    raise AssertionError((marker,messages[after:]))

def send(proc,text,marker):
    before=len(control(proc)['sent']);control(proc,text=text)
    return wait_message(proc,marker,before)[0]

def click(proc,message,label,marker):
    data=next(b['callback_data'] for row in message['reply_markup']['inline_keyboard'] for b in row if b['text']==label)
    before=len(control(proc)['sent']);control(proc,callback=data)
    return wait_message(proc,marker,before)[0],data

with tempfile.TemporaryDirectory(prefix='bot-dialog-browser-') as tmp:
    data=Path(tmp)/'data'
    def launch(**initial):
        proc=subprocess.Popen(['node',str(ROOT/'test-support/telegram-browser-server.mjs'),str(data),json.dumps(initial)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        line=proc.stdout.readline()
        if not line:raise RuntimeError(proc.stderr.read())
        return proc,json.loads(line)['url']
    proc,url=launch()
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(executable_path=shutil.which('chromium'),headless=True,args=['--no-sandbox'])
            page=browser.new_page(viewport={'width':390,'height':844},locale='ru-RU');page.set_default_timeout(12000)
            errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.goto(url)
            page.locator('#telegram-code').click();expect(page.locator('#telegram-link')).to_contain_text('/start')
            code=re.search(r'/start ([a-f0-9]{24})',page.locator('#telegram-link').inner_text())[1]
            send(proc,'/start '+code,'Привязка подтверждена')
            menu=send(proc,'/start','Меню:')
            first,_=click(proc,menu,'Новое виртуальное правило','Введите mint')
            send(proc,'bad mint','Ошибка:')
            send(proc,mint,'Загружаем поддерживаемый пул')
            source,_=wait_message(proc,'Источник проверен')
            field,_=click(proc,source,'Продолжить к цене входа','Введите цену')
            send(proc,'100','Введите виртуальную сумму')
            # Restart with an unfinished conversation, then use the actual persisted continue button.
            status=control(proc);proc.kill();proc.wait(timeout=5)
            proc,url=launch(now=status['now']+1,updateId=status['updateId'],priceUsd='120');page.goto(url)
            help=send(proc,'/help','Меню:')
            click(proc,help,'Продолжить настройку','Введите виртуальную сумму')
            send(proc,'1000','Введите срок');send(proc,'10','Введите TP');send(proc,'10','Введите SL')
            review=send(proc,'10','Проверьте параметры')
            # Re-fetch after restart through the shared cooldown; re-render confirmation with a new revision.
            click(proc,review,'Обновить источник','Источник будет повторно проверен')
            review,_=wait_message(proc,'Источник проверен')
            created,confirm=click(proc,review,'Подтвердить создание','Виртуальное правило создано')
            control(proc,callback=confirm)
            click(proc,created,'Включить правило','Ожидающее входное правило включено')
            control(proc,advanceMs=10000,priceUsd='100')
            opened,_=wait_message(proc,'Виртуальная позиция открыта')
            expect(page.locator('#position-card')).to_contain_text('Открыта')
            click(proc,opened,'Запросить закрытие позиции','Запрос закрытия сохранён')
            control(proc,advanceMs=10000,priceUsd='107')
            wait_message(proc,'Виртуальная позиция закрыта')
            history=send(proc,'История','История · страница')
            detail_label=next(b['text'] for row in history['reply_markup']['inline_keyboard'] for b in row if b['text'].startswith('Подробнее:'))
            detail,_=click(proc,history,detail_label,'Зафиксированный результат: 70 USD')
            assert 'Основание входа:' in detail['text'] and 'Основание выхода:' in detail['text']
            state=page.request.get(url+'/api/state').json();assert len(state['rules'])==1 and len(state['rules'][0]['operations'])==1
            page.locator('#refresh').click();expect(page.locator('#position-history')).to_contain_text('70 USD')
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth');assert not errors,errors
            page.screenshot(path=str(RESULTS/'telegram-dialog-mobile.png'),full_page=True)
            report={'mode':'OFFLINE bot and market test transports; Chromium observes real HTTP/SQLite',
                    'checks':['menu_mint_validation_source','all_fields_with_pending_dialog_SIGKILL_restart_continue',
                              'review_refresh_version_confirmation_separate_enable_duplicate_confirmation',
                              'entry_notification_manual_close_new_snapshot_saved_result_history_detail',
                              'one_rule_one_operation_mobile_no_overflow_no_JS_errors'],
                    'result':'passed','pageErrors':errors,'rules':len(state['rules']),'operations':len(state['rules'][0]['operations']),
                    'positionResultUsd':state['positions'][0]['display']['pnlUsd']}
            (RESULTS/'telegram-dialog-browser.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps(report,ensure_ascii=False));browser.close()
    finally:
        if proc.poll() is None:proc.terminate();proc.wait(timeout=10)
