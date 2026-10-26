"""Offline UI + long-poll bot workflow; temporary real SQLite, fake market/Telegram transports."""
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
checks = []

def start(data, **initial):
    proc = subprocess.Popen(['node', str(ROOT / 'test-support/telegram-browser-server.mjs'), str(data), json.dumps(initial)],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    line = proc.stdout.readline()
    if not line:
        raise RuntimeError(proc.stderr.read())
    return proc, json.loads(line)['url']

def control(proc, **cmd):
    proc.stdin.write(json.dumps(cmd) + '\n'); proc.stdin.flush()
    return json.loads(proc.stdout.readline())

def wait_sent(proc, text):
    end = time.monotonic() + 12
    while time.monotonic() < end:
        result = control(proc)
        if any(text in e['body'].get('text', '') and e['method'] == 'sendMessage' for e in result['sent']):
            return result['sent']
        time.sleep(.1)
    raise AssertionError(result)

def state(page):
    return page.request.get(page.url.rstrip('/') + '/api/state').json()

def tick(page, proc, price):
    target = control(proc, advanceMs=10000, priceUsd=price)['now']
    end = time.monotonic() + 12
    while time.monotonic() < end:
        s = state(page)
        if s['market']['snapshotUsable'] and s['market']['snapshot']['observedAtMs'] >= target:
            page.locator('#refresh').click()
            return s
        time.sleep(.1)
    raise AssertionError(s)

with tempfile.TemporaryDirectory(prefix='telegram-ui-') as tmp:
    data = Path(tmp) / 'data'
    proc, url = start(data)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=shutil.which('chromium'), headless=True, args=['--no-sandbox'])
            page = browser.new_page(viewport={'width': 1440, 'height': 1080}, locale='ru-RU')
            errors = []; page.on('pageerror', lambda e: errors.append(str(e))); page.set_default_timeout(12000)
            page.goto(url)
            expect(page.locator('#telegram-code')).to_be_enabled()
            control(proc, text='/start', user=99)
            expect(page.locator('#telegram-status')).to_contain_text('Владелец не привязан')
            page.locator('#telegram-code').click()
            expect(page.locator('#telegram-link')).to_contain_text('/start')
            code = re.search(r'/start ([a-f0-9]{24})', page.locator('#telegram-link').inner_text())[1]
            control(proc, text='/start ' + code)
            expect(page.locator('#telegram-status')).to_contain_text('Владелец привязан')
            expect(page.locator('#telegram-link')).to_have_text('')
            checks.append('UI_code_private_owner_binding_random_start_denied')
            page.locator('#data-mode').select_option('market-paper'); page.locator('#scenario').select_option('virtual-position')
            page.locator('#mint').fill(mint); page.locator('#find-token').click()
            expect(page.locator('#market-status')).to_have_text('Снимок получен')
            for field, value in [('threshold','100'),('amount','1000'),('expiry','10'),('take-profit','10'),('stop-loss','10')]:
                page.locator('#' + field).fill(value)
            page.locator('#create-form button[type=submit]').click()
            page.get_by_role('button', name='Включить правило', exact=False).click()
            tick(page, proc, '100'); expect(page.locator('#position-card')).to_contain_text('Открыта')
            sent = wait_sent(proc, 'Виртуальная позиция открыта')
            opened = next(e for e in sent if 'Виртуальная позиция открыта' in e['body'].get('text',''))
            callback = next(b['callback_data'] for row in opened['body']['reply_markup']['inline_keyboard'] for b in row if 'закрытие' in b['text'])
            control(proc, callback=callback, user=99); page.wait_for_timeout(800)
            assert state(page)['positions'][0]['status'] == 'open'
            control(proc, text='/status'); wait_sent(proc, 'Последняя наблюдаемая цена')
            control(proc, callback=callback); wait_sent(proc, 'Запрос ручного закрытия сохранён')
            control(proc, callback=callback)
            expect(page.locator('#position-card')).to_contain_text('Запрос закрытия сохранён')
            tick(page, proc, '107'); expect(page.locator('#position-history')).to_contain_text('70 USD')
            wait_sent(proc, 'Виртуальная позиция закрыта')
            assert len(state(page)['rules'][0]['operations']) == 1
            checks.append('UI_create_enable_entry_notification_status_foreign_callback_denied_manual_close_new_snapshot_result')
            page.screenshot(path=str(RESULTS / 'telegram-desktop.png'), full_page=True)
            page.set_viewport_size({'width':390,'height':844}); assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path=str(RESULTS / 'telegram-mobile.png'), full_page=True)
            before = state(page)['positions'][0]['exit']; status = control(proc)
            proc.kill(); proc.wait(timeout=5)
            proc, url = start(data, now=status['now'] + 1, updateId=status['updateId'], priceUsd='107')
            page.goto(url); expect(page.locator('#telegram-status')).to_contain_text('Владелец привязан')
            control(proc, text='/status'); wait_sent(proc, 'Причина выхода: запрос владельца')
            assert state(page)['positions'][0]['exit'] == before
            assert len(state(page)['rules'][0]['operations']) == 1
            checks.append('SIGKILL_new_process_restores_binding_position_queue_no_repeated_trade')
            page.locator('#telegram-unlink').click(); expect(page.locator('#telegram-status')).to_contain_text('Владелец не привязан')
            control(proc, callback=callback); page.wait_for_timeout(800)
            assert state(page)['positions'][0]['exit'] == before
            checks.append('UI_unlink_revokes_old_buttons_mobile_no_overflow')
            assert not errors, errors
            browser.close()
            report = {'mode':'OFFLINE test transports; not live Telegram', 'checks':checks, 'javascriptErrors':errors,
                      'testsUseTemporarySQLite':True, 'desktop':[1440,1080], 'mobile':[390,844]}
            (RESULTS / 'telegram-browser.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
            print(json.dumps(report,ensure_ascii=False))
    finally:
        if proc.poll() is None:
            proc.terminate(); proc.wait(timeout=5)
