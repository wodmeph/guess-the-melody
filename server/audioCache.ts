import { randomUUID } from 'node:crypto';
import { MAX_MP3_CLIP_MS, downloadMp3Clip } from './mp3Clip';

type Fetcher = typeof fetch;

type AudioCacheEntry = {
  id: string;
  roomCode: string;
  upstreamUrl: string;
  mimeType: string;
  body: Buffer;
  clipDurationMs: number;
};

type CacheTrackAudioOptions = {
  maxDurationMs?: number;
};

export type CachedAudioResponse = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
};

const DEFAULT_CLIP_DURATION_MS = 10_000;
const MIN_CLIP_DURATION_MS = 1_000;

export class AudioCache {
  private readonly fetcher: Fetcher;
  private readonly maxBytes: number;
  private readonly entries = new Map<string, AudioCacheEntry>();
  private readonly idsByUpstreamUrl = new Map<string, string>();
  private readonly idsByRoom = new Map<string, Set<string>>();
  private readonly pendingDownloads = new Map<string, Promise<string>>();

  constructor({ fetcher = fetch, maxBytes = 2_000_000 }: { fetcher?: Fetcher; maxBytes?: number } = {}) {
    this.fetcher = fetcher;
    this.maxBytes = maxBytes;
  }

  async cacheTrackAudio(roomCode: string, upstreamUrl: string, options: CacheTrackAudioOptions = {}): Promise<string> {
    const normalizedRoomCode = roomCode.toUpperCase();
    const url = normalizeAudioUrl(upstreamUrl);
    const clipDurationMs = clampClipDuration(options.maxDurationMs);
    const cacheKey = this.cacheKey(normalizedRoomCode, url);
    const existingId = this.idsByUpstreamUrl.get(cacheKey);
    if (existingId) {
      const existing = this.entries.get(existingId);
      if (existing && existing.clipDurationMs >= clipDurationMs) {
        this.trackRoomEntry(normalizedRoomCode, existingId);
        return this.localUrl(existingId);
      }
      if (existing) {
        this.deleteEntry(existingId);
      }
    }

    const pendingKey = `${cacheKey}:${clipDurationMs}`;
    const pending = this.pendingDownloads.get(pendingKey);
    if (pending) {
      return pending;
    }

    const job = this.downloadAndStore(normalizedRoomCode, url, cacheKey, clipDurationMs);
    this.pendingDownloads.set(pendingKey, job);
    try {
      return await job;
    } finally {
      if (this.pendingDownloads.get(pendingKey) === job) {
        this.pendingDownloads.delete(pendingKey);
      }
    }
  }

  read(id: string, rangeHeader?: string): CachedAudioResponse | undefined {
    const entry = this.entries.get(id);
    if (!entry) {
      return undefined;
    }

    const range = parseRange(rangeHeader, entry.body.length);
    if (!range) {
      return {
        status: 200,
        headers: this.headers(entry.mimeType, entry.body.length),
        body: entry.body
      };
    }

    const body = entry.body.subarray(range.start, range.end + 1);
    return {
      status: 206,
      headers: {
        ...this.headers(entry.mimeType, body.length),
        'Content-Range': `bytes ${range.start}-${range.end}/${entry.body.length}`
      },
      body
    };
  }

  remove(id: string): boolean {
    return this.deleteEntry(id);
  }

  removeByUrl(url: string, roomCode?: string): number {
    let normalizedUrl: string;
    try {
      normalizedUrl = normalizeAudioUrl(url);
    } catch {
      return 0;
    }
    const normalizedRoomCode = roomCode?.toUpperCase();
    const matches = [...this.entries.values()].filter(
      (entry) => entry.upstreamUrl === normalizedUrl && (!normalizedRoomCode || entry.roomCode === normalizedRoomCode)
    );
    for (const entry of matches) {
      this.deleteEntry(entry.id);
    }
    return matches.length;
  }

  clearRoom(roomCode: string): void {
    const normalizedRoomCode = roomCode.toUpperCase();
    const ids = this.idsByRoom.get(normalizedRoomCode);
    if (!ids) {
      return;
    }

    for (const id of [...ids]) {
      this.deleteEntry(id);
    }
    this.idsByRoom.delete(normalizedRoomCode);
  }

  private async downloadAndStore(roomCode: string, url: string, cacheKey: string, clipDurationMs: number): Promise<string> {
    const clip = await downloadMp3Clip(this.fetcher, url, {
      targetMs: clipDurationMs,
      maxBytes: this.maxBytes
    });
    if (clip.body.length === 0) {
      throw new Error('Audio file is empty');
    }
    if (clip.body.length > this.maxBytes) {
      throw new Error('Audio file is too large');
    }

    const racedId = this.idsByUpstreamUrl.get(cacheKey);
    if (racedId) {
      const raced = this.entries.get(racedId);
      if (raced && raced.clipDurationMs >= clipDurationMs) {
        this.trackRoomEntry(roomCode, racedId);
        return this.localUrl(racedId);
      }
      if (raced) {
        this.deleteEntry(racedId);
      }
    }

    const id = randomUUID();
    const entry: AudioCacheEntry = {
      id,
      roomCode,
      upstreamUrl: url,
      mimeType: 'audio/mpeg',
      body: clip.body,
      clipDurationMs
    };
    this.entries.set(id, entry);
    this.idsByUpstreamUrl.set(cacheKey, id);
    this.trackRoomEntry(roomCode, id);
    return this.localUrl(id);
  }

  private deleteEntry(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) {
      return false;
    }

    this.entries.delete(id);
    const cacheKey = this.cacheKey(entry.roomCode, entry.upstreamUrl);
    if (this.idsByUpstreamUrl.get(cacheKey) === id) {
      this.idsByUpstreamUrl.delete(cacheKey);
    }
    const ids = this.idsByRoom.get(entry.roomCode);
    if (ids) {
      ids.delete(id);
      if (ids.size === 0) {
        this.idsByRoom.delete(entry.roomCode);
      }
    }
    return true;
  }

  private localUrl(id: string): string {
    return `/api/audio/${id}`;
  }

  private cacheKey(roomCode: string, upstreamUrl: string): string {
    return `${roomCode}:${upstreamUrl}`;
  }

  private headers(mimeType: string, contentLength: number): Record<string, string> {
    return {
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
      'Content-Length': String(contentLength),
      'Content-Type': mimeType
    };
  }

  private trackRoomEntry(roomCode: string, id: string): void {
    const ids = this.idsByRoom.get(roomCode) ?? new Set<string>();
    ids.add(id);
    this.idsByRoom.set(roomCode, ids);
  }
}

function clampClipDuration(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_CLIP_DURATION_MS;
  }
  return Math.max(MIN_CLIP_DURATION_MS, Math.min(MAX_MP3_CLIP_MS, Math.round(value)));
}

function normalizeAudioUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:') {
    throw new Error('Only HTTPS audio URLs are allowed');
  }
  return url.toString();
}

function parseRange(rangeHeader: string | undefined, size: number): { start: number; end: number } | undefined {
  if (!rangeHeader) {
    return undefined;
  }

  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    return undefined;
  }

  const [, startValue, endValue] = match;
  if (!startValue && !endValue) {
    return undefined;
  }

  if (!startValue) {
    const suffixLength = Number(endValue);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
      return undefined;
    }
    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1
    };
  }

  const start = Number(startValue);
  const end = endValue ? Number(endValue) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
    return undefined;
  }

  return {
    start,
    end: Math.min(end, size - 1)
  };
}
