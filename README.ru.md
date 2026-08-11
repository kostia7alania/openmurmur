# OpenMurmur

[Canonical engineering README in English](README.md)

**Локальный аудиодневник для Mac с Apple Silicon.**

OpenMurmur непрерывно слушает микрофон, открывает сессию при устойчивой речи,
закрывает её после минуты тишины, сохраняет исходный FLAC и локально запускает
Qwen3-ASR. Аудио сразу ставится в очередь Telegram; расшифровка и отчёт приходят
по готовности. Облачного ASR, телеметрии и аккаунта OpenMurmur нет.

Это короткое руководство владельца, а не зеркальный перевод всей инженерной
документации. Канонические контракты, архитектура и доказательства проверок
остаются в [README.md](README.md) и каталоге [docs](docs/).

> ⚠️ Запись людей имеет юридические и этические последствия. Требования к
> согласию различаются по странам и регионам. До запуска рядом с другими людьми
> прочитайте [RECORDING_POLICY.md](RECORDING_POLICY.md) и получите необходимое
> согласие.

## Что потребуется

- Mac на Apple Silicon, macOS 14 или новее;
- Node.js 26.7.0+ (`.nvmrc` включён);
- Homebrew, FFmpeg 8.x и `uv`;
- 64 ГБ unified memory рекомендуется для ASR и локальной 27B LLM;
- свой Telegram-бот и приватный чат;
- Ollama — опционально, для структурированных отчётов.

Полная установка с нуля: [docs/INSTALL.md](docs/INSTALL.md). Удалённый Mac по
SSH: [docs/SERVER.md](docs/SERVER.md).

## Быстрый старт

```bash
git clone https://github.com/kostia7alania/openmurmur.git
cd openmurmur
./scripts/bootstrap
uv sync --project python/openmurmur_audio --extra mlx
pnpm openmurmur doctor
pnpm openmurmur setup
pnpm openmurmur setup telegram
pnpm openmurmur capture test
pnpm openmurmur start
```

Команда `uv sync ... --extra mlx` обязательна: `bootstrap` ставит только
CI-safe набор, без которого Silero и Qwen не запустятся.

Оставьте последнюю команду работать в foreground. Когда в логе появится
`first audio frame received`, говорите дольше 3 секунд, затем помолчите 60
секунд. В Telegram должны прийти исходный FLAC, затем транскрипт и отчёт.

В другом терминале статус можно проверить через `pnpm openmurmur status`.

Два шага macOS нельзя автоматизировать безопасно: разрешение микрофона и ввод
токена Telegram. Секрет хранится только в Keychain.

## Что приходит в Telegram

- исходный lossless FLAC с именем компьютера, датой и UID сессии;
- короткая расшифровка в сворачиваемой цитате или один `.md` для длинного текста;
- обнаруженные языки и честная пометка `авто` либо `только <язык>`;
- краткое содержание и структурированный отчёт;
- статусы записи, очередей и здоровья демона.

Telegram — единственная сетевая граница, но bot chat не имеет end-to-end
шифрования. Если Telegram не должен получать исходное аудио, этот продукт вам
не подходит. Подробнее: [PRIVACY.md](PRIVACY.md) и
[docs/TELEGRAM.md](docs/TELEGRAM.md).

## Команды бота

| Команда | Что делает |
| --- | --- |
| `/status` | Состояние конкретного демона и имя Mac. |
| `/health` | Короткая диагностика. |
| `/settings` | `Авто` либо один фиксированный язык для следующих задач этого Mac. |
| `/help` | Список команд. |

Qwen3-ASR не поддерживает список приоритетных языков для одной записи. Поэтому
настройка — radio-choice: `Авто`, Thai, Russian, English или Chinese. `Авто`
рекомендуется для смешанной речи; фиксированный Thai полезен, когда запись точно
полностью тайская.

Если prod и dev используют один bot token, только один демон должен иметь
`telegram.receiveUpdates: true`. `/settings` управляет этим input-owner Mac;
send-only dev продолжает отправлять результаты, но не показывает неработающие
кнопки. Для независимой интерактивной отладки используйте отдельного dev-бота.

Удалённых `/stop`, `/pause`, `/delete`, shell-команд и произвольного чтения
файлов намеренно нет.

Если бот сообщил, что задача исчерпала попытки, выполняйте команды именно на
указанном в сообщении Mac:

```bash
pnpm openmurmur jobs failed
pnpm openmurmur doctor
pnpm openmurmur jobs retry JOB_ID
```

Первая команда показывает этап и сохранённую причину, `doctor` предлагает
конкретный способ установить/запустить ASR, Ollama или другую зависимость, а
`retry` возвращает только выбранную задачу в очередь. Бот сам не запускает
процессы и не выполняет команды на Mac.

## Проверка перед запуском

```bash
pnpm run check
UV_CACHE_DIR=/private/tmp/openmurmur-uv-cache \
  uv run --project python/openmurmur_audio pytest
```

Автотесты не требуют микрофона, модели, сети или Telegram token. Точный список
проверенного и непроверенного для текущей ревизии находится в разделе
[What is verified](README.md#what-is-verified); зелёные offline-тесты не
выдаются за live-проверку микрофона, настоящего Qwen или Telegram.
