import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GameEngine } from './game';
import type { SerializedRoom } from './game';
import { RoomStore } from './roomStore';

let tempDir: string;
let dbPath: string;
const stores: RoomStore[] = [];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'gtm-room-store-'));
  dbPath = join(tempDir, 'rooms.sqlite');
});

afterEach(() => {
  for (const store of stores) {
    store.close();
  }
  stores.length = 0;
  rmSync(tempDir, { recursive: true, force: true });
});

function createStore(options: { ttlMs?: number; now?: () => number } = {}): RoomStore {
  const store = new RoomStore({ filePath: dbPath, ...options });
  stores.push(store);
  return store;
}

function createRooms(count = 2): SerializedRoom[] {
  let nextCode = 0;
  const engine = new GameEngine(() => (nextCode++ === 0 ? 'AAAA' : 'BBBB'));
  for (let index = 0; index < count; index += 1) {
    engine.createRoom({ playerId: `player-${index + 1}`, playerName: `Player ${index + 1}` });
  }
  return engine.exportRooms();
}

describe('RoomStore', () => {
  it('saves and loads room snapshots', () => {
    const rooms = createRooms();
    const store = createStore();

    store.saveRooms(rooms);

    expect(store.loadRooms()).toEqual(rooms);
  });

  it('removes rooms that are no longer present', () => {
    const rooms = createRooms();
    const store = createStore();

    store.saveRooms(rooms);
    store.saveRooms(rooms.slice(0, 1));

    expect(store.loadRooms()).toEqual(rooms.slice(0, 1));
  });

  it('restores rooms after reopening the database', () => {
    const rooms = createRooms(1);
    const firstStore = createStore();
    firstStore.saveRooms(rooms);
    firstStore.close();

    const secondStore = createStore();

    expect(secondStore.loadRooms()).toEqual(rooms);
  });

  it('drops rooms after the configured ttl', () => {
    let now = 1_000_000;
    const store = createStore({ ttlMs: 1_000, now: () => now });

    store.saveRooms(createRooms(1));
    expect(store.loadRooms()).toHaveLength(1);

    now += 1_001;

    expect(store.loadRooms()).toEqual([]);
  });

  it('upserts individual rooms and deletes them without touching the rest', () => {
    const [first, second] = createRooms();
    const store = createStore();

    store.saveRooms([first, second]);
    store.saveRoom({ ...first, round: 3 });
    store.deleteRoom(second.code);

    const rooms = store.loadRooms();

    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toEqual({ ...first, round: 3 });
  });

  it('updates updated_at only for the saved room', () => {
    let now = 1_000_000;
    const [first, second] = createRooms();
    const store = createStore({ now: () => now });

    store.saveRooms([first, second]);
    now += 5_000;
    store.saveRoom({ ...first, round: 2 });

    const database = new DatabaseSync(dbPath);
    const rows = database.prepare('SELECT code, updated_at FROM rooms ORDER BY code').all() as Array<{ code: string; updated_at: number }>;
    database.close();

    expect(rows).toEqual([
      { code: first.code, updated_at: 1_005_000 },
      { code: second.code, updated_at: 1_000_000 }
    ]);
  });

  it('deletes only expired room rows', () => {
    let now = 1_000_000;
    const [first, second] = createRooms();
    const store = createStore({ ttlMs: 1_000, now: () => now });

    store.saveRooms([first, second]);
    now += 500;
    store.saveRoom({ ...second, round: 2 });
    now += 600;

    expect(store.deleteExpiredRooms()).toBe(1);
    expect(store.loadRooms()).toEqual([{ ...second, round: 2 }]);
  });

  it('skips corrupt snapshots without failing', () => {
    const store = createStore();
    store.saveRooms(createRooms(1));
    store.close();

    const database = new DatabaseSync(dbPath);
    database.prepare('UPDATE rooms SET snapshot = ?').run('{not-json');
    database.close();

    const reopenedStore = createStore();

    expect(reopenedStore.loadRooms()).toEqual([]);
  });
});
