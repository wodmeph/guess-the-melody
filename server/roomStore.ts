import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import type { SerializedRoom } from './game';

const DEFAULT_DB_PATH = './data/rooms.sqlite';
const DEFAULT_TTL_MS = 72 * 60 * 60 * 1000;

type RoomRow = {
  snapshot: string;
};

type RoomStoreOptions = {
  filePath?: string;
  ttlMs?: number;
  now?: () => number;
};

export class RoomStore {
  private readonly db: DatabaseSync;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly deleteAll: StatementSync;
  private readonly insertRoom: StatementSync;
  private readonly deleteExpired: StatementSync;
  private readonly selectRooms: StatementSync;
  private closed = false;

  constructor(options: RoomStoreOptions = {}) {
    const configuredPath = options.filePath ?? process.env.ROOM_DB_PATH;
    const filePath = configuredPath?.trim() || DEFAULT_DB_PATH;
    this.ttlMs = options.ttlMs ?? parseTtlMs(process.env.ROOM_TTL_HOURS);
    this.now = options.now ?? Date.now;

    if (filePath !== ':memory:') {
      mkdirSync(dirname(filePath), { recursive: true });
    }

    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS rooms (
        code TEXT PRIMARY KEY,
        snapshot TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `);

    this.deleteAll = this.db.prepare('DELETE FROM rooms');
    this.insertRoom = this.db.prepare('INSERT INTO rooms (code, snapshot, updated_at) VALUES (?, ?, ?)');
    this.deleteExpired = this.db.prepare('DELETE FROM rooms WHERE updated_at < ?');
    this.selectRooms = this.db.prepare('SELECT snapshot FROM rooms ORDER BY updated_at');
  }

  saveRooms(rooms: SerializedRoom[]): void {
    const updatedAt = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.deleteAll.run();
      for (const room of rooms) {
        this.insertRoom.run(room.code, JSON.stringify(room), updatedAt);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  loadRooms(): SerializedRoom[] {
    this.deleteExpired.run(this.now() - this.ttlMs);
    const rows = this.selectRooms.all() as RoomRow[];
    const rooms: SerializedRoom[] = [];

    for (const row of rows) {
      try {
        const room = JSON.parse(row.snapshot) as unknown;
        if (isSerializedRoom(room)) {
          rooms.push(room);
        } else {
          console.warn('[storage] skipped invalid room snapshot');
        }
      } catch {
        console.warn('[storage] skipped corrupt room snapshot');
      }
    }

    return rooms;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.db.close();
    this.closed = true;
  }
}

function parseTtlMs(value: string | undefined): number {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) {
    return DEFAULT_TTL_MS;
  }
  return Math.round(hours * 60 * 60 * 1000);
}

function isSerializedRoom(value: unknown): value is SerializedRoom {
  return Boolean(value) && typeof value === 'object' && typeof (value as { code?: unknown }).code === 'string';
}
