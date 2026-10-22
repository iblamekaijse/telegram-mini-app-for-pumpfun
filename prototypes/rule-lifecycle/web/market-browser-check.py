"""Browser mutations go through the UI. Default: OFFLINE fixture harness. --live: real public API.
Requires separately available Python Playwright and Chromium; no application dependency.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
RESULTS = ROOT / 'results'
parser = argparse.ArgumentParser()
parser.add_argument('--live', action='store_true')
args = parser.parse_args()
mint = json.loads((ROOT / 'fixtures/dexscreener-pumpswap.json').read_text())[0]['baseToken']['address']
checks = []


def assert_virtual_result(page):
    expect(page.locator('#feedback')).to_contain_text('Виртуальное условие выполнено')
    expect(page.locator('#feedback')).not_to_contain_text('Правило включено')
    expect(page.locator('#feedback')).not_to_contain_text('Ожидаем следующий')
    expect(page.locator('#operation-result')).to_contain_text('Виртуальное условие выполнено')
    expect(page.locator('#operation-result')).to_contain_text('покупка не проводилась')
    expect(page.locator('#operation-result')).not_to_contain_text('Успех')
    expect(page.locator('#journal-list .state-pill.succeeded')).to_have_text('Виртуальное условие выполнено')
    expect(page.locator('#journal-list .log-title').filter(has_text='Виртуальное условие выполнено')).to_have_count(1)


def start(data_dir):
    command = ['node', '--use-env-proxy', str(ROOT / 'web/server.mjs')] if args.live else [
        'node', str(ROOT / 'test-support/market-browser-server.mjs'), str(data_dir)]
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, env=dict(os.environ, DEMO_DATA_DIR=str(data_dir), DEMO_PORT='0'))
    line = process.stdout.readline()
    if not line:
        raise RuntimeError(process.stderr.read())
    return process, json.loads(line)['url']


def control(process, **command):
    process.stdin.write(json.dumps(command) + '\n')
    process.stdin.flush()
    assert json.loads(process.stdout.readline())['controlled']


with tempfile.TemporaryDirectory(prefix='paper-market-browser-') as temporary:
    data_dir = Path(temporary) / 'data'
    process, url = start(data_dir)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=shutil.which('chromium'), headless=True,
                                        args=['--no-sandbox'])
            page = browser.new_page(viewport={'width': 1440, 'height': 1050}, locale='ru-RU')
            page.set_default_timeout(12_000)
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(url)
            page.locator('#data-mode').select_option('market-paper')
            page.locator('#mint').fill('invalid')
            page.get_by_role('button', name='Загрузить токен').click()
            expect(page.locator('[data-error=mint]')).not_to_be_empty()
            page.locator('#mint').fill(mint)
            page.get_by_role('button', name='Загрузить токен').click()
            expect(page.locator('#market-status')).to_have_text('Снимок получен')
            expect(page.locator('#market-info')).to_contain_text(mint)
            expect(page.locator('#market-info')).to_contain_text('PumpSwap')
            expect(page.locator('#market-info')).to_contain_text('USD за токен')
            checks.append('mint_validation_pool_quote_and_source_visible')
            # Explicit artificial verification threshold, not a trading recommendation.
            page.locator('#threshold').fill('1.00' if args.live else '0.0001')
            page.locator('#amount').fill('10.00')
            page.get_by_role('button', name='Создать правило', exact=False).click()
            expect(page.locator('#feedback')).to_contain_text('Правило создано, но ещё не включено')
            page.get_by_role('button', name='Включить правило', exact=False).click()
            expect(page.locator('#feedback')).to_contain_text('Правило включено')
            if not args.live:
                page.get_by_role('button', name='Приостановить', exact=True).click()
                expect(page.locator('#feedback')).to_contain_text('Новые операции приостановлены')
                expect(page.locator('#feedback')).not_to_contain_text('Правило включено')
                page.get_by_role('button', name='Включить правило', exact=False).click()
                expect(page.locator('#feedback')).to_contain_text('Правило включено')
            expect(page.locator('#demo-console')).to_be_hidden()
            if not args.live:
                control(process, advanceMs=10_000)
                expect(page.locator('#journal-list')).to_contain_text('Условие цены пока не выполнено')
                control(process, advanceMs=10_000, scenario='error')
                expect(page.locator('#market-status')).to_contain_text('Ошибка')
                control(process, advanceMs=45_001)
                expect(page.locator('#market-price')).to_contain_text('устарело')
                expect(page.locator('#rule-card')).to_contain_text('Ещё нет операции')
                control(process, advanceMs=50_000, scenario='fixture', priceUsd='0.00009')
                expect(page.locator('#market-error')).to_contain_text('Опрос восстановлен')
                checks.append('offline_outage_stale_no_signal_and_fresh_recovery')
            expect(page.locator('#journal-list')).to_contain_text('Виртуальное условие выполнено', timeout=25_000)
            expect(page.locator('#rule-card')).to_contain_text('Попытка завершена')
            expect(page.locator('#rule-card')).to_contain_text('цена исполнения')
            assert_virtual_result(page)
            checks.append('current_rule_banner_and_explicit_virtual_result_after_background_trigger')
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            mode = 'live' if args.live else 'fixture'
            page.screenshot(path=str(RESULTS / f'market-{mode}-desktop.png'), full_page=True)
            page.reload()
            assert_virtual_result(page)
            checks.append('reload_derives_same_completed_banner_and_operation_result')
            checks.append('ui_create_enable_new_snapshot_virtual_result_reload')
            if args.live:
                before = page.request.get(url + '/api/state').json()
                process.kill()
                process.wait(timeout=5)
                process, url = start(data_dir)
                page.goto(url)
                assert_virtual_result(page)
                after = page.request.get(url + '/api/state').json()
                assert before['rules'][0]['operations'] == after['rules'][0]['operations']
                expect(page.locator('#market-status')).to_have_text('Снимок получен')
                assert_virtual_result(page)
                checks.append('live_server_SIGKILL_restart_same_virtual_operation_no_repeat')
            page.set_viewport_size({'width': 390, 'height': 844})
            if not page.evaluate('document.documentElement.scrollWidth <= innerWidth'):
                print(page.evaluate('Array.from(document.querySelectorAll("body *")).filter(e => e.getBoundingClientRect().right > innerWidth + 1).map(e => ({tag:e.tagName,id:e.id,class:e.className,right:e.getBoundingClientRect().right})).slice(0,20)'), flush=True)
                page.screenshot(path='/tmp/market-mobile-overflow.png', full_page=True)
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path=str(RESULTS / f'market-{mode}-mobile.png'), full_page=True)
            checks.append('desktop_and_mobile_without_horizontal_overflow')
            if not args.live:
                page.get_by_role('button', name='Новое правило', exact=False).click()
                page.locator('#data-mode').select_option('market-paper')
                page.locator('#mint').fill('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
                control(process, advanceMs=10_000, scenario='no_data')
                expect(page.locator('#find-token')).to_be_enabled()
                page.get_by_role('button', name='Загрузить токен').click()
                control(process, advanceMs=60_000)
                expect(page.locator('#market-status')).to_contain_text('Нет поддерживаемых данных')
                expect(page.locator('#market-error')).to_contain_text('bonding curve')
                expect(page.locator('#market-price')).to_have_text('Цена пока недоступна')
                checks.append('offline_no_supported_pool_no_synthetic_substitution')
            assert not errors, errors
            report = {'mode': 'LIVE PUBLIC API, VIRTUAL OPERATIONS ONLY' if args.live else 'OFFLINE SAVED FIXTURE, EXPLICIT MUTATIONS',
                      'source': 'DEX Screener token-pairs/v1/solana', 'mint': mint, 'checks': checks, 'pageErrors': errors, 'result': 'passed'}
            (RESULTS / f'market-{mode}-browser.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
            print(json.dumps(report, ensure_ascii=False))
            browser.close()
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
