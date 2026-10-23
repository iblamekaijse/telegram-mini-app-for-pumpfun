"""OFFLINE UI: saved response + explicitly TEST prices 100/105/107/110/90.
Real panel HTTP/core/SQLite; no live API, wallets or production test endpoints.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
from playwright.sync_api import sync_playwright, expect
ROOT = Path(__file__).resolve().parent.parent
RESULTS = ROOT / 'results'
mint = json.loads((ROOT / 'fixtures/dexscreener-pumpswap.json').read_text())[0]['baseToken']['address']
checks = []

def launch(data, **initial):
    process = subprocess.Popen(['node', str(ROOT / 'test-support/market-browser-server.mjs'), str(data), json.dumps(initial)],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=dict(os.environ))
    line = process.stdout.readline()
    if not line:
        raise RuntimeError(process.stderr.read())
    return process, json.loads(line)['url']

def control(process, **command):
    process.stdin.write(json.dumps(command) + '\n'); process.stdin.flush()
    return json.loads(process.stdout.readline())

def state(page):
    response = page.request.get(page.url.rstrip('/') + '/api/state')
    assert response.ok
    return response.json()

def tick(page, process, price, advance=10_000):
    command = control(process, advanceMs=advance, priceUsd=price, scenario='fixture')
    end = time.monotonic() + 12
    while time.monotonic() < end:
        s = state(page)
        if s['market']['snapshotUsable'] and s['market']['snapshot']['observedAtMs'] >= command['now']:
            break
        page.wait_for_timeout(100)
    else:
        raise AssertionError(s)
    page.get_by_role('button', name='Обновить состояние', exact=True).click()
    return state(page)

def create(page, new=False):
    if new:
        page.get_by_role('button', name='Новое правило', exact=False).click()
    page.locator('#data-mode').select_option('market-paper')
    page.locator('#scenario').select_option('virtual-position')
    page.locator('#mint').fill(mint)
    page.get_by_role('button', name='Загрузить токен', exact=True).click()
    expect(page.locator('#market-status')).to_have_text('Снимок получен')
    page.locator('#threshold').fill('100')
    page.locator('#amount').fill('1000')
    page.locator('#expiry').fill('1')
    page.locator('#take-profit').fill('10')
    page.locator('#stop-loss').fill('10')
    page.get_by_role('button', name='Создать правило', exact=False).dblclick()
    expect(page.locator('#rule-card')).to_contain_text('Черновик')
    page.get_by_role('button', name='Включить правило', exact=False).dblclick()
    expect(page.locator('#feedback')).to_contain_text('Правило включено')

with tempfile.TemporaryDirectory(prefix='positions-browser-') as tmp:
    data = Path(tmp) / 'data'
    process, url = launch(data, now=1_800_000_000_000, priceUsd='120')
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=shutil.which('chromium'), headless=True, args=['--no-sandbox'])
            page = browser.new_page(viewport={'width': 1440, 'height': 1080}, locale='ru-RU')
            page.set_default_timeout(12_000)
            errors = []; page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(url); create(page)
            first = tick(page, process, '100')
            expect(page.locator('#position-card')).to_contain_text('Открыта')
            expect(page.locator('#position-card')).to_contain_text('10 токенов')
            assert len(first['positions']) == 1 and first['positions'][0]['status'] == 'open'
            assert len(first['rules'][0]['operations']) == 1
            expect(page.get_by_role('button', name='Новое правило', exact=False)).to_have_count(0)
            current = tick(page, process, '105')
            expect(page.locator('#position-card')).to_contain_text('50 USD · 5%')
            page.reload(); expect(page.locator('#position-card')).to_contain_text('Открыта')
            checks.append('create_enable_new_snapshot_entry_and_valuation_reload_no_duplicate')
            # Restart a distinct OS process, same SQLite, initially unavailable source.
            saved_now = control(process)['now']; process.kill(); process.wait(timeout=5)
            process, url = launch(data, now=saved_now + 1, priceUsd='200', scenario='error')
            page.goto(url)
            expect(page.locator('#position-card')).to_contain_text('Нет актуальной оценки')
            expect(page.locator('#position-card')).to_contain_text('Открыта')
            assert len(state(page)['positions']) == 1
            current = tick(page, process, '105', advance=120_000)
            expect(page.locator('#position-card')).to_contain_text('50 USD · 5%')
            assert current['rules'][0]['state'] == 'finished'
            checks.append('killed_server_open_position_restored_no_cached_valuation_or_exit_new_data_recovers_after_entry_expiry')
            page.screenshot(path=str(RESULTS / 'positions-open-desktop.png'), full_page=True)
            page.set_viewport_size({'width': 390, 'height': 844})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path=str(RESULTS / 'positions-open-mobile.png'), full_page=True)
            page.set_viewport_size({'width': 1440, 'height': 1080})
            page.get_by_role('button', name='Закрыть виртуальную позицию', exact=True).dblclick()
            expect(page.locator('#position-card')).to_contain_text('Запрос закрытия сохранён')
            assert state(page)['positions'][0]['status'] == 'close_requested'
            page.reload(); expect(page.locator('#position-card')).to_contain_text('Ожидаем закрытия')
            final = tick(page, process, '107')
            expect(page.locator('#position-card')).to_contain_text('70 USD · 7%')
            expect(page.locator('#feedback')).to_contain_text('Виртуальная позиция закрыта')
            assert final['positions'][0]['exit']['reason'] == 'user_request'
            checks.append('manual_request_waits_after_reload_next_snapshot_107_result_70_7percent')
            for price, reason, pnl in [('110', 'take_profit', '100'), ('90', 'stop_loss', '-100')]:
                create(page, new=True)
                tick(page, process, '100')
                expect(page.locator('#position-card')).to_contain_text('Открыта')
                final = tick(page, process, price)
                expect(page.locator('#position-card')).to_contain_text(f'{pnl} USD')
                assert final['positions'][-1]['exit']['reason'] == reason
                page.reload(); expect(page.locator('#position-card')).to_contain_text('Закрыта')
                checks.append(reason + '_full_ui_cycle_and_persistent_result')
            assert len(final['positions']) == 3 and len(final['rules']) == 3
            assert [len(r['operations']) for r in final['rules']] == [1, 1, 1]
            assert all(p['status'] == 'closed' for p in final['positions'])
            expect(page.locator('#position-history')).to_contain_text('Завершённые виртуальные позиции')
            page.screenshot(path=str(RESULTS / 'positions-closed-desktop.png'), full_page=True)
            assert not errors, errors
            browser.close()
            report = {'mode': 'OFFLINE SAVED RESPONSE + EXPLICIT TEST PRICES; ACTUAL HTTP/SQLITE/BROWSER',
                      'checks': checks, 'positions': [{'status': p['status'], 'reason': p['exit']['reason'], 'pnlUsd': p['display']['pnlUsd']} for p in final['positions']],
                      'pageErrors': errors, 'result': 'passed'}
            (RESULTS / 'positions-browser.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
            print(json.dumps(report, ensure_ascii=False))
    finally:
        if process.poll() is None:
            process.kill(); process.wait(timeout=5)
