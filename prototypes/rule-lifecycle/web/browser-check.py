"""Optional browser verification. Requires an installed Python Playwright and Chromium.
No runtime Python/browser dependency is added to the Node.js application.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
RESULTS = ROOT / 'results'
checks = []


def start(data_dir):
    environment = dict(os.environ, DEMO_DATA_DIR=str(data_dir), DEMO_PORT='0')
    process = subprocess.Popen(['node', str(ROOT / 'web/server.mjs')], stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, env=environment)
    line = process.stdout.readline()
    if not line:
        raise RuntimeError(process.stderr.read())
    return process, json.loads(line)['url']


def create_and_enable(page, new=False, asset='DEMO:ASSET-A'):
    if new:
        page.get_by_role('button', name='Новое DEMO-правило').click()
    page.locator('#asset').select_option(asset)
    page.locator('#threshold').fill('1.00')
    page.locator('#amount').fill('10.00')
    page.get_by_role('button', name='Создать правило').click()
    expect(page.locator('#rule-card')).to_contain_text('Черновик')
    page.get_by_role('button', name='Включить правило').click()
    expect(page.locator('#rule-card')).to_contain_text('Включено')


with tempfile.TemporaryDirectory(prefix='rule-panel-browser-') as temporary:
    process, url = start(Path(temporary) / 'data')
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=shutil.which('chromium'), headless=True,
                                        args=['--no-sandbox'])
            page = browser.new_page(viewport={'width': 1440, 'height': 1050}, locale='ru-RU')
            page.set_default_timeout(10_000)
            page_errors = []
            page.on('pageerror', lambda error: page_errors.append(str(error)))
            page.goto(url)
            expect(page.get_by_role('heading', name='Создайте правило')).to_be_visible()
            expect(page.locator('#send-price')).to_be_disabled()
            page.screenshot(path=str(RESULTS / 'web-empty.png'), full_page=True)
            page.locator('#threshold').fill('-1')
            page.get_by_role('button', name='Создать правило').click()
            expect(page.locator('[data-error="threshold"]')).not_to_be_empty()
            checks.append('field_validation_visible')
            create_and_enable(page)
            page.locator('#demo-price').fill('1.20')
            page.get_by_role('button', name='Передать цену').click()
            expect(page.locator('#feedback')).to_contain_text('Условие цены пока не выполнено')
            page.locator('#demo-price').fill('0.90')
            page.get_by_role('button', name='Передать цену').click()
            expect(page.locator('#rule-card')).to_contain_text('Попытка завершена')
            expect(page.locator('#feedback')).to_contain_text('успешной покупке')
            expect(page.locator('.log-title', has_text='Покупка имитирована')).to_have_count(1)
            page.reload()
            expect(page.locator('#rule-card')).to_contain_text('Попытка завершена')
            page.screenshot(path=str(RESULTS / 'web-desktop.png'), full_page=True)
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            checks.append('create_enable_high_price_low_price_success_reload_desktop')

            process.kill()
            process.wait(timeout=5)
            process, url = start(Path(temporary) / 'data')
            page.goto(url)
            expect(page.locator('#rule-card')).to_contain_text('Попытка завершена')
            expect(page.locator('.log-title', has_text='Покупка имитирована')).to_have_count(1)
            checks.append('server_SIGKILL_restart_restores_same_single_success')

            create_and_enable(page, new=True, asset='DEMO:ASSET-B')
            page.locator('input[name=outcome][value=unknown]').check()
            page.locator('#demo-price').fill('0.80')
            page.get_by_role('button', name='Передать цену').click()
            expect(page.locator('#rule-card')).to_contain_text('Исход операции неизвестен')
            expect(page.get_by_role('button', name='Включить правило')).to_have_count(0)
            page.reload()
            expect(page.locator('#rule-card')).to_contain_text('Исход операции неизвестен')
            page.get_by_text('Проверить остановку потока', exact=True).click()
            page.get_by_role('button', name='Остановить поток · DEMO').click()
            expect(page.locator('#rule-card')).to_contain_text('Поток требует решения владельца')
            expect(page.get_by_role('button', name='Принять пропуск · недоступно')).to_be_disabled()
            page.get_by_role('button', name='Проверить историю', exact=True).click()
            expect(page.locator('#rule-card')).not_to_contain_text('Поток требует решения владельца')
            expect(page.locator('#rule-card')).to_contain_text('Исход операции неизвестен')
            expect(page.get_by_role('button', name='Включить правило')).to_have_count(0)
            checks.append('unknown_persists_stream_recovery_cannot_enable_accept_gap_disabled')

            page.set_viewport_size({'width': 390, 'height': 844})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path=str(RESULTS / 'web-mobile.png'), full_page=True)
            page.get_by_role('button', name='Отозвать правило', exact=True).click()
            expect(page.locator('#revoke-dialog')).to_be_visible()
            page.get_by_role('button', name='Окончательно отозвать', exact=True).click()
            expect(page.locator('#rule-card')).to_contain_text('Отозвано')
            expect(page.locator('#rule-card')).to_contain_text('Исход операции неизвестен')
            checks.append('mobile_no_overflow_and_final_revocation_keeps_unknown')

            create_and_enable(page, new=True)
            page.locator('input[name=outcome][value=failed]').check()
            page.get_by_role('button', name='Передать цену').click()
            expect(page.locator('#rule-card')).to_contain_text('Попытка завершилась неудачей')
            expect(page.get_by_role('button', name='Включить правило')).to_have_count(0)
            checks.append('failure_terminal_and_old_history_preserved')
            assert page_errors == [], page_errors
            browser.close()
        result = {'browser': 'Chromium / Python Playwright', 'checks': checks,
                  'pageErrors': page_errors, 'desktop': [1440, 1050], 'mobile': [390, 844],
                  'result': 'passed', 'mode': 'synthetic DEMO only'}
        (RESULTS / 'web-browser.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps(result, ensure_ascii=False))
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=5)
