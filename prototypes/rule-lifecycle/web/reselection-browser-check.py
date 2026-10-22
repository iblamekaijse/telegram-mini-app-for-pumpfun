"""OFFLINE UI regression: saved API response, controlled source time/errors, temporary SQLite.
No wallets, live API calls or production test-control endpoints.
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
quota_checks = []


def control(process, **command):
    process.stdin.write(json.dumps(command) + '\n')
    process.stdin.flush()
    result = json.loads(process.stdout.readline())
    assert result['controlled']
    return result


def read_state(page, url):
    response = page.request.get(url + '/api/state')
    assert response.ok
    return response.json()


def tick(page, process, advance_ms, **scenario):
    command = control(process, advanceMs=advance_ms, **scenario)
    # Only read HTTP state. The real server scheduler, not this test, dispatches polling.
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        state = page.request.get(page.url.rstrip('/') + '/api/state').json()
        market = state['market']
        if market['snapshotUsable'] and market['snapshot']['observedAtMs'] >= command['now']:
            break
        page.wait_for_timeout(100)
    else:
        raise AssertionError({'expectedObservationAtLeast': command['now'], 'market': market})
    page.get_by_role('button', name='Обновить состояние', exact=True).click()


def configure(page, new=False, threshold='1.00'):
    if new:
        page.get_by_role('button', name='Новое правило', exact=False).click()
    page.locator('#data-mode').select_option('market-paper')
    page.locator('#mint').fill(mint)
    page.locator('#threshold').fill(threshold)
    page.locator('#amount').fill('10.00')
    page.locator('#expiry').fill('1')


def repeated_load(page, process):
    before = control(process)['calls']
    for _ in range(2):
        with page.expect_response(lambda r: r.url.endswith('/api/market/select') and r.request.method == 'POST') as pending:
            page.get_by_role('button', name='Загрузить токен', exact=True).click()
        response = pending.value
        assert response.ok
        market = response.json()['market']
        assert market['status'] == 'fresh' and market['snapshotUsable']
        assert market['pollStatus'] == 'waiting'
        expect(page.locator('#market-status')).to_have_text('Снимок получен')
        expect(page.locator('#market-availability')).to_contain_text('пригоден')
        expect(page.locator('#market-times')).to_contain_text('Ожидаем разрешённого времени')
    after = control(process)['calls']
    assert after == before, {'before': before, 'after': after, 'market': market}
    quota_checks.append({'before': before, 'afterTwoSelections': after})


def create_enable(page, url, expected_count):
    page.get_by_role('button', name='Создать правило', exact=False).dblclick()
    expect(page.locator('#rule-card')).to_contain_text('Черновик')
    assert len(read_state(page, url)['rules']) == expected_count
    page.get_by_role('button', name='Включить правило', exact=False).dblclick()
    expect(page.locator('#feedback')).to_contain_text('Правило включено')


def completed_and_reload(page, url, expected_count):
    expect(page.locator('#feedback')).to_contain_text('Виртуальное условие выполнено')
    expect(page.locator('#operation-result')).to_contain_text('Виртуальное условие выполнено')
    before = read_state(page, url)
    assert len(before['rules']) == expected_count
    assert before['rules'][-1]['state'] == 'finished'
    assert len(before['rules'][-1]['operations']) == 1
    page.reload()
    expect(page.locator('#feedback')).to_contain_text('Виртуальное условие выполнено')
    after = read_state(page, url)
    assert len(after['rules']) == expected_count
    assert [r['operations'] for r in before['rules']] == [r['operations'] for r in after['rules']]
    return after


with tempfile.TemporaryDirectory(prefix='market-reselection-browser-') as temporary:
    process = subprocess.Popen(['node', str(ROOT / 'test-support/market-browser-server.mjs'), str(Path(temporary) / 'data')],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, env=dict(os.environ))
    line = process.stdout.readline()
    if not line:
        raise RuntimeError(process.stderr.read())
    url = json.loads(line)['url']
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=shutil.which('chromium'), headless=True, args=['--no-sandbox'])
            page = browser.new_page(viewport={'width': 1440, 'height': 1050}, locale='ru-RU')
            page.set_default_timeout(12_000)
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(url)
            configure(page)
            control(process, scenario='error')
            page.get_by_role('button', name='Загрузить токен', exact=True).click()
            expect(page.locator('#market-status')).to_contain_text('Ошибка')
            page.get_by_role('button', name='Создать правило', exact=False).click()
            expect(page.locator('[data-error=mint]')).not_to_be_empty()
            expect(page.locator('#feedback')).to_have_class('feedback error')
            tick(page, process, 20_000, scenario='fixture')
            expect(page.locator('[data-error=mint]')).to_be_empty()
            expect(page.locator('#mint')).not_to_have_attribute('aria-invalid', 'true')
            expect(page.locator('#feedback')).to_contain_text('Свежий снимок доступен')
            checks.append('background_recovery_clears_only_obsolete_source_form_error')
            repeated_load(page, process)
            create_enable(page, url, 1)
            tick(page, process, 10_000)
            completed_and_reload(page, url, 1)

            configure(page, new=True)
            repeated_load(page, process)
            create_enable(page, url, 2)
            tick(page, process, 10_000)
            completed_and_reload(page, url, 2)
            checks.append('finished_new_same_mint_repeated_selection_single_virtual_result_and_reload')

            configure(page, new=True)
            repeated_load(page, process)
            create_enable(page, url, 3)
            page.get_by_role('button', name='Приостановить', exact=True).click()
            expect(page.locator('#feedback')).to_contain_text('Новые операции приостановлены')
            expect(page.get_by_role('button', name='Новое правило', exact=False)).to_have_count(0)
            page.get_by_role('button', name='Включить правило', exact=False).click()
            expect(page.locator('#feedback')).to_contain_text('Правило включено')
            page.get_by_role('button', name='Отозвать правило', exact=True).click()
            page.get_by_role('button', name='Окончательно отозвать', exact=True).click()
            expect(page.locator('#feedback')).to_contain_text('Правило окончательно отозвано')
            expect(page.get_by_role('button', name='Включить правило', exact=False)).to_have_count(0)
            configure(page, new=True)
            repeated_load(page, process)
            create_enable(page, url, 4)
            tick(page, process, 10_000)
            completed_and_reload(page, url, 4)
            checks.append('pause_is_temporary_revocation_is_final_new_rule_keeps_old_history')

            configure(page, new=True, threshold='0.000001')
            repeated_load(page, process)
            create_enable(page, url, 5)
            tick(page, process, 60_000)
            expect(page.locator('#feedback')).to_contain_text('Срок правила истёк')
            configure(page, new=True)
            repeated_load(page, process)
            create_enable(page, url, 6)
            tick(page, process, 10_000)
            final = completed_and_reload(page, url, 6)
            assert [r['state'] for r in final['rules']] == ['finished', 'finished', 'revoked', 'finished', 'expired', 'finished']
            assert [len(r['operations']) for r in final['rules']] == [1, 1, 0, 1, 0, 1]
            checks.append('expired_new_same_mint_rule_one_result_reload_preserves_all_six_rules')
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path=str(RESULTS / 'market-reselection-desktop.png'), full_page=True)
            page.set_viewport_size({'width': 390, 'height': 844})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path=str(RESULTS / 'market-reselection-mobile.png'), full_page=True)
            assert not errors, errors
            report = {'mode': 'OFFLINE SAVED RESPONSE, ACTUAL HTTP PANEL AND TEMPORARY SQLITE', 'checks': checks,
                      'repeatedSelectionHttpCallChecks': quota_checks, 'ruleStates': [r['state'] for r in final['rules']],
                      'operationCounts': [len(r['operations']) for r in final['rules']], 'pageErrors': errors, 'result': 'passed'}
            (RESULTS / 'market-reselection-browser.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
            print(json.dumps(report, ensure_ascii=False))
            browser.close()
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
