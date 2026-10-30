# План: локальное SQLite-хранилище и Docker

## Статус

Реализовано. Проверки: `npm run check`, `npm run build`, `docker compose build`, запуск контейнера и проверка `/api/health`, сохранение комнаты после перезапуска контейнера.

## Решения

- Хранилище: SQLite через встроенный `node:sqlite`.
- Node.js: 24+.
- Удалённый Upstash Redis: удалить полностью.
- Render: удалить полностью.
- TTL комнат: 72 часа.
- Данные: JSON-снимок комнаты в SQLite, без нормализации игроков и раундов.
- Контейнер: один сервис приложения, база — файл в Docker volume.
- `.env`: использовать встроенный `--env-file-if-exists=.env`; `dotenv` не добавлять, если флаг работает с `tsx watch`.

## Почему SQLite

- Данные небольшие, сложных запросов нет.
- SQLite даёт транзакции, WAL и восстановление после сбоев.
- Не нужен второй контейнер или внешний сервис.
- `node:sqlite` не добавляет зависимостей и работает в Alpine.
- JSON-файл проще, но слабее при сбоях и параллельных записях.
- LMDB, LevelDB, Redis, PGlite и WASM-варианты избыточны для этой задачи.

## Границы задачи

Входит:

- локальное хранение комнат в SQLite;
- удаление Upstash и Render;
- Docker-упаковка;
- обновление документации и тестов.

Не входит:

- горизонтальное масштабирование;
- миграция старых данных из Upstash;
- нормализованная схема комнат/игроков;
- админ-панель управления БД.

## Этапы

### 1. Слой хранения

Файлы:

- `server/roomStore.ts` — переписать;
- `server/roomStore.test.ts` — добавить.

Требования:

- Использовать `DatabaseSync` из `node:sqlite`.
- Путь БД: `ROOM_DB_PATH`, по умолчанию `./data/rooms.sqlite`.
- TTL: `ROOM_TTL_HOURS`, по умолчанию `72`.
- Создавать директорию для файла БД автоматически.
- Схема:
  ```sql
  CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY,
    snapshot TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  ```
- Включить:
  ```sql
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  ```
- `saveRooms()` выполняет замену актуального набора комнат в одной транзакции.
- `loadRooms()` удаляет записи старше TTL и возвращает расшифрованные snapshots.
- Битый snapshot не должен ронять сервер: запись пропускается с предупреждением.
- Добавить `close()` для закрытия соединения.
- API класса сохранить совместимым с текущими вызовами `loadRooms()` и `saveRooms()`.

Тесты:

- сохранение и загрузка комнат;
- удаление комнат, которых больше нет в snapshot;
- истечение TTL;
- повреждённый JSON в snapshot;
- повторное открытие существующего файла;
- работа с временной директорией или `:memory:`.

### 2. Интеграция с сервером

Файл: `server/index.ts`.

- Создавать `RoomStore` с путём и TTL из env.
- Загружать комнаты при старте, как сейчас.
- Добавить graceful shutdown по `SIGINT` и `SIGTERM`:
  - остановить HTTP-сервер;
  - очистить таймеры;
  - закрыть SQLite.
- При ошибке открытия БД завершаться с понятным сообщением.
- Убедиться, что `.env` загружается до чтения `process.env`.

### 3. Удаление Upstash и Render

- Удалить Upstash-код из `server/roomStore.ts`.
- Удалить `UPSTASH_REDIS_REST_URL` и `UPSTASH_REDIS_REST_TOKEN` из `.env.example`.
- Удалить `render.yaml`.
- Убрать Upstash/Render из `README.md` и `AGENTS.md`.
- Проверить отсутствие упоминаний:
  ```powershell
  rg -i "upstash|render"
  ```

### 4. Node.js и зависимости

- Добавить `"engines": { "node": ">=24" }` в `package.json`.
- Обновить `@types/node` до 24.
- Переместить `@vitejs/plugin-react` и `concurrently` в `devDependencies`.
- Обновить скрипты:
  ```json
  "dev:server": "tsx watch --env-file-if-exists=.env server/index.ts",
  "start": "node --env-file-if-exists=.env dist-server/index.js"
  ```
- Если `tsx watch` не пробрасывает флаг, добавить `dotenv` и импортировать его в `server/index.ts`.

### 5. Docker

Добавить:

- `Dockerfile`;
- `.dockerignore`;
- `compose.yaml`.

`Dockerfile`:

- multi-stage на `node:24-alpine`;
- build-stage: `npm ci`, `npm run build`;
- runtime: `npm ci --omit=dev`;
- копирование `dist`, `dist-server`, `package.json`;
- `NODE_ENV=production`, `PORT=3001`, `HOST=0.0.0.0`;
- директория `/app/data` с правами пользователя `node`;
- запуск `node dist-server/index.js`.

`compose.yaml`:

- один сервис приложения;
- порт `3001:3001`;
- volume `room-data:/app/data`;
- `ROOM_DB_PATH=/app/data/rooms.sqlite`;
- healthcheck на `/api/health`;
- `restart: unless-stopped`.

Пример запуска:

```powershell
Copy-Item .env.example .env
docker compose up --build
```

### 6. Конфигурация и документация

- `.env.example`:
  ```env
  ROOM_DB_PATH=./data/rooms.sqlite
  ROOM_TTL_HOURS=72
  ```
- Добавить отсутствующие `AUDIO_DELIVERY_MODE` и `ROUND_AUDIO_WARMUP_MS`, если они ещё не добавлены.
- `.gitignore`: добавить `data/`.
- `README.md`:
  - локальное SQLite-хранилище;
  - путь к БД и TTL;
  - Docker-запуск;
  - volume и бэкап;
  - ограничение: один экземпляр приложения.
- `AGENTS.md`:
  - актуальная структура проекта;
  - команды Docker;
  - путь к данным;
  - запрет коммитить `data/`;
  - обновлённые требования к Node.

### 7. Проверка

Обязательные команды:

```powershell
npm run check
npm run build
```

Docker-проверка:

```powershell
docker compose build
docker compose up -d
docker compose ps
```

Сценарии:

- `/api/health` возвращает `{ ok: true }`.
- UI открывается на `http://127.0.0.1:3001`.
- Комната создаётся.
- После `docker compose restart` комната восстанавливается.
- `docker compose down` сохраняет данные.
- `docker compose down -v` очищает данные.
- Приложение работает без Upstash и Render.
- `rg -i "upstash|render"` не находит зависимостей.

## Риски

- `node:sqlite` имеет статус Release Candidate. Снижение риска: зафиксировать Node 24 в Docker и `engines`.
- SQLite рассчитан на один экземпляр приложения. Для текущей задачи это приемлемо.
- WAL создаёт рядом с БД файлы `-wal` и `-shm`; бэкап делать после остановки контейнера или через SQLite backup API.
- При bind mount на Linux возможны проблемы с правами; предпочтителен named volume.
- Если `tsx watch` не поддерживает `--env-file-if-exists`, используем `dotenv` как fallback.

## Критерии готовности

- `npm run check` проходит без ошибок.
- `npm run build` проходит.
- `docker compose up --build` запускает приложение без внешних сервисов.
- Данные комнат сохраняются между перезапусками контейнера.
- Upstash и Render полностью удалены из кода и документации.
- TTL комнат составляет 72 часа.
