# AGENTS.md

Instructions for coding agents working in this repository.

## Project

Real-time multiplayer music guessing game. The Express/Socket.IO server is authoritative: it owns rooms, rounds, scoring, timers, achievements, and Revansh state. The React client renders the main, TV display, and phone controller views.

## Setup

Requirements: Node.js 24+ and npm.

```powershell
npm ci
Copy-Item .env.example .env
```

`.env` is optional for basic work, but the server reads it for ports, CORS, Yandex Music, audio delivery, and the local SQLite database. The scripts use Node's built-in `--env-file-if-exists=.env`. Never commit `.env`, the `data/` directory, or tokens.

## Commands

```powershell
npm run dev          # client (127.0.0.1:5173) + API server (3001)
npm run dev:server   # server only, tsx watch
npm run dev:client   # Vite client only
npm run typecheck    # tsc --noEmit
npm run lint         # ESLint
npm run lint:fix     # ESLint with autofix
npm test             # Vitest, all tests once
npm run check        # typecheck + lint + tests
npm run build        # typecheck + client build + server build
npm start            # run compiled server from dist-server
npm run probe:trailers
docker compose up --build
docker compose down
```

Windows PowerShell may require `npm.cmd` instead of `npm` if script execution is restricted.

The Vite dev server proxies `/api` and `/socket.io` to `http://127.0.0.1:3001`.

## Verification

Run these before finishing a change:

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

`npm run lint` currently has a small number of pre-existing warnings (hook dependency arrays and unused symbols). The lint command must finish with zero errors; do not add new warnings. Do not edit `dist/`, `dist-server/`, or `node_modules/`.

For storage or container changes, also run:

```powershell
docker compose build
docker compose up -d
# check http://127.0.0.1:3001/api/health
docker compose down
```

Use `docker compose down -v` only when you intend to delete the local room database.

## Repository Structure

```text
src/
  main.tsx                 React app, routing, Socket.IO client, all screens
  styles.css               all UI styles, layout, and animations
  audioScheduling.ts       browser audio start/sync helpers
  answerJourney.ts         answer-change journey presentation
  comebackPresentation.ts  Revansh/ranking attack presentation
  finalStageLayout.ts      final screen visibility rules
  playerActions.ts         host/player action availability rules
  rankingVisuals.ts        geometric avatars and ranking attacks
  starfield.tsx            background starfield
  *.test.ts                colocated Vitest unit tests

server/
  index.ts                 Express routes, Socket.IO events, timers, orchestration
  game.ts                  GameEngine: rooms, players, rounds, scoring, Revansh
  types.ts                 server domain types
  music.ts                 Yandex Music sources, themes, search, probing
  audioDelivery.ts         direct vs cache audio delivery selection
  audioCache.ts            in-memory audio cache and range responses
  roomStore.ts             local SQLite room persistence
  roundPlanning.ts         track-pool limits and synchronized round start
  *.test.ts                colocated Vitest unit tests

scripts/
  probe-yandex-trailers.ts CLI probe for playable Yandex audio
  write-server-package.cjs marks dist-server as CommonJS

public/                    favicon and local fonts
Dockerfile                 multi-stage production image
compose.yaml               single-container app with a data volume
vite.config.ts             Vite dev server and API/WebSocket proxy
tsconfig.json              client/server/scripts typecheck (no emit)
tsconfig.server.json       CommonJS server build into dist-server
eslint.config.js           ESLint flat config
```

## Architecture Notes

- `server/game.ts` contains the game rules. Keep transport concerns out of it.
- `server/index.ts` owns Express routes, Socket.IO events, in-memory room maps, and timers. Add new client commands here.
- Client-to-server commands currently include `create_room`, `create_display_room`, `join_room`, `view_room`, `update_settings`, `start_game`, `submit_answer`, `next_round`, `set_auto_next_round`, `reset_game`, `reset_display_game`, `kick_player`, `leave_room`.
- Server-to-client events currently include `room_state`, `round_started`, `round_result`, `answer_received`, `kicked`.
- UI routes: `/room/<CODE>` (normal), `/room/<CODE>/display` (TV), `/room/<CODE>/player` (phone).
- REST endpoints: `/api/health`, `/api/themes`, `/api/music/playlists/search`, `/api/music/diagnostics`, `/api/music/probe`, `/api/audio/:id`.
- Audio can be delivered directly from Yandex URLs or through the server cache. Changing delivery affects warmup timing and playback behavior.
- Rooms are persisted in SQLite at `ROOM_DB_PATH` (default `./data/rooms.sqlite`) and restored after restart; unfinished matches return to the lobby. SQLite is for a single application instance.

## Change Guidelines

- Prefer the smallest change in the owning module; keep `main.tsx` edits focused because it is very large.
- Put reusable pure logic into the small `src/` or `server/` helper modules and add colocated tests.
- Preserve the existing public room shape and Socket.IO event names unless the change explicitly requires a protocol update.
- TypeScript is strict. Avoid `any`; use concrete types or `unknown` with validation.
- Source is ESM. The server build is CommonJS (`tsconfig.server.json`), so do not introduce top-level `await` in `server/` code.
- Keep user-facing text in Russian and preserve the existing UI style.
- Do not add comments unless they explain non-obvious behavior.
- Secrets and Yandex credentials must stay out of source and commits. Do not commit `data/` or SQLite files.

## Tests

Vitest tests live next to the code they cover. Add or update tests for scoring, round planning, audio behavior, and extracted UI helpers. Run a focused test with:

```powershell
npx vitest run path/to/file.test.ts
```
