# Передача локального DEMO

Текущая ветка рыночной интеграции: **`codex/pumpswap-price-snapshots`**, база — `origin/main` / `12801554c90f3f07e699b828729d36900a220972`. Первоначальная поставка ядра/панели была сохранена коммитом `454fa48` в PR №1; GitHub показывает его слитым. Новые изменения передаются отдельным связанным PR, без самостоятельного слияния в main. До первоначальной поставки исходники находились только в рабочей Cloud-среде и не были добавлены в Git.

## Что сохранено в ветке

- `prototypes/rule-lifecycle/`: ядро правил/операций, SQLite-хранилище, восстановление, синтетический источник, решения владельца и имитатор.
- `prototypes/rule-lifecycle/web/`: HTTP-слой, HTML/CSS/JavaScript панели и сценарий проверки браузером.
- Все пять наборов тестов, вспомогательные процессы и четыре CLI-демонстрации.
- Бриф, контракты источника/решений, инструкции запуска, сводка проверок, итоговый TAP-отчёт и снимки панели.

Не включены: локальная SQLite-база и её содержимое, секреты/настройки окружения, node_modules, кэш, временные журналы и старые TAP-выводы. Они не удаляются из исходной рабочей среды. Исторические ссылки на такие журналы в брифе обозначают локальные архивные пути, а не файлы этой поставки.

`experiments/swig-pump/` целиком оставлен отдельно в исходной рабочей среде и **не включён в эту ветку**: для запуска ядра и панели он не нужен. Его исходники, старые результаты и бинарные материалы не удалены и не изменены. Эта передача не является резервной копией эксперимента. Исследование подписи и эксперименты безопасности не возобновлялись.

## Доступ из Cloud

Доступный пользователю штатный предпросмотр в этой Cloud-задаче не установлен. Пользовательский интерфейс Cloud сообщает, что localhost snapshots недоступны; среди доступных инструментов нет инструмента публикации предпросмотра. Сервер остаётся на `127.0.0.1`: он не выставляется в интернет, туннель не создаётся. Снимки ниже показывают фактически запущенную панель, но не являются интерактивным приложением.

[Проверки и их границы](prototypes/rule-lifecycle/VALIDATION.md).

### Компьютер

![Фактический снимок DEMO-панели, Chromium 1440×1050](prototypes/rule-lifecycle/results/web-desktop.png)

### Узкий экран

![Фактический снимок DEMO-панели, Chromium 390×844](prototypes/rule-lifecycle/results/web-mobile.png)

<a id="windows"></a>
## Один способ запуска на Windows: WSL 2 / Ubuntu

Нужны Windows с поддержкой WSL 2, интернет и права установки WSL. Этот способ использует Linux-версию Node.js **24.19.0** внутри Windows и сохраняет проверенную среду SQLite/файловой системы. Прямой запуск хранилища в native Windows не проверен и здесь не предлагается: ядро использует синхронизацию каталога на диске. Установка WSL на компьютере пользователя также не проверена в Cloud.

В PowerShell **от администратора**:

```powershell
wsl --install -d Ubuntu
```

После требуемой Windows перезагрузки откройте **Ubuntu** из меню «Пуск», завершите создание локального пользователя. Следующие команды выполняются **в Ubuntu**, не в PowerShell. Менеджер версий берётся из официального репозитория nvm; Node скачивается его установщиком. `npm install` приложению не нужен.

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh -o /tmp/demo-nvm-install.sh
bash /tmp/demo-nvm-install.sh
. "$HOME/.nvm/nvm.sh"
nvm install 24.19.0
nvm alias default 24.19.0
cd ~
git clone --branch codex/pumpswap-price-snapshots --single-branch https://github.com/iblamekaijse/telegram-mini-app-for-pumpfun.git
cd telegram-mini-app-for-pumpfun
git rev-parse HEAD
node --version
cd prototypes/rule-lifecycle
npm start
```

`node --version` должен показать `v24.19.0`. `git rev-parse HEAD` показывает полученный коммит; сопоставьте его с hash в PR/сообщении о передаче. Сохраняйте проект в домашнем каталоге Ubuntu, как в командах, а не в `/mnt/c` или сетевом каталоге. WSL 2 обычно перенаправляет localhost в Windows; его доступность на конкретном компьютере зависит от настроек WSL/брандмауэра и в Cloud не проверялась. Публичный IP для этого не нужен.

В браузере **этого Windows-компьютера** откройте **http://localhost:4173**. Это не адрес Cloud и не доступ с телефона.

1. Создайте правило с тестовыми значениями: актив A, условие **1.00**, сумма **10.00**, срок **10 минут**.
2. Включите его. В DEMO-пульте выберите «Успех», передайте цену **1.20**, затем **0.90**.
3. Проверьте завершённую попытку и журнал. Обновите страницу.
4. В Ubuntu остановите сервер Ctrl+C, снова выполните `npm start`; обновите страницу. Состояние должно остаться прежним.

При последующих запусках: откройте Ubuntu, выполните `cd ~/telegram-mini-app-for-pumpfun/prototypes/rule-lifecycle` и `npm start`. Не удаляйте `.local-web`: это сохранённая история. Для отдельной проверки набора тестов из того же каталога — `npm test`; тесты используют временные хранилища.

## Границы

Синтетический DEMO и рыночные снимки с виртуальным срабатыванием, `LIVE_TRADING_ALLOWED=false`. Тестовый доверенный контекст владельца не является авторизацией. Нет кошельков, реальных сделок и проверки интеграции с Solana. `unknown` остаётся блокировкой, `accept_gap` отключён. Публикация исходников и снимков не означает публичного размещения приложения.


## Дополнение: реальные цены, виртуальные правила

В отдельной связанной ветке и PR добавлен режим рыночных снимков DEX Screener для индексируемых пулов PumpSwap токен/WSOL. Кошельки/торговое исполнение не подключаются. [Пошаговая инструкция и границы источника](prototypes/rule-lifecycle/web/MARKET_DATA.md). Команда запуска прежняя, Node.js 24.19.0; серверный запуск теперь учитывает штатные proxy-настройки среды.


## Обновление существующей WSL-установки из detached HEAD

Сначала остановите свой `npm start` через **Ctrl+C**. Команды ниже запускаются в Ubuntu/WSL из любого каталога внутри существующего checkout. Node.js остаётся **24.19.0**, npm install не нужен.

`git status --short` позволяет увидеть собственные правки исходников. Сохраните их перед обновлением; команды не используют reset/clean или принудительное переключение. При конфликте переключения они остановятся, сохранив файлы. Текущий detached commit получает резервную ветку. Новый checkout создаётся в отдельной локальной ветке от полученной версии PR №2. Настройки скачивания дополнены, чтобы работала и ранее созданная single-branch копия.

```bash
(
  set -e
  cd "$(git rev-parse --show-toplevel)"
  git status --short
  PANEL_UPDATE_STAMP=$(date +%Y%m%d-%H%M%S)
  git branch "backup/panel-before-$PANEL_UPDATE_STAMP" HEAD
  git remote set-branches --add origin codex/pumpswap-price-snapshots
  git fetch origin
  git switch --create "local/panel-update-$PANEL_UPDATE_STAMP" --track origin/codex/pumpswap-price-snapshots
  git rev-parse HEAD
  cd prototypes/rule-lifecycle
  npm start
)
```

Сравните выведенный полный hash с итоговым сообщением о передаче. `.local-web` остаётся в прежнем каталоге; она игнорируется Git, не удаляется и не пересоздаётся этой процедурой. Если использовался собственный DEMO_DATA_DIR, сохраните прежнюю настройку окружения. После запуска обновите браузер на том же Windows-компьютере: **http://localhost:4173**. Это не внешний Cloud-адрес. Сам запуск этих команд на компьютере пользователя здесь не проверялся.

## Обновление до виртуальных позиций (отдельный PR с базой PR №2)

Ветка этого этапа: **codex/virtual-position-lifecycle**, база **codex/pumpswap-price-snapshots**. Запуск остаётся `npm start`, Node.js **24.19.0**, без npm install. [Инструкция панели](prototypes/rule-lifecycle/web/VIRTUAL_POSITIONS.md).

Сначала остановите сервер Ctrl+C. Команды из любого каталога существующего checkout в WSL, в том числе из detached HEAD. Сначала сохраните собственные незакоммиченные исходники, если `git status` их показывает. Создаются резервная ссылка на текущий commit и **копия стандартной .local-web вне репозитория** перед lossless-миграцией v3 → v4; история не удаляется. Если используется свой `DEMO_DATA_DIR`, скопируйте именно этот каталог при остановленном сервере и сохраните прежнюю настройку для запуска.

```bash
(
  set -e
  cd "$(git rev-parse --show-toplevel)"
  git status --short
  PANEL_UPDATE_STAMP=$(date +%Y%m%d-%H%M%S)
  git branch "backup/panel-before-positions-$PANEL_UPDATE_STAMP" HEAD
  if [ -d prototypes/rule-lifecycle/.local-web ]; then
    cp -a prototypes/rule-lifecycle/.local-web "$HOME/panel-data-before-v4-$PANEL_UPDATE_STAMP"
  fi
  git remote set-branches --add origin codex/virtual-position-lifecycle
  git fetch origin
  git switch --create "local/positions-$PANEL_UPDATE_STAMP" --track origin/codex/virtual-position-lifecycle
  git rev-parse HEAD
  cd prototypes/rule-lifecycle
  npm start
)
```

Сравните hash с переданным коммитом. Перейдите **http://localhost:4173** на том же Windows-компьютере; адрес доступен только компьютеру с сервером. Не запускайте старый код на обновлённой v4-базе: прежняя версия её не поддерживает. Резервная копия нужна для отдельного отката вместе со старым кодом, а не для смешивания историй. Публикация PR не размещает приложение в интернете. Сам компьютер пользователя недоступен в этой среде; поведение миграции проверено в Linux на временных SQLite.
