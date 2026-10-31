import cors from 'cors';
import express from 'express';
import { createServer } from 'node:http';
import path from 'node:path';
import { Server } from 'socket.io';
import { AudioCache } from './audioCache';
import { prepareTrackAudio, resolveAudioDeliveryMode } from './audioDelivery';
import { AudioWindowState, fillAudioWindow } from './audioWindow';
import { GameEngine } from './game';
import { MusicService } from './music';
import { RoomStore } from './roomStore';
import { finalizeRoundStart, planRoundStart, planTrackPoolLimits } from './roundPlanning';
import type { RoomSettings, Track, TrackMetadata } from './types';

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? '0.0.0.0';
const configuredClientOrigin = process.env.CLIENT_ORIGIN?.trim();
const clientOrigin = configuredClientOrigin || (process.env.NODE_ENV === 'production' ? true : 'http://127.0.0.1:5173');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: clientOrigin,
    methods: ['GET', 'POST']
  }
});
const audioCacheMaxBytes = parsePositiveInteger(process.env.AUDIO_CACHE_MAX_BYTES, 8_000_000);
const audioCacheLookahead = Math.min(parseNonNegativeInteger(process.env.AUDIO_CACHE_LOOKAHEAD, 2), 20);
const audioDeliveryMode = resolveAudioDeliveryMode();
const roundAudioWarmupMs = parseNonNegativeInteger(process.env.ROUND_AUDIO_WARMUP_MS, audioDeliveryMode === 'direct' ? 1_750 : 750);

const engine = new GameEngine();
const music = new MusicService();
const audioCache = new AudioCache({ maxBytes: audioCacheMaxBytes });
const roomStore = new RoomStore();
const roomTracks = new Map<string, Track[]>();
const roomOptionTracks = new Map<string, TrackMetadata[]>();
const roomAudioWindows = new Map<string, AudioWindowState>();
const roomAudioRefillJobs = new Map<string, Promise<void>>();
const roomAbortControllers = new Map<string, AbortController>();
const roundTimers = new Map<string, NodeJS.Timeout>();
const nextRoundTimers = new Map<string, NodeJS.Timeout>();
const roomPoolLoadTokens = new Map<string, number>();
const socketPlayers = new Map<string, { roomCode: string; playerId: string }>();
const playerSockets = new Map<string, Set<string>>();
const disconnectGraceTimers = new Map<string, NodeJS.Timeout>();
const dirtyRoomCodes = new Set<string>();
const roomLastActivity = new Map<string, number>();
let roomSweepTimer: NodeJS.Timeout | undefined;

const DISCONNECT_GRACE_MS = 8_000;
const PERSISTENCE_DEBOUNCE_MS = 400;

app.use(cors({ origin: clientOrigin }));
app.use(express.json({ limit: '16kb' }));

app.get('/api/health', (_request, response) => {
  response.json({ data: { ok: true } });
});

app.get('/api/themes', (_request, response) => {
  response.json({ data: music.getThemes() });
});

app.get('/api/music/playlists/search', async (request, response) => {
  const query = typeof request.query.q === 'string' ? request.query.q : '';
  const page = clampPage(Number(request.query.page));
  const limit = clampProbeLimit(Number(request.query.limit));
  try {
    const results = await music.searchPlaylists(query, page, limit);
    response.json({ data: { query: query.trim(), page, results } });
  } catch (error) {
    response.status(502).json({ error: toClientError(error) });
  }
});

app.get('/api/music/diagnostics', (_request, response) => {
  response.json({ data: { ...music.diagnostics(), audioDeliveryMode } });
});

app.get('/api/music/probe', async (request, response) => {
  const difficulty = request.query.difficulty === 'hard' ? 'hard' : 'easy';
  const limit = clampProbeLimit(Number(request.query.limit));
  try {
    const results = await music.probe(limit, difficulty);
    response.json({
      data: {
        difficulty,
        results: results.map(({ id, title, hasAudio, isSmartPreview }) => ({
          id,
          title,
          hasAudio,
          isSmartPreview
        }))
      }
    });
  } catch (error) {
    response.status(502).json({ error: toClientError(error) });
  }
});

app.get('/api/audio/:id', (request, response) => {
  const id = request.params.id;
  if (!/^[a-f0-9-]{36}$/i.test(id)) {
    response.status(404).end();
    return;
  }

  const cached = audioCache.read(id, request.headers.range);
  if (!cached) {
    response.status(404).end();
    return;
  }

  response.status(cached.status).set(cached.headers).set('ETag', `"${id}"`).send(cached.body);
});

app.use(express.static(path.join(process.cwd(), 'dist')));
app.get(/^\/(?!api).*/, (_request, response) => {
  response.sendFile(path.join(process.cwd(), 'dist', 'index.html'));
});

io.on('connection', (socket) => {
  socket.on('create_room', async ({ playerId, playerName }: { playerId: string; playerName: string }, callback) => {
    try {
      const room = engine.createRoom({ playerId, playerName });
      socket.join(playerId);
      socket.join(room.code);
      bindSocketPlayer(socket.id, room.code, playerId);
      markRoomDirty(room.code);
      await flushPersistence();
      callback?.({ data: room });
      io.to(room.code).emit('room_state', room);
    } catch (error) {
      callback?.({ error: toClientError(error) });
    }
  });

  socket.on('create_display_room', async (_payload, callback) => {
    try {
      const room = engine.createDisplayRoom();
      socket.join(room.code);
      markRoomDirty(room.code);
      callback?.({ data: room });
      io.to(room.code).emit('room_state', room);
    } catch (error) {
      callback?.({ error: toClientError(error) });
    }
  });

  socket.on('join_room', async ({ code, playerId, playerName }: { code: string; playerId: string; playerName: string }, callback) => {
    try {
      const room = engine.joinRoom(code.toUpperCase(), { playerId, playerName });
      socket.join(playerId);
      socket.join(room.code);
      bindSocketPlayer(socket.id, room.code, playerId);
      markRoomDirty(room.code);
      await flushPersistence();
      callback?.({ data: room });
      io.to(room.code).emit('room_state', room);
    } catch (error) {
      callback?.({ error: toClientError(error) });
    }
  });

  socket.on('view_room', ({ code }: { code: string }, callback) => {
    try {
      const room = engine.getPublicRoom(code.toUpperCase());
      roomLastActivity.set(room.code, Date.now());
      socket.join(room.code);
      callback?.({ data: room });
    } catch (error) {
      callback?.({ error: toClientError(error) });
    }
  });

  socket.on('update_settings', async ({ code, playerId, settings }: { code: string; playerId: string; settings: unknown }, callback) => {
    try {
      requireSocketPlayer(socket.id, code, playerId);
      engine.assertHost(code, playerId);
      const room = engine.updateSettings(code, parseSettings(settings));
      markRoomDirty(room.code);
      callback?.({ data: room });
      io.to(room.code).emit('room_state', room);
    } catch (error) {
      callback?.({ error: toClientError(error) });
    }
  });

  socket.on('start_game', async ({ code, playerId }: { code: string; playerId: string }, callback) => {
    let markedPreparing = false;
    try {
      requireSocketPlayer(socket.id, code, playerId);
      engine.assertHost(code, playerId);
      const preparingRoom = engine.markPreparing(code);
      markedPreparing = true;
      resetRoomRuntimeState(preparingRoom.code);
      markRoomDirty(preparingRoom.code);
      await flushPersistence();
      io.to(preparingRoom.code).emit('room_state', preparingRoom);

      const plannedRounds = preparingRoom.settings.winCondition === 'score' ? estimateRoundsForScore(preparingRoom.settings.targetScore) : preparingRoom.settings.rounds;
      const source = {
        themeIds: preparingRoom.settings.themeIds,
        playlistSources: preparingRoom.settings.playlistSources,
        playlistUrls: preparingRoom.settings.playlistUrls,
        playlistUrl: preparingRoom.settings.playlistUrl,
        difficulty: preparingRoom.settings.difficulty
      };
      const trackPoolPlan = planTrackPoolLimits(plannedRounds);
      const loadToken = nextPoolLoadToken(preparingRoom.code);
      const pool = await music.prepareTrackPool(
        source,
        {
          playableLimit: trackPoolPlan.initialPlayableLimit,
          optionLimit: trackPoolPlan.initialOptionLimit
        }
      );
      if (roomPoolLoadTokens.get(preparingRoom.code) !== loadToken) {
        throw new Error('Game start was cancelled');
      }
      audioCache.clearRoom(preparingRoom.code);
      resetRoomAudioState(preparingRoom.code);
      const playableTracks =
        audioDeliveryMode === 'cache' ? pool.playableTracks : await prepareRoomTrackAudio(preparingRoom.code, pool.playableTracks);
      if (roomPoolLoadTokens.get(preparingRoom.code) !== loadToken) {
        throw new Error('Game start was cancelled');
      }
      roomTracks.set(preparingRoom.code, shuffle(playableTracks));
      roomOptionTracks.set(preparingRoom.code, shuffle(pool.optionTracks));
      const startedRoom = await startRound(preparingRoom.code);
      if (trackPoolPlan.shouldLoadInBackground) {
        void hydrateRoomTrackPool(preparingRoom.code, loadToken, source, plannedRounds);
      }
      callback?.({ data: startedRoom });
    } catch (error) {
      if (markedPreparing) {
        await rollbackPreparingRoom(code);
      }
      callback?.({ error: toClientError(error) });
    }
  });

  socket.on('submit_answer', async ({ code, playerId, optionId }: { code: string; playerId: string; optionId: string }, callback) => {
    try {
      requireSocketPlayer(socket.id, code, playerId);
      const result = engine.submitAnswer(code, playerId, optionId);
      const room = engine.getPublicRoom(code);
      markRoomDirty(room.code);
      callback?.({ data: { optionId: result.optionId } });
      io.to(room.code).emit('room_state', room);
    } catch (error) {
      callback?.({ error: toClientError(error) });
    }
  });

  socket.on(
    'activate_comeback_ability',
    async ({ code, playerId, ability, counterPrediction }: { code: string; playerId: string; ability?: 'jammer' | 'counter' | 'timecut'; counterPrediction?: number }, callback) => {
      try {
        requireSocketPlayer(socket.id, code, playerId);
        const room = engine.activateComebackAbility(code, playerId, ability, counterPrediction);
        markRoomDirty(room.code);
        callback?.({ data: room });
        io.to(room.code).emit('room_state', room);
      } catch (error) {
        callback?.({ error: toClientError(error) });
      }
    }
  );

  socket.on('kick_player', async ({ code, hostPlayerId, targetPlayerId }: { code: string; hostPlayerId: string; targetPlayerId: string }, callback) => {
    try {
      requireSocketPlayer(socket.id, code, hostPlayerId);
      const room = engine.kickPlayer(code, hostPlayerId, targetPlayerId);
      markRoomDirty(room.code);
      callback?.({ data: room });
      io.to(targetPlayerId).emit('kicked', { message: 'Хост удалил вас из комнаты' });
      io.to(room.code).emit('room_state', room);
    } catch (error) {
      callback?.({ error: toClientError(error) });
    }
  });

  socket.on('leave_room', async ({ code, playerId }: { code: string; playerId: string }, callback) => {
    try {
      requireSocketPlayer(socket.id, code, playerId);
      const result = engine.leaveRoom(code, playerId);
      socket.leave(code.toUpperCase());
      unbindSocketPlayer(socket.id);
      callback?.({ data: null });
      if (result.room) {
        markRoomDirty(result.room.code);
        await flushPersistence();
        io.to(result.room.code).emit('room_state', result.room);
      } else if (result.deletedRoomCode) {
        disposeRoom(result.deletedRoomCode);
      }
    } catch (error) {
      callback?.({ error: toClientError(error) });
    }
  });

  socket.on('next_round', async ({ code, playerId }: { code: string; playerId: string }, callback) => {
    try {
      requireSocketPlayer(socket.id, code, playerId);
      engine.assertHost(code, playerId);
      const room = await startRound(code);
      callback?.({ data: room });
    } catch (error) {
      callback?.({ error: toClientError(error) });
    }
  });

  socket.on('set_auto_next_round', async ({ code, playerId, enabled }: { code: string; playerId: string; enabled: boolean }, callback) => {
    try {
      requireSocketPlayer(socket.id, code, playerId);
      engine.assertHost(code, playerId);
      const room = engine.setAutoNextRound(code, enabled);
      if (enabled) {
        scheduleNextRound(room.code);
      } else {
        clearNextRoundTimer(room.code);
      }
      markRoomDirty(room.code);
      callback?.({ data: room });
      io.to(room.code).emit('room_state', room);
    } catch (error) {
      callback?.({ error: toClientError(error) });
    }
  });

  socket.on('reset_game', async ({ code, playerId }: { code: string; playerId: string }, callback) => {
    try {
      requireSocketPlayer(socket.id, code, playerId);
      engine.assertHost(code, playerId);
      const room = await resetRoomToLobby(code);
      callback?.({ data: room });
      io.to(room.code).emit('room_state', room);
    } catch (error) {
      callback?.({ error: toClientError(error) });
    }
  });

  socket.on('reset_display_game', async ({ code }: { code: string }, callback) => {
    try {
      const room = engine.getPublicRoom(code.toUpperCase());
      if (room.status !== 'finished') {
        throw new Error('Display can reset only after the game is finished');
      }
      const nextRoom = await resetRoomToLobby(room.code);
      callback?.({ data: nextRoom });
      io.to(nextRoom.code).emit('room_state', nextRoom);
    } catch (error) {
      callback?.({ error: toClientError(error) });
    }
  });

  socket.on('disconnect', async () => {
    const binding = socketPlayers.get(socket.id);
    if (!binding) {
      return;
    }
    const hasOtherSockets = unbindSocketPlayer(socket.id);
    if (hasOtherSockets) {
      return;
    }

    scheduleDisconnect(binding.roomCode, binding.playerId);
  });
});

void bootstrap().catch((error) => {
  console.error(`Failed to start server: ${toClientError(error)}`);
  roomStore.close();
  process.exitCode = 1;
});

async function bootstrap(): Promise<void> {
  const rooms = roomStore.loadRooms();
  if (rooms.length > 0) {
    engine.importRooms(rooms);
    for (const code of engine.listRoomCodes()) {
      roomLastActivity.set(code, Date.now());
    }
  }

  roomSweepTimer = setInterval(() => sweepIdleRooms(), 5 * 60 * 1000);
  roomSweepTimer.unref();

  httpServer.listen(port, host, () => {
    console.log(`Server listening on http://${host}:${port}`);
  });
}

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down`);

  for (const timer of roundTimers.values()) {
    clearTimeout(timer);
  }
  for (const timer of nextRoundTimers.values()) {
    clearTimeout(timer);
  }
  for (const timer of disconnectGraceTimers.values()) {
    clearTimeout(timer);
  }
  roundTimers.clear();
  nextRoundTimers.clear();
  disconnectGraceTimers.clear();
  if (roomSweepTimer) {
    clearInterval(roomSweepTimer);
    roomSweepTimer = undefined;
  }

  try {
    await flushPersistence();
  } catch (error) {
    console.warn(toClientError(error));
  }

  await new Promise<void>((resolve) => {
    io.close(() => resolve());
    setTimeout(resolve, 5_000).unref();
  });
  roomStore.close();
}

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});
process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

function resetRoomRuntimeState(code: string): void {
  const normalizedCode = code.toUpperCase();
  clearRoundTimer(normalizedCode);
  clearNextRoundTimer(normalizedCode);
  roomTracks.delete(normalizedCode);
  roomOptionTracks.delete(normalizedCode);
  roomAudioRefillJobs.delete(normalizedCode);
  roomAbortControllers.get(normalizedCode)?.abort();
  roomAbortControllers.delete(normalizedCode);
  audioCache.abortRoomDownloads(normalizedCode);
  nextPoolLoadToken(normalizedCode);
  resetRoomAudioState(normalizedCode);
  audioCache.clearRoom(normalizedCode);
}

function disposeRoom(code: string): void {
  const normalizedCode = code.toUpperCase();
  resetRoomRuntimeState(normalizedCode);
  engine.removeRoom(normalizedCode);
  roomStore.deleteRoom(normalizedCode);
  roomLastActivity.delete(normalizedCode);
  roomPoolLoadTokens.delete(normalizedCode);
  dirtyRoomCodes.delete(normalizedCode);

  for (const [socketId, binding] of socketPlayers) {
    if (binding.roomCode !== normalizedCode) {
      continue;
    }
    socketPlayers.delete(socketId);
    io.sockets.sockets.get(socketId)?.leave(normalizedCode);
  }
  const playerKeyPrefix = `${normalizedCode}:`;
  for (const key of playerSockets.keys()) {
    if (key.startsWith(playerKeyPrefix)) {
      playerSockets.delete(key);
    }
  }
  for (const [key, timer] of disconnectGraceTimers) {
    if (key.startsWith(playerKeyPrefix)) {
      clearTimeout(timer);
      disconnectGraceTimers.delete(key);
    }
  }
}

function sweepIdleRooms(now = Date.now()): void {
  for (const code of engine.listRoomCodes()) {
    let room: ReturnType<GameEngine['getPublicRoom']>;
    try {
      room = engine.getPublicRoom(code);
    } catch {
      continue;
    }
    if (room.players.some((player) => player.connected)) {
      continue;
    }
    if ((io.sockets.adapter.rooms.get(code)?.size ?? 0) > 0) {
      continue;
    }
    const lastActivityAt = roomLastActivity.get(code) ?? now;
    if (now - lastActivityAt <= roomStore.ttlMs) {
      continue;
    }
    console.log(`[storage] removing idle room ${code}`);
    disposeRoom(code);
  }
  roomStore.deleteExpiredRooms(new Set(engine.listRoomCodes()));
}

async function resetRoomToLobby(code: string): Promise<ReturnType<GameEngine['resetToLobby']>> {
  const room = engine.resetToLobby(code);
  resetRoomRuntimeState(room.code);
  markRoomDirty(room.code);
  await flushPersistence();
  return room;
}

async function rollbackPreparingRoom(code: string): Promise<void> {
  try {
    const room = engine.getPublicRoom(code.toUpperCase());
    if (room.status !== 'preparing') {
      return;
    }
    const restored = await resetRoomToLobby(room.code);
    io.to(restored.code).emit('room_state', restored);
  } catch (error) {
    console.warn(`[game] failed to roll back room ${code.toUpperCase()}: ${toClientError(error)}`);
  }
}

async function prepareRoomTrackAudio(
  code: string,
  tracks: Track[],
  options: { minPlayable?: number; clipDurationMs?: number } = {}
): Promise<Track[]> {
  const signal = getRoomAbortSignal(code);
  return prepareTrackAudio(code, tracks, {
    mode: audioDeliveryMode,
    cacheTrackAudio: (roomCode, upstreamUrl, cacheOptions) =>
      audioCache.cacheTrackAudio(roomCode, upstreamUrl, { ...cacheOptions, signal }),
    minPlayable: options.minPlayable,
    clipDurationMs: options.clipDurationMs,
    onCacheError: (track, error) => {
      console.warn(`[audio] failed to cache ${track.id} for ${code.toUpperCase()}: ${toClientError(error)}`);
    }
  });
}

async function hydrateRoomTrackPool(
  code: string,
  loadToken: number,
  source: { themeIds: string[]; playlistSources?: RoomSettings['playlistSources']; playlistUrls?: string[]; playlistUrl?: string; difficulty?: RoomSettings['difficulty'] },
  plannedRounds: number
): Promise<void> {
  try {
    const limits = planTrackPoolLimits(plannedRounds);
    const excludeTrackIds = new Set((roomTracks.get(code.toUpperCase()) ?? []).map((track) => track.id));
    const pool = await music.prepareTrackPool(source, {
      playableLimit: limits.backgroundPlayableLimit,
      optionLimit: limits.backgroundOptionLimit,
      excludeTrackIds
    });
    if (pool.isFallback) {
      console.warn(`[music] background pool load for ${code.toUpperCase()} returned fallback; keeping current room pool`);
      return;
    }
    const room = engine.getPublicRoom(code);
    if (room.status === 'lobby' || roomPoolLoadTokens.get(room.code) !== loadToken) {
      return;
    }

    const currentTracks = roomTracks.get(room.code) ?? [];
    const currentOptions = roomOptionTracks.get(room.code) ?? [];
    if (audioDeliveryMode === 'cache') {
      roomTracks.set(room.code, mergeUniqueById(currentTracks, pool.playableTracks));
      void refillAudioWindow(room.code).catch(() => undefined);
    } else {
      roomTracks.set(room.code, shuffle(mergeUniqueById(currentTracks, pool.playableTracks)));
    }
    roomOptionTracks.set(room.code, shuffle(mergeUniqueByTitle(currentOptions, pool.optionTracks)));
    console.log(`[music] hydrated room ${room.code}: ${roomTracks.get(room.code)?.length ?? 0} playable tracks`);
  } catch (error) {
    console.warn(`[music] background pool load failed for ${code.toUpperCase()}: ${toClientError(error)}`);
  }
}

async function startRound(code: string): Promise<ReturnType<GameEngine['getPublicRoom']>> {
  clearRoundTimer(code);
  clearNextRoundTimer(code);
  const room = engine.getPublicRoom(code);
  const tracks = roomTracks.get(room.code);
  const optionTracks = roomOptionTracks.get(room.code) ?? tracks;
  if (!tracks) {
    throw new Error('No track pool prepared for room');
  }

  let correctCandidates: Track[] | undefined;
  if (audioDeliveryMode === 'cache') {
    await ensureAudioWindow(room.code);
    const state = getAudioWindowState(room.code);
    if (state.size() === 0) {
      throw new Error('No cached audio is available for the next round');
    }
    correctCandidates = state.candidates();
  }

  const latestRoom = engine.getPublicRoom(room.code);
  if (latestRoom.status !== 'preparing' && latestRoom.status !== 'round-result') {
    throw new Error('Round start was cancelled');
  }

  const question = engine.startNextRound(room.code, tracks, optionTracks, undefined, planRoundStart(Date.now(), roundAudioWarmupMs), correctCandidates);
  const updated = engine.getPublicRoom(room.code);
  if (audioDeliveryMode === 'cache') {
    takeCurrentAudio(room.code, question.correctTrack);
  }
  finalizeRoundStart({
    publish: () => {
      io.to(room.code).emit('round_started', updated);
    },
    schedule: () => {
      const timer = setTimeout(() => {
        const revealed = engine.revealRound(room.code);
        if (audioDeliveryMode === 'cache') {
          releaseCurrentAudio(room.code);
          if (revealed.status === 'finished') {
            resetRoomRuntimeState(room.code);
          } else {
            void refillAudioWindow(room.code).catch(() => undefined);
          }
        }
        markRoomDirty(room.code);
        if (revealed.status === 'finished') {
          void flushPersistence();
        }
        io.to(room.code).emit('round_result', revealed);
        scheduleNextRound(revealed.code);
        roundTimers.delete(room.code);
      }, Math.max(0, (updated.currentQuestion?.endsAt ?? Date.now() + room.settings.questionDurationMs) - Date.now()));

      roundTimers.set(room.code, timer);
    },
    persist: () => {
      markRoomDirty(code);
      return Promise.resolve();
    }
  });
  if (audioDeliveryMode === 'cache') {
    void refillAudioWindow(room.code).catch(() => undefined);
  }
  return updated;
}

async function ensureAudioWindow(code: string): Promise<void> {
  if (audioDeliveryMode !== 'cache') {
    return;
  }
  await refillAudioWindow(code);
}

function refillAudioWindow(code: string): Promise<void> {
  const normalizedCode = code.toUpperCase();
  const state = getAudioWindowState(normalizedCode);
  const generation = state.generationValue();
  const previous = roomAudioRefillJobs.get(normalizedCode) ?? Promise.resolve();
  const job = previous
    .catch(() => undefined)
    .then(async () => {
      if (!state.isGenerationCurrent(generation)) {
        return;
      }
      await fillRoomAudioWindow(normalizedCode, state);
    });
  const tracked = job.finally(() => {
    if (roomAudioRefillJobs.get(normalizedCode) === tracked) {
      roomAudioRefillJobs.delete(normalizedCode);
    }
  });
  roomAudioRefillJobs.set(normalizedCode, tracked);
  return tracked;
}

async function fillRoomAudioWindow(code: string, state: AudioWindowState): Promise<void> {
  const tracks = roomTracks.get(code);
  if (!tracks) {
    return;
  }

  let questionDurationMs: number;
  try {
    questionDurationMs = engine.getPublicRoom(code).settings.questionDurationMs;
  } catch {
    return;
  }

  await fillAudioWindow({
    state,
    tracks,
    targetSize: audioCacheLookahead + 1,
    prepare: async (track) => {
      const prepared = await prepareRoomTrackAudio(code, [track], {
        minPlayable: 1,
        clipDurationMs: questionDurationMs
      });
      return prepared[0];
    },
    onOrphan: (track) => removePreparedAudioIfUnused(code, state, track)
  });
}

function getRoomAbortSignal(code: string): AbortSignal {
  const normalizedCode = code.toUpperCase();
  let controller = roomAbortControllers.get(normalizedCode);
  if (!controller) {
    if (!engine.hasRoom(normalizedCode)) {
      throw new Error('Room is no longer available');
    }
    controller = new AbortController();
    roomAbortControllers.set(normalizedCode, controller);
  }
  return controller.signal;
}

function getAudioWindowState(code: string): AudioWindowState {
  const normalizedCode = code.toUpperCase();
  let state = roomAudioWindows.get(normalizedCode);
  if (!state) {
    state = new AudioWindowState();
    roomAudioWindows.set(normalizedCode, state);
  }
  return state;
}

function removePreparedAudioIfUnused(code: string, state: AudioWindowState, preparedTrack: Track): void {
  const liveState = roomAudioWindows.get(code.toUpperCase());
  if (state.isLocalUrlInUse(preparedTrack.audioUrl) || (liveState && liveState.isLocalUrlInUse(preparedTrack.audioUrl))) {
    return;
  }
  const cacheId = localAudioId(preparedTrack.audioUrl);
  if (cacheId) {
    audioCache.remove(cacheId);
  }
}

function takeCurrentAudio(code: string, correctTrack: Track): void {
  getAudioWindowState(code).takeCurrent(correctTrack);
}

function releaseCurrentAudio(code: string): void {
  const state = roomAudioWindows.get(code.toUpperCase());
  const current = state?.releaseCurrent();
  if (!current) {
    return;
  }
  const cacheId = localAudioId(current.track.audioUrl);
  if (cacheId) {
    audioCache.remove(cacheId);
  } else {
    audioCache.removeByUrl(current.upstreamUrl, code.toUpperCase());
  }
}

function resetRoomAudioState(code: string): void {
  const normalizedCode = code.toUpperCase();
  roomAudioWindows.get(normalizedCode)?.reset();
  roomAudioWindows.delete(normalizedCode);
}

function localAudioId(audioUrl: string): string | undefined {
  return /^\/api\/audio\/([a-f0-9-]{36})$/i.exec(audioUrl)?.[1];
}

function scheduleNextRound(code: string): void {
  clearNextRoundTimer(code);
  const room = engine.getPublicRoom(code);
  if (room.status !== 'round-result' || !room.settings.autoNextRound) {
    return;
  }

  const timer = setTimeout(() => {
    nextRoundTimers.delete(room.code);
    void startRound(room.code).catch((error) => {
      io.to(room.code).emit('room_state', engine.getPublicRoom(room.code));
      console.warn(toClientError(error));
    });
  }, 10_000);

  nextRoundTimers.set(room.code, timer);
}

function clearRoundTimer(code: string): void {
  const timer = roundTimers.get(code.toUpperCase());
  if (timer) {
    clearTimeout(timer);
    roundTimers.delete(code.toUpperCase());
  }
}

function clearNextRoundTimer(code: string): void {
  const timer = nextRoundTimers.get(code.toUpperCase());
  if (timer) {
    clearTimeout(timer);
    nextRoundTimers.delete(code.toUpperCase());
  }
}

function nextPoolLoadToken(code: string): number {
  const normalizedCode = code.toUpperCase();
  const token = (roomPoolLoadTokens.get(normalizedCode) ?? 0) + 1;
  roomPoolLoadTokens.set(normalizedCode, token);
  return token;
}

function parseSettings(value: unknown): Partial<RoomSettings> {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const raw = value as Record<string, unknown>;
  return {
    themeId: typeof raw.themeId === 'string' ? raw.themeId : undefined,
    themeIds: Array.isArray(raw.themeIds) ? raw.themeIds.filter((item): item is string => typeof item === 'string') : undefined,
    playlistUrl: typeof raw.playlistUrl === 'string' ? raw.playlistUrl : undefined,
    playlistUrls: Array.isArray(raw.playlistUrls) ? raw.playlistUrls.filter((item): item is string => typeof item === 'string') : undefined,
    playlistSources: Array.isArray(raw.playlistSources)
      ? raw.playlistSources
          .filter((item): item is { url: string; name?: string } => Boolean(item) && typeof item === 'object' && typeof (item as { url?: unknown }).url === 'string')
          .map((item) => ({ url: item.url, name: typeof item.name === 'string' ? item.name : '' }))
      : undefined,
    difficulty: raw.difficulty === 'hard' || raw.difficulty === 'easy' ? raw.difficulty : undefined,
    answerMode: raw.answerMode === 'artist' || raw.answerMode === 'mixed' || raw.answerMode === 'title' ? raw.answerMode : undefined,
    winCondition: raw.winCondition === 'score' || raw.winCondition === 'rounds' ? raw.winCondition : undefined,
    rounds: typeof raw.rounds === 'number' ? raw.rounds : undefined,
    targetScore: typeof raw.targetScore === 'number' ? raw.targetScore : undefined,
    questionDurationMs: typeof raw.questionDurationMs === 'number' ? raw.questionDurationMs : undefined,
    allowAnswerChange: typeof raw.allowAnswerChange === 'boolean' ? raw.allowAnswerChange : undefined,
    autoNextRound: typeof raw.autoNextRound === 'boolean' ? raw.autoNextRound : undefined,
    achievementsEnabled: typeof raw.achievementsEnabled === 'boolean' ? raw.achievementsEnabled : undefined,
    comebackMode: typeof raw.comebackMode === 'boolean' ? raw.comebackMode : undefined
  };
}

function requireSocketPlayer(socketId: string, code: string, playerId: string): void {
  const binding = socketPlayers.get(socketId);
  if (!binding || binding.roomCode !== code.toUpperCase() || binding.playerId !== playerId) {
    throw new Error('Socket is not bound to this player');
  }
}

function bindSocketPlayer(socketId: string, roomCode: string, playerId: string): void {
  unbindSocketPlayer(socketId);
  const normalizedRoomCode = roomCode.toUpperCase();
  clearDisconnectGrace(normalizedRoomCode, playerId);
  socketPlayers.set(socketId, { roomCode: normalizedRoomCode, playerId });
  const key = playerSocketKey(normalizedRoomCode, playerId);
  const sockets = playerSockets.get(key) ?? new Set<string>();
  sockets.add(socketId);
  playerSockets.set(key, sockets);
}

function unbindSocketPlayer(socketId: string): boolean {
  const binding = socketPlayers.get(socketId);
  if (!binding) {
    return false;
  }
  socketPlayers.delete(socketId);
  const key = playerSocketKey(binding.roomCode, binding.playerId);
  const sockets = playerSockets.get(key);
  sockets?.delete(socketId);
  if (sockets && sockets.size > 0) {
    return true;
  }
  playerSockets.delete(key);
  return false;
}

function playerSocketKey(roomCode: string, playerId: string): string {
  return `${roomCode.toUpperCase()}:${playerId}`;
}

function scheduleDisconnect(roomCode: string, playerId: string): void {
  const normalizedRoomCode = roomCode.toUpperCase();
  const key = playerSocketKey(normalizedRoomCode, playerId);
  clearDisconnectGrace(normalizedRoomCode, playerId);

  const timeout = setTimeout(() => {
    disconnectGraceTimers.delete(key);
    if (playerSockets.has(key)) {
      return;
    }
    void markPlayerDisconnected(normalizedRoomCode, playerId);
  }, DISCONNECT_GRACE_MS);
  disconnectGraceTimers.set(key, timeout);
}

function clearDisconnectGrace(roomCode: string, playerId: string): void {
  const key = playerSocketKey(roomCode, playerId);
  const timeout = disconnectGraceTimers.get(key);
  if (!timeout) {
    return;
  }
  clearTimeout(timeout);
  disconnectGraceTimers.delete(key);
}

async function markPlayerDisconnected(roomCode: string, playerId: string): Promise<void> {
  const room = engine.disconnectPlayer(roomCode, playerId);
  if (!room) {
    return;
  }
  markRoomDirty(room.code);
  io.to(room.code).emit('room_state', room);
}

function clampProbeLimit(value: number): number {
  if (!Number.isFinite(value)) {
    return 5;
  }
  return Math.max(1, Math.min(20, Math.round(value)));
}

function clampPage(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(20, Math.round(value)));
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.round(parsed);
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.round(parsed);
}

function estimateRoundsForScore(targetScore: number): number {
  return Math.max(8, Math.min(100, Math.ceil(targetScore / 650) + 4));
}

function toClientError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected server error';
}

let persistenceTimer: NodeJS.Timeout | undefined;

function schedulePersistence(): void {
  if (persistenceTimer || shuttingDown) {
    return;
  }
  persistenceTimer = setTimeout(() => {
    persistenceTimer = undefined;
    void flushPersistence();
  }, PERSISTENCE_DEBOUNCE_MS);
  persistenceTimer.unref();
}

function markRoomDirty(code: string): void {
  const normalizedCode = code.toUpperCase();
  dirtyRoomCodes.add(normalizedCode);
  roomLastActivity.set(normalizedCode, Date.now());
  schedulePersistence();
}

async function flushPersistence(): Promise<void> {
  if (persistenceTimer) {
    clearTimeout(persistenceTimer);
    persistenceTimer = undefined;
  }
  if (dirtyRoomCodes.size === 0) {
    return;
  }

  const codes = [...dirtyRoomCodes];
  dirtyRoomCodes.clear();
  const rooms = codes
    .map((code) => engine.exportRoom(code))
    .filter((room): room is NonNullable<typeof room> => Boolean(room));

  try {
    roomStore.saveRoomsIncremental(rooms);
  } catch (error) {
    for (const code of codes) {
      dirtyRoomCodes.add(code);
    }
    console.warn(toClientError(error));
    schedulePersistence();
  }
}

function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function mergeUniqueById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const seen = new Set(current.map((item) => item.id));
  const merged = [...current];
  for (const item of incoming) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      merged.push(item);
    }
  }
  return merged;
}

function mergeUniqueByTitle<T extends { title: string }>(current: T[], incoming: T[]): T[] {
  const seen = new Set(current.map((item) => normalizeTitle(item.title)));
  const merged = [...current];
  for (const item of incoming) {
    const key = normalizeTitle(item.title);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(item);
    }
  }
  return merged;
}

function normalizeTitle(value: string): string {
  return value.trim().toLocaleLowerCase('ru').replace(/\s+/g, ' ');
}
