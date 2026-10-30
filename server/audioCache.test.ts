import { describe, expect, it, vi } from 'vitest';
import { AudioCache } from './audioCache';

const FRAME_LENGTH = 417;
const UPSTREAM_URL = 'https://strm-test.yandex.net/music-v2/raw/track/preview192';

function mp3Frame(fill = 0): Buffer {
  const frame = Buffer.alloc(FRAME_LENGTH, fill);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0x00;
  return frame;
}

function mp3Frames(count: number): Buffer {
  return Buffer.concat(Array.from({ length: count }, (_, index) => mp3Frame(index % 256)));
}

function response(body: Buffer, headers: Record<string, string> = {}) {
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      'content-type': 'audio/mpeg',
      ...headers
    }
  });
}

describe('AudioCache', () => {
  it('downloads audio once and returns a local URL', async () => {
    const fetcher = vi.fn(async () => response(mp3Frames(10)));
    const cache = new AudioCache({ fetcher });

    const first = await cache.cacheTrackAudio('ROOM42', UPSTREAM_URL);
    const second = await cache.cacheTrackAudio('ROOM42', UPSTREAM_URL);

    expect(first).toMatch(/^\/api\/audio\/[a-f0-9-]+$/);
    expect(second).toBe(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('stores the clipped MP3 instead of the full upstream file', async () => {
    const cache = new AudioCache({ fetcher: vi.fn(async () => response(mp3Frames(100))) });
    const url = await cache.cacheTrackAudio('ROOM42', UPSTREAM_URL, { maxDurationMs: 1_000 });
    const id = url.split('/').pop()!;

    const result = cache.read(id);

    expect(result).toBeDefined();
    expect(result?.body.length).toBe(FRAME_LENGTH * 39);
    expect(result?.headers['Content-Type']).toBe('audio/mpeg');
  });

  it('serves byte ranges from the clipped file', async () => {
    const source = mp3Frames(100);
    const cache = new AudioCache({ fetcher: vi.fn(async () => response(source)) });
    const url = await cache.cacheTrackAudio('ROOM42', UPSTREAM_URL, { maxDurationMs: 1_000 });
    const id = url.split('/').pop()!;
    const expected = source.subarray(0, FRAME_LENGTH * 39);

    const result = cache.read(id, 'bytes=2-5');

    expect(result).toBeDefined();
    if (!result) {
      return;
    }
    expect(result.status).toBe(206);
    expect(result.body.equals(expected.subarray(2, 6))).toBe(true);
    expect(result.headers['Content-Range']).toBe(`bytes 2-5/${expected.length}`);
    expect(result.headers['Accept-Ranges']).toBe('bytes');
  });

  it('re-downloads when a longer clip is requested', async () => {
    const fetcher = vi.fn(async () => response(mp3Frames(100)));
    const cache = new AudioCache({ fetcher });

    const shortUrl = await cache.cacheTrackAudio('ROOM42', UPSTREAM_URL, { maxDurationMs: 1_000 });
    const longUrl = await cache.cacheTrackAudio('ROOM42', UPSTREAM_URL, { maxDurationMs: 2_000 });
    const shortId = shortUrl.split('/').pop()!;
    const longId = longUrl.split('/').pop()!;

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(shortId).not.toBe(longId);
    expect(cache.read(shortId)).toBeUndefined();
    expect(cache.read(longId)?.body.length).toBe(FRAME_LENGTH * 77);
  });

  it('reuses a longer clip for a shorter request', async () => {
    const fetcher = vi.fn(async () => response(mp3Frames(100)));
    const cache = new AudioCache({ fetcher });

    const longUrl = await cache.cacheTrackAudio('ROOM42', UPSTREAM_URL, { maxDurationMs: 2_000 });
    const shortUrl = await cache.cacheTrackAudio('ROOM42', UPSTREAM_URL, { maxDurationMs: 1_000 });

    expect(shortUrl).toBe(longUrl);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not download the same URL twice in parallel', async () => {
    let resolveResponse: ((value: Response) => void) | undefined;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        })
    );
    const cache = new AudioCache({ fetcher });

    const first = cache.cacheTrackAudio('ROOM42', UPSTREAM_URL, { maxDurationMs: 1_000 });
    const second = cache.cacheTrackAudio('ROOM42', UPSTREAM_URL, { maxDurationMs: 1_000 });
    await vi.waitFor(() => expect(resolveResponse).toBeDefined());
    resolveResponse?.(response(mp3Frames(100)));

    const [firstUrl, secondUrl] = await Promise.all([first, second]);

    expect(firstUrl).toBe(secondUrl);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized clipped audio', async () => {
    const cache = new AudioCache({
      maxBytes: 500,
      fetcher: vi.fn(async () => response(mp3Frames(20)))
    });

    await expect(cache.cacheTrackAudio('ROOM42', UPSTREAM_URL)).rejects.toThrow('Audio file is too large');
  });

  it('does not cache non-MP3 audio', async () => {
    const cache = new AudioCache({ fetcher: vi.fn(async () => response(Buffer.from('00000000ftypM4A '))) });

    await expect(cache.cacheTrackAudio('ROOM42', UPSTREAM_URL)).rejects.toThrow('Unsupported audio format: expected mp3');
  });

  it('rejects non-https upstream URLs', async () => {
    const fetcher = vi.fn(async () => response(mp3Frames(4)));
    const cache = new AudioCache({ fetcher });

    await expect(cache.cacheTrackAudio('ROOM42', 'http://strm-test.yandex.net/music-v2/raw/track/preview192')).rejects.toThrow(
      'Only HTTPS audio URLs are allowed'
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('clears cached entries by room', async () => {
    const cache = new AudioCache({ fetcher: vi.fn(async () => response(mp3Frames(10))) });
    const url = await cache.cacheTrackAudio('ROOM42', UPSTREAM_URL);
    const id = url.split('/').pop()!;

    cache.clearRoom('ROOM42');

    expect(cache.read(id)).toBeUndefined();
  });

  it('removes an entry by id and allows caching it again', async () => {
    const fetcher = vi.fn(async () => response(mp3Frames(10)));
    const cache = new AudioCache({ fetcher });
    const firstUrl = await cache.cacheTrackAudio('ROOM42', UPSTREAM_URL);
    const firstId = firstUrl.split('/').pop()!;

    expect(cache.remove(firstId)).toBe(true);
    expect(cache.read(firstId)).toBeUndefined();

    const secondUrl = await cache.cacheTrackAudio('ROOM42', UPSTREAM_URL);

    expect(secondUrl).not.toBe(firstUrl);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('removes an entry by upstream URL and room', async () => {
    const cache = new AudioCache({ fetcher: vi.fn(async () => response(mp3Frames(10))) });
    const url = await cache.cacheTrackAudio('ROOM42', UPSTREAM_URL);
    const id = url.split('/').pop()!;

    expect(cache.removeByUrl(UPSTREAM_URL, 'ROOM42')).toBe(1);

    expect(cache.read(id)).toBeUndefined();
  });

  it('does not clear another room that uses the same upstream URL', async () => {
    const cache = new AudioCache({ fetcher: vi.fn(async () => response(mp3Frames(10))) });
    const firstUrl = await cache.cacheTrackAudio('ROOM42', UPSTREAM_URL);
    const secondUrl = await cache.cacheTrackAudio('ROOM99', UPSTREAM_URL);
    const firstId = firstUrl.split('/').pop()!;
    const secondId = secondUrl.split('/').pop()!;

    cache.clearRoom('ROOM42');

    expect(cache.read(firstId)).toBeUndefined();
    expect(cache.read(secondId)).toBeDefined();
  });
});
