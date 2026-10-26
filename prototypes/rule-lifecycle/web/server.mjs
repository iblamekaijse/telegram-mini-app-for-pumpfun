import { TelegramTransport, runTelegram } from './telegram.mjs';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPanelService, PanelError } from './panel-service.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const errors = {
  ATTEMPT_ALREADY_SUBMITTED: 'Попытка уже передана имитатору. Повторное исполнение этого правила запрещено.',
  SOURCE_DECISION_REQUIRED: 'Нужна явная проверка истории потока или окончательный отзыв.',
  STALE_SOURCE_INCIDENT: 'Случай остановки уже изменился. Обновите состояние и выберите действие снова.',
  INVALID_TRANSITION: 'Действие недоступно в текущем состоянии правила.',
  IDEMPOTENCY_CONFLICT: 'Ключ запроса уже использован для другого действия.',
  DEMO_OWNER_AUTH_REQUIRED: 'Тестовый контекст владельца недоступен.',
  STORAGE_UNAVAILABLE: 'Хранилище недоступно. Действия остановлены; история не сбрасывается.',
};
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
export async function startPanel({ dataDir = resolve(directory, '../.local-web'), port = 4173, marketFetch = fetch, clock = Date.now, telegramToken = process.env.TELEGRAM_BOT_TOKEN ?? '', telegramTransport } = {}) {
  const service = await createPanelService({ dataDir, marketFetch, clock, telegramConfigured: !!(telegramToken || telegramTransport) });
  let mutations = Promise.resolve();
  const serial = fn => { const result = mutations.then(fn); mutations = result.catch(() => {}); return result; };
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      const address = server.address();
      if (![`127.0.0.1:${address.port}`, `localhost:${address.port}`].includes(req.headers.host)) throw new PanelError('LOCAL_ONLY', 'Панель доступна только локально.', {}, 403);
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' && staticFiles.has(url.pathname)) {
        const [file, type] = staticFiles.get(url.pathname);
        res.writeHead(200, { 'Content-Type': type }); res.end(readFileSync(join(directory, 'public', file))); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') { json(200, service.state()); return; }
      if (req.method !== 'POST') { json(404, { error: 'NOT_FOUND', message: 'Страница не найдена.' }); return; }
      if (req.headers.origin && req.headers.origin !== url.origin) throw new PanelError('LOCAL_ONLY', 'Запрос должен быть отправлен из локальной панели.', {}, 403);
      if (!req.headers['content-type']?.startsWith('application/json')) throw new PanelError('JSON_REQUIRED', 'Ожидаются данные JSON.', {}, 415);
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 8192) throw new PanelError('BODY_TOO_LARGE', 'Слишком большой запрос.', {}, 413);
      }
      let body;
      try { body = JSON.parse(raw); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); }
      catch { throw new PanelError('INVALID_JSON', 'Не удалось прочитать данные запроса.'); }
      const positionMatch = url.pathname.match(/^\/api\/positions\/([a-zA-Z0-9_-]+)\/close$/);
      const match = url.pathname.match(/^\/api\/rules\/([a-zA-Z0-9_-]+)\/([a-z_-]+)$/);
      const result = url.pathname === '/api/market/select' ? await (async () => {
        const work = await serial(() => service.beginMarketSelect(body));
        const fetched = await work.promise;
        return serial(() => service.finishMarketSelect(fetched));
      })() : await serial(() => {
        if (url.pathname === '/api/telegram/code') return { ...service.state(), telegramLink: service.telegram.createCode() };
        if (url.pathname === '/api/telegram/unlink') { service.telegram.unlink(); return service.state(); }
        if (url.pathname === '/api/rules') return service.create(body);
        if (positionMatch) return service.closePosition(positionMatch[1], body);
        if (!match) throw new PanelError('NOT_FOUND', 'Действие не найдено.', {}, 404);
        return match[2] === 'price' ? service.price(match[1], body) : service.command(match[1], match[2], body);
      });
      json(200, result);
    } catch (error) {
      const storageFailure = error.code?.startsWith('STORAGE_');
      json(error.status ?? (storageFailure ? 503 : error.code ? 409 : 500), {
        error: error.code ?? 'INTERNAL_ERROR', message: error instanceof PanelError ? error.message
          : errors[error.code] ?? (storageFailure ? 'Хранилище недоступно. Работа остановлена.' : 'Не удалось выполнить действие. Обновите состояние.'),
        fields: error.fields ?? {},
      });
    }
  });
  try { await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveListen); }); }
  catch (error) { service.close(); throw error; }
  const bot = telegramToken || telegramTransport ? runTelegram({ controller: service.telegram, transport: telegramTransport ?? new TelegramTransport(telegramToken), serial }) : null;
  let polling = false, closing = false;
  const timer = setInterval(() => {
    if (polling || closing) return;
    polling = true;
    (async () => {
      const work = await serial(() => service.beginMarketPoll());
      const fetched = await work.promise;
      return serial(() => service.finishMarket(fetched));
    })().catch(error => {
      // Storage errors stay fail-closed in RuleEngine; never replace history.
      console.error(`Опрос остановлен: ${error.code ?? 'INTERNAL_ERROR'}`);
    }).finally(() => { polling = false; });
  }, 1000);
  timer.unref();
  return { url: `http://127.0.0.1:${server.address().port}`, close: async () => {
    closing = true; clearInterval(timer);
    await bot?.close();
    while (polling) await new Promise(resolve => setTimeout(resolve, 10));
    await new Promise((done, fail) => server.close(error => error ? fail(error) : done()));
    await mutations; service.close();
  } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const port = Number(process.env.DEMO_PORT ?? 4173);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid DEMO_PORT');
    const app = await startPanel({ dataDir: process.env.DEMO_DATA_DIR ? resolve(process.env.DEMO_DATA_DIR) : undefined, port });
    console.log(JSON.stringify({ mode: 'DEMO', url: app.url, message: 'Локальный доверенный доступ. Реальная торговля закрыта.' }));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { app.close().then(() => process.exit(0), error => { console.error(error.message); process.exit(1); }); });
  } catch (error) { console.error(`Панель не запущена: ${error.code ?? error.message}. История не сброшена.`); process.exitCode = 1; }
}
