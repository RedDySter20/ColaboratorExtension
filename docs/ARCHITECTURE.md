# Архитектура

Документ описывает, как устроено расширение: слои, потоки данных, хранилище и
точки расширения. Он рассчитан на разработчика, который впервые открыл репозиторий.

## 1. Слои

```
┌────────────────────────────────────────────────────────────────┐
│ UI: html/*.html + js/ui/*.js                                   │
│   popup.js · session.js · options.js · dom/hexview/toast/theme │
└───────────────▲──────────────────────────────┬─────────────────┘
                │ chrome.runtime.sendMessage    │ ES-модули
                │ (MESSAGE.*)                    │
┌───────────────┴──────────────────────────────▼─────────────────┐
│ Service worker: js/background.js                               │
│   alarms · очередь опроса · backoff · badge · notifications    │
└───────────────────────────────┬────────────────────────────────┘
                                │
┌───────────────────────────────▼────────────────────────────────┐
│ core/*.js — чистая логика, без DOM (кроме settings.js)         │
│   generator · crypto · poller · protocol · repository ...      │
└───────────────────────────────┬────────────────────────────────┘
                                │
┌───────────────────────────────▼────────────────────────────────┐
│ IndexedDB (session_manager_pro) · chrome.storage.local         │
└────────────────────────────────────────────────────────────────┘
```

Правило: **`core/` не обращается к DOM и не импортирует `ui/`**. Единственное
исключение — `core/settings.js`, который работает с `chrome.storage.local`.
Благодаря этому вся бизнес-логика тестируется в Node без браузера.

## 2. Поток опроса

1. `background.js` создаёт/обновляет `chrome.alarms` с периодом из настроек
   (`ensureAlarm`). Период не может быть меньше 30 секунд — ограничение Chrome.
2. По сигналу `alarms.onAlarm` задача попадает в последовательную очередь
   (`enqueue`), поэтому два цикла не перекрываются.
3. `pollSessions()` читает сессии с `active: true`, пропускает те, у которых
   `nextAttemptAt` в будущем (backoff), и опрашивает остальные с параллелизмом 3.
4. Для каждой сессии `pollSession()` (`core/poller.js`) выполняет `fetch` с
   таймаутом, разбирает ответ и возвращает список нормализованных логов.
5. `addLogs()` дедуплицирует записи по `fingerprint` (индекс в IndexedDB) и
   сохраняет их, крупные payload'ы уходят в gzip.
6. `trimLogs()` применяет лимит хранения, `recordPollResult()` обновляет
   `lastPollAt/lastStatus/lastError/errorCount/nextAttemptAt/interactionCount`.
7. При новых взаимодействиях обновляются бейдж и уведомление; открытые страницы
   получают сообщение `MESSAGE.LOGS_ADDED` и обновляют виджет.

Backoff: `min(2^errorCount, 300)` секунд, счётчик ошибок сбрасывается при успехе.

## 3. Сообщения UI ⇄ service worker

| Тип                       | Направление | Назначение                                      |
| ------------------------- | ----------- | ----------------------------------------------- |
| `poller:ensure`           | UI → SW     | Создать/выровнять alarm                         |
| `poller:sync`             | UI → SW     | Поставить цикл опроса в очередь                 |
| `poller:poll-one`         | UI → SW     | Опросить конкретную сессию немедленно           |
| `poller:test-interaction` | UI → SW     | Запросить собственный публичный URL (self-test) |
| `ui:clear-unread`         | UI → SW     | Сбросить бейдж непрочитанного                   |
| `sessions:updated`        | SW → UI     | Сессия изменилась                               |
| `logs:added`              | SW → UI     | Появились новые взаимодействия                  |
| `poller:finished`         | SW → UI     | Цикл опроса завершён                            |

Обработчик в `background.js` возвращает `true` из `onMessage`, чтобы ответить
асинхронно; ошибки отдаются как `{ ok: false, error }`.

## 4. Идентификаторы сессий

```
key (32 random bytes)
 └─ SHA-1 → big-endian int → base36 → padStart(30, "0") → первые 20 символов
      └─ 10 + checksum + 10 + checksum = correlation id (22 символа)
           └─ Vigenère-подобный rolling-шифр по base36 над
              `${cid}1g${counter.toString(16)}yz`
                └─ 3 случайных символа + шифртекст = label поддомена
```

Алгоритм побайтово совместим с reference-реализацией interactsh и с версией
1.3.3.7. Совместимость закреплена `tests/fixtures/golden.json`: векторы сняты
прогоном старого минифицированного бандла с детерминированным `Math.random`.
**Менять алгоритм нельзя** без миграции существующих сессий.

## 5. Хранилище

### IndexedDB: `session_manager_pro`, версия 2

| Хранилище  | keyPath | Индексы                                      |
| ---------- | ------- | -------------------------------------------- |
| `sessions` | `id`    | —                                            |
| `logs`     | `id`    | `sessionId`, `ts`, `protocol`, `fingerprint` |

Версия 2 добавляет только индекс `fingerprint`; апгрейд с v1 выполняется в
`onupgradeneeded` без потери данных.

Записи логов хранят сырые payload'ы в base64. Если поле длиннее 256 символов и
сжатие даёт выигрыш, оно заменяется на `*Zip` с `zipCodec: "gzip-base64-v1"` —
формат совпадает с v1, поэтому старые и новые сборки читают базу одинаково.

### chrome.storage.local

- `settings` — объект настроек (`core/settings.js`, `DEFAULT_SETTINGS`);
- `unread` — счётчик непрочитанных взаимодействий для бейджа;
- `lastNotifiedSessionId` — сессия для перехода по клику на уведомление.

## 6. Разбор ответов сервера

`core/poller.js` понимает два семейства форматов:

| Формат            | Признак                                                                                  | Маппинг                                               |
| ----------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Burp Collaborator | `{ "responses": [{ protocol, client, clientPort, time, data: { request, response } }] }` | `fromBurpResponse`                                    |
| interactsh        | `{ "data": ["<base64>", …] }`                                                            | `decodeInteractshEntry` → `fromInteractshInteraction` |

Ответ interactsh может быть зашифрован AES-256-CTR: ключ — `SHA-256(secret)`,
первые 16 байт payload'а — IV. Секрет задаётся в блоке «Дополнительно» на
странице сессии. Если расшифровать не удалось, запись сохраняется как есть, а
пользователь получает предупреждение.

## 7. Декодирование протоколов

`core/protocol.js`:

- `parseHttpMessage` — стартовая строка, заголовки, тело (запрос и ответ);
- `parseDnsQuery` — разбор wire-формата DNS-вопроса (QNAME/QTYPE);
- `parseSmtpDialog` — `MAIL FROM`, `RCPT TO`, `Subject`;
- `detectProtocol` — эвристика, если сервер не указал протокол;
- `describeInteraction` — поля для инспектора, hexdump, printable-строки;
- `quickSummary` — дешёвое описание для строки журнала.

## 8. UI

Страницы — обычные HTML + ES-модули, без бандлера и фреймворков.

- `js/theme-boot.js` — синхронный классический скрипт в `<head>`, ставит
  `data-theme` до первой отрисовки (иначе будет вспышка светлой темы).
- `js/ui/dom.js` — escape, форматирование дат/размеров, буфер обмена, download.
- `js/ui/hexview.js` — printable-просмотр с байтовыми подсказками, hexdump с
  offset'ами, список строк.
- `js/ui/modal.js` — promise-based подтверждение вместо `window.confirm`.
- `js/ui/toast.js` — неблокирующие уведомления.
- `js/ui/permissions.js` — запрос optional host permission для своих серверов.

Состояние страницы живёт в модульном объекте `state`; после каждого опроса
контроллер перерисовывает только нужные части (список, заголовок, журнал,
инспектор).

## 9. Тестирование

| Файл                       | Что покрывает                                                       |
| -------------------------- | ------------------------------------------------------------------- |
| `tests/generator.test.js`  | golden-векторы: correlation id, шифр, URL                           |
| `tests/encoding.test.js`   | base64/hex/hexdump/strings, большие payload'ы                       |
| `tests/models.test.js`     | нормализация, fingerprint, поиск, сортировка, backoff               |
| `tests/protocol.test.js`   | HTTP/DNS/SMTP-разбор, детект протокола                              |
| `tests/poller.test.js`     | форматы ответов, AES-CTR, таймауты, ошибки HTTP                     |
| `tests/repository.test.js` | IndexedDB через `fake-indexeddb`: CRUD, дедуп, trim, импорт/экспорт |
| `tests/report.test.js`     | Markdown-отчёт, экранирование, пустые данные                        |

Тесты запускаются `node --test` в одном процессе
(`--test-isolation=none`) — так они работают и в средах, где нельзя спавнить
дочерние процессы, и быстрее за счёт общего IndexedDB-контекста.

## 10. Точки расширения

- **Новый протокол** — добавьте ветку в `describeInteraction`/`quickSummary`
  и, при необходимости, тег в `PROTOCOLS`.
- **Новый сервер** — расширьте `parsePollPayload` (новый `shape`) и добавьте
  тест с реалистичным payload'ом.
- **Новая настройка** — `DEFAULT_SETTINGS`, `normalizeSettings`, разметка
  `options.html`, затем `bindSettings` в `options.js`.
- **Новое действие** — константа в `MESSAGE`, ветка в `handleMessage`
  (`background.js`) и вызов из UI.
