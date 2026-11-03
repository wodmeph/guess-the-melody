# Guess the Melody

Real-time web party game for guessing music in shared rooms. The server builds rounds from Yandex Music sources, synchronizes playback through Socket.IO, scores players by speed, and shows live events, round analytics, and a final podium.

## Features

- Rooms without registration, joinable by code or link.
- Separate main, display, and player views:
  - `/room/<CODE>` — normal game view.
  - `/room/<CODE>/display` — shared screen or TV.
  - `/room/<CODE>/player` — compact phone controller.
- Built-in Yandex Music themes plus custom playlists, albums, and artists.
- Multiple sources can be mixed in one game.
- Answer modes: track title, artist, or mixed.
- Win conditions: number of rounds or target score.
- Easy and hard audio modes with configurable timers.
- Optional answer changes with a score penalty.
- Automatic transition between rounds or manual host control.
- Host kick with confirmation, including during a game.
- Disconnected players remain visible until removed or the room is reset.
- Safe live achievements during a question and result achievements after reveal.
- Answer-change journey with correct/wrong coloring.
- Correct-answer streaks, animated ranking movement, position history graphs, and geometric avatars.
- Round drama cards: new leader, biggest fall, and most indecisive player.
- Responsive final screen with a compact Full HD layout and expandable ranking.

## Revansh Mode

Revansh is an optional comeback mode:

- Players earn energy for correct answers.
- A large unique lead automatically sends a Jammer to the leader.
- Jammer hides two answer slots from the leader.
- The leader can spend energy on Countermeasure and predict one hidden slot.
- A successful prediction reveals one slot and returns energy.
- Chasing players can spend energy on Timecut, reducing the leader's answer time by half, with a minimum of five seconds.
- The last-place correct-answer boost can award a score multiplier.
- Attacks are visualized in the ranking with animated effects.

## Tech Stack

- React 19
- Vite
- TypeScript
- Express
- Socket.IO
- SQLite via `node:sqlite`
- Vitest
- Docker

## Local Development

Requirements:

- Node.js 24 or newer.
- npm.

Install dependencies:

```powershell
npm.cmd install
```

Copy `.env.example` to `.env` and adjust it if needed:

```powershell
Copy-Item .env.example .env
```

Start the Vite client and API server:

```powershell
npm.cmd run dev
```

Open:

```text
http://127.0.0.1:5173
```

Rooms are stored locally in SQLite at `ROOM_DB_PATH` (default `./data/rooms.sqlite`). The `data/` directory is ignored by Git.

## Docker

Build and start the application with a persistent local database:

```powershell
Copy-Item .env.example .env
docker compose up --build
```

Open:

```text
http://127.0.0.1:3001
```

Room data is kept in the `room-data` volume mounted at `/app/data`. `docker compose down` keeps the data; `docker compose down -v` removes it.

The container runs the compiled Express server, which serves both the API and the built frontend from `dist`.

## One-Command Linux Install

`install.sh` performs a complete production deployment on Debian or Ubuntu: it installs Docker Compose v2 and Caddy after confirmation, clones the project, starts the Docker Compose container, and configures Caddy with automatic HTTPS. `git` and `curl` must be installed in advance.

```bash
curl -fsSL <RAW_URL>/install.sh | REPO_URL=https://github.com/<owner>/<repo>.git bash
```

`<RAW_URL>` is the raw base URL that serves repository files as plain text (for example `https://raw.githubusercontent.com/<owner>/<repo>/main`). `REPO_URL` must be set to the clone URL of the repository itself, not to a GitHub HTML page. All placeholders (`<RAW_URL>`, `<owner>`, `<repo>`) must be replaced before running the command.

`REPO_URL` is required when the installation directory is missing or empty, because the installer clones the project into it; when the directory already contains a clone of the project, `REPO_URL` is optional. `REPO_REF` selects the branch or tag and defaults to `main`. The installer requires root privileges and asks for the `sudo` password once when needed.

### Supported Systems

Debian and Ubuntu with `systemd` and `apt` are supported. On any other distribution the installer stops with an explanatory message.

### Requirements and Automatic Installation

The installer needs:

- `git` and `curl` (must be installed in advance);
- Docker with Compose v2 (`docker compose`);
- Caddy.

If Docker with Compose v2 or Caddy is missing, the installer offers to install it from the official repositories and asks for confirmation before making changes.

### Interactive Prompts

| Prompt | Environment variable | Default | Notes |
| --- | --- | --- | --- |
| Game domain | `DOMAIN` | — | Hostname without scheme, for example `melody.example.com`. Required. |
| ACME e-mail | `ACME_EMAIL` | — | Let's Encrypt account e-mail. Required. |
| Application port | `APP_HOST_PORT` | `3001` | Bound to `127.0.0.1`; the installer suggests a free port if the chosen one is busy. |
| Yandex Music token | `YANDEX_MUSIC_TOKEN` | empty | Optional, hidden input. An empty answer keeps the token already stored in `.env` on re-runs. |
| Audio delivery mode | `AUDIO_DELIVERY_MODE` | `direct` | `direct` or `cache`. |

For non-interactive runs (for example in CI) the same values are read from the `DOMAIN`, `ACME_EMAIL`, `APP_HOST_PORT`, `YANDEX_MUSIC_TOKEN`, and `AUDIO_DELIVERY_MODE` environment variables. `DOMAIN` is always mandatory. `ACME_EMAIL` is mandatory unless it is set in the environment or already present in the existing `.env`; otherwise it is reused from there, as is `APP_HOST_PORT` (which falls back to `3001`). A busy `APP_HOST_PORT` aborts the installation with an error.

### What the Installer Does

1. Clones the repository into `INSTALL_DIR` (default `/opt/guess-the-melody`) and checks out `REPO_REF`. If `/opt/guess-the-melody` already belongs to an instance with another domain, the installer automatically chooses `/opt/guess-the-melody-<slug>` and a derived Compose project name; setting `INSTALL_DIR` or `COMPOSE_PROJECT_NAME` manually only overrides this choice.
2. Generates `.env` with mode `600`, including `CLIENT_ORIGIN`, `APP_HOST_PORT`, `APP_DOMAIN`, `ACME_EMAIL`, `COMPOSE_PROJECT_NAME`, and the audio settings.
3. Builds and starts the container with `docker compose up -d --build`.
4. Waits for the container healthcheck and verifies `http://127.0.0.1:<port>/api/health`.

### Caddy and HTTPS

The installer writes a dedicated site file for the domain into `/etc/caddy/conf.d` (`<domain>.caddy`, with dots replaced by underscores, for example `melody_example_com.caddy`). The file proxies requests with `reverse_proxy 127.0.0.1:<port>` and sets the ACME e-mail for Let's Encrypt. It then adds the marker line `# guess-the-melody managed` and the line `import /etc/caddy/conf.d/*` to the main Caddyfile `/etc/caddy/Caddyfile` (a backup is made first; all backups are stored in `/var/backups/caddy-guess-the-melody`), runs `caddy validate`, and reloads the service with `systemctl reload caddy`. The HTTPS certificate is issued automatically.

Other than the single marker line and the `import /etc/caddy/conf.d/*` line in the main Caddyfile, the installer does not change any configuration outside `/etc/caddy/conf.d`; unrelated sites on the host are left untouched.

If the domain is already declared in the main Caddyfile or in another file in `/etc/caddy/conf.d`, the installer stops with a non-zero exit code before changing any Caddy configuration. By that point the `.env` file and the container are already prepared. Re-running with another domain or a separate `INSTALL_DIR` works without manual cleanup. This conflict check covers only the main Caddyfile and the `conf.d` directory.

The domain's DNS record must point to the server, and ports 80 and 443 must be reachable from the outside. The Let's Encrypt certificate is not issued instantly and may take several minutes.

### Re-running and Updating

Running the installer again is idempotent: it updates the code with `git fetch`, preserves the existing `.env` while updating the keys related to the installer answers, keeps the `room-data` volume, and rewrites the Caddy block. To change the domain of an existing installation, set `ALLOW_DOMAIN_CHANGE=1`. To host several instances on one machine, use different `INSTALL_DIR` and `COMPOSE_PROJECT_NAME` values.

Application variables such as audio cache tuning and room retention are described in [Environment Variables](#environment-variables).

## Production Without Docker

Build the client and server:

```powershell
npm.cmd run build
```

Start the compiled Express server:

```powershell
npm.cmd start
```

The production server serves both the API and the built frontend from `dist`.

Default URL:

```text
http://127.0.0.1:3001
```

The host must support WebSocket connections. Set `PORT` only when the platform does not provide it automatically. Use a persistent filesystem for `ROOM_DB_PATH`; SQLite is intended for a single application instance.

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3001` | HTTP server port. |
| `HOST` | `0.0.0.0` | HTTP bind address. |
| `CLIENT_ORIGIN` | `http://127.0.0.1:5173` in development | Allowed Socket.IO and CORS origin. Production defaults to accepting the serving origin. |
| `ROOM_DB_PATH` | `./data/rooms.sqlite` | SQLite database file for room snapshots. |
| `ROOM_TTL_HOURS` | `72` | How long inactive room snapshots are kept. |
| `YANDEX_MUSIC_TOKEN` | empty | Optional Yandex Music account token for requests that require it. |
| `YANDEX_MUSIC_USE_DEMO` | `false` | Use demo tracks instead of external Yandex sources. |
| `YANDEX_MUSIC_ALLOW_FULL_TRACK_FALLBACK` | `false` | Allow full-track fallback when a preview is unavailable. |
| `AUDIO_DELIVERY_MODE` | `direct` | `direct` sends Yandex audio URLs to clients; `cache` downloads audio to the game server first. |
| `AUDIO_CACHE_MAX_BYTES` | `8000000` | Maximum size of one clipped cached audio file. |
| `AUDIO_CACHE_LOOKAHEAD` | `2` | In `cache` mode, how many future tracks are kept ready besides the current track. `0` prefetches only the next track after the current round starts. |
| `ROUND_AUDIO_WARMUP_MS` | `1750` for direct, `750` for cache | Delay before a round starts, allowing clients to prepare audio. |

Room snapshots are stored in SQLite and restored after a server restart. Unfinished matches return to the lobby.

## Audio Delivery

### Direct mode

```text
AUDIO_DELIVERY_MODE=direct
```

Clients load audio directly from the upstream Yandex URL. This reduces server bandwidth but makes playback dependent on each player's network path to Yandex.

### Cache mode

```text
AUDIO_DELIVERY_MODE=cache
```

The server downloads playable audio ahead of a game and serves it through `/api/audio/:id`. This gives all players the same host and can help when individual networks have trouble reaching Yandex, but it increases server bandwidth and memory usage.

Cache mode accepts only MP3. Non-MP3 sources are skipped and the next candidate is tried. The server keeps a bounded window of prepared tracks instead of the whole pool:

- before a round, it caches the current track plus `AUDIO_CACHE_LOOKAHEAD` future tracks;
- after a round starts, it prefetches another future track in the background;
- the current track stays available until the result screen appears, then it is released;
- a finished or reset game clears the room window and cache.

Each cached track is clipped to the question duration (`questionDurationMs`, at most 30 seconds) on MP3 frame boundaries. No transcoding is performed. When the upstream supports streaming, the server stops reading as soon as enough frames arrive; otherwise it downloads the response and discards the extra data. `AUDIO_CACHE_MAX_BYTES` limits the already-clipped file.

The cache:

- accepts only HTTPS upstream URLs;
- supports HTTP range requests;
- deduplicates identical upstream audio and concurrent downloads;
- re-caches a track when a longer clip is requested;
- removes room references when a room is cleared.

Peak memory per room is approximately `(AUDIO_CACHE_LOOKAHEAD + 2) × <clipped file size>`. A 10-second MP3 at 320 kbit/s is about 400 KB; 30 seconds is about 1.2 MB.

## Supported Yandex Music Sources

- User playlist:
  `https://music.yandex.ru/users/<user>/playlists/<id>`
- Public playlist:
  `https://music.yandex.ru/playlists/<uuid>`
- Album:
  `https://music.yandex.ru/album/<id>`
- Artist:
  `https://music.yandex.ru/artist/<id>`
  or `https://music.yandex.ru/artist/<id>/tracks`

Up to ten custom sources can be normalized for one room. The server mixes source candidates, prepares playable tracks, and separately builds a larger answer-option pool.

## Game Flow

1. A player creates a room and becomes host.
2. Other players join through the room code, normal link, or phone view.
3. The host selects music sources and game settings.
4. The server prepares playable audio and answer candidates.
5. Each round starts after a short synchronized warmup.
6. Players choose an answer; selected option details and correctness stay hidden until reveal.
7. The result screen shows the track, points, answer journey, achievements, ranking changes, and round drama.
8. The game ends at the configured round count or target score.
9. The final screen shows the podium, up to eight ranking rows by default, match moments, and expandable remaining players.

## API and Diagnostics

- `GET /api/health` — server health.
- `GET /api/themes` — built-in themes.
- `GET /api/music/playlists/search?q=<query>&page=0&limit=10` — playlist search.
- `GET /api/music/diagnostics` — music provider status and active audio delivery mode.
- `GET /api/music/probe?difficulty=easy&limit=5` — test playable Yandex audio.
- `GET /api/audio/:id` — cached audio endpoint when cache mode is enabled.

Run the trailer probe from the command line:

```powershell
npm.cmd run probe:trailers
```

For browser-side audio problems, capture the Network tab or a HAR file and inspect:

- response status and timing for the audio request;
- whether range requests return `206 Partial Content`;
- stalled or cancelled requests;
- the active mode returned by `/api/music/diagnostics`;
- browser autoplay errors shown by the in-game retry notice.

## Tests and Verification

Run type checks, lint, and all tests:

```powershell
npm.cmd run check
```

Or run them separately:

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
```

Run the full production build:

```powershell
npm.cmd run build
```

## Repository Layout

```text
src/
  main.tsx                 React application and Socket.IO client
  styles.css               responsive UI and animations
  audioScheduling.ts       synchronized browser audio startup
  answerJourney.ts         answer-change presentation
  finalStageLayout.ts      final ranking visibility rules
  rankingVisuals.ts        avatars and attack visualization data
server/
  index.ts                 Express routes, Socket.IO events, timers
  game.ts                  rooms, scoring, Revansh, achievements
  types.ts                 shared server domain types
  music.ts                 Yandex Music loading and source parsing
  audioDelivery.ts         direct/cache delivery selection
  audioCache.ts            in-memory audio cache and range responses
  audioWindow.ts           bounded cache window state and prefetching
  mp3Clip.ts               MP3 frame parsing, clipping, and streaming download
  roomStore.ts             local SQLite room persistence
  roundPlanning.ts         track-pool and synchronized-start planning
scripts/
  probe-yandex-trailers.ts
  write-server-package.cjs
Dockerfile                 multi-stage production image
compose.yaml               single-container app with a data volume
```

## Operational Notes

- Browser autoplay rules may block the first audio start; use the in-game retry control.
- Direct Yandex URLs can behave differently across providers, VPNs, or corporate networks.
- Cache mode is useful for network consistency but must be sized for the host's memory and outbound traffic limits.
- A restarted server cannot restore prepared audio pools. Persisted rooms are restored safely, but unfinished matches return to the lobby.
- SQLite is intended for a single application instance. Do not run multiple replicas against the same database file.
- Back up `rooms.sqlite` and its `-wal`/`-shm` files while the server is stopped, or use the SQLite backup API.
- Never commit `YANDEX_MUSIC_TOKEN` or the local `data/` directory.
