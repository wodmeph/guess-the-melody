import { describe, expect, it, vi } from 'vitest';
import { clipMp3Buffer, downloadMp3Clip } from './mp3Clip';

const FRAME_LENGTH = 417;
const FRAME_DURATION_MS = (1152 / 44_100) * 1000;

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

function id3HeaderWithSize(size: number): Buffer {
  const header = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  header[6] = (size >> 21) & 0x7f;
  header[7] = (size >> 14) & 0x7f;
  header[8] = (size >> 7) & 0x7f;
  header[9] = size & 0x7f;
  return header;
}

function id3Tag(payload: Buffer): Buffer {
  return Buffer.concat([id3HeaderWithSize(payload.length), payload]);
}

function streamResponse(
  chunks: Buffer[],
  hooks: { onCancel?: () => void; onPull?: () => void } = {}
): Response {
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      hooks.onPull?.();
      const chunk = chunks[index];
      index += 1;
      if (!chunk) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(chunk));
    },
    cancel() {
      hooks.onCancel?.();
    }
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'audio/mpeg' }
  });
}

describe('mp3 clipping', () => {
  it('clips CBR MP3 on whole frame boundaries', () => {
    const source = mp3Frames(20);
    const clip = clipMp3Buffer(source, 100, 10_000);

    expect(clip.body.length).toBe(FRAME_LENGTH * 4);
    expect(clip.durationMs).toBeGreaterThanOrEqual(100);
    expect(clip.durationMs).toBeLessThan(100 + FRAME_DURATION_MS);
    expect(clip.truncated).toBe(true);
  });

  it('skips the ID3v2 tag and keeps only audio frames', () => {
    const frames = mp3Frames(10);
    const clip = clipMp3Buffer(Buffer.concat([id3Tag(Buffer.alloc(30, 0x41)), frames]), 100, 10_000);

    expect(clip.body.equals(mp3Frames(4))).toBe(true);
  });

  it('skips an ID3v2 tag split across network chunks', async () => {
    const source = Buffer.concat([id3Tag(Buffer.alloc(30, 0x41)), mp3Frames(10)]);
    const chunks = [source.subarray(0, 5), source.subarray(5, 12), source.subarray(12)];
    const fetcher = vi.fn(async () => streamResponse(chunks));

    const clip = await downloadMp3Clip(fetcher, 'https://example.test/track.mp3', { targetMs: 100, maxBytes: 10_000 });

    expect(clip.body.equals(mp3Frames(4))).toBe(true);
  });

  it('rejects an oversized ID3v2 tag before buffering it', () => {
    const source = Buffer.concat([id3HeaderWithSize(6 * 1024 * 1024), Buffer.alloc(64, 0x41)]);

    expect(() => clipMp3Buffer(source, 1_000, 10_000)).toThrow('Audio file is too large');
  });

  it('resynchronizes after a corrupt frame in the middle of the stream', () => {
    const source = Buffer.concat([mp3Frames(2), Buffer.alloc(50, 0x41), mp3Frames(20)]);
    const clip = clipMp3Buffer(source, 400, 10_000);

    expect(clip.body.length).toBe(FRAME_LENGTH * 16);
    expect(clip.durationMs).toBeGreaterThanOrEqual(400);
  });

  it('rejects a stream with a long corrupt region', () => {
    const source = Buffer.concat([mp3Frames(2), Buffer.alloc(70 * 1024, 0x41), mp3Frames(20)]);

    expect(() => clipMp3Buffer(source, 1_000, 10_000)).toThrow('Unsupported audio format: expected mp3');
  });

  it('drops a leading Xing/Info/VBRI metadata frame', () => {
    const metadataFrame = mp3Frame();
    metadataFrame.write('Xing', 4, 'latin1');
    const source = Buffer.concat([metadataFrame, mp3Frames(10)]);
    const clip = clipMp3Buffer(source, 100, 10_000);

    expect(clip.body.equals(mp3Frames(4))).toBe(true);
  });

  it('returns every available frame when the source is shorter than requested', () => {
    const source = mp3Frames(2);
    const clip = clipMp3Buffer(source, 5_000, 10_000);

    expect(clip.body.equals(source)).toBe(true);
    expect(clip.durationMs).toBeLessThan(100);
  });

  it('ignores trailing garbage after the last complete frame', () => {
    const frames = mp3Frames(3);
    const clip = clipMp3Buffer(Buffer.concat([frames, Buffer.from('not an mp3 frame')]), 5_000, 10_000);

    expect(clip.body.equals(frames)).toBe(true);
  });

  it('rejects non-MP3 content', () => {
    expect(() => clipMp3Buffer(Buffer.from('0000000000000000ftypM4A '), 1_000, 10_000)).toThrow(
      'Unsupported audio format: expected mp3'
    );
  });

  it('rejects a clip that exceeds maxBytes', () => {
    expect(() => clipMp3Buffer(mp3Frames(20), 5_000, 500)).toThrow('Audio file is too large');
  });

  it('downloads and clips while cancelling the upstream stream once enough frames arrive', async () => {
    let cancelCount = 0;
    let pullCount = 0;
    const chunks = Array.from({ length: 20 }, () => mp3Frame());
    const fetcher = vi.fn(async () =>
      streamResponse(chunks, {
        onCancel: () => {
          cancelCount += 1;
        },
        onPull: () => {
          pullCount += 1;
        }
      })
    );

    const clip = await downloadMp3Clip(fetcher, 'https://example.test/track.mp3', { targetMs: 100, maxBytes: 10_000 });

    expect(clip.body.length).toBe(FRAME_LENGTH * 4);
    expect(cancelCount).toBe(1);
    expect(pullCount).toBeLessThan(chunks.length);
  });

  it('handles frames split between network chunks', async () => {
    const source = mp3Frames(10);
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < source.length; offset += 100) {
      chunks.push(source.subarray(offset, offset + 100));
    }
    const fetcher = vi.fn(async () => streamResponse(chunks));

    const clip = await downloadMp3Clip(fetcher, 'https://example.test/track.mp3', { targetMs: 100, maxBytes: 10_000 });

    expect(clip.body.equals(mp3Frames(4))).toBe(true);
  });

  it('falls back to arrayBuffer when the response has no stream body', async () => {
    const source = mp3Frames(10);
    const fetcher = vi.fn(
      async () =>
        ({
          status: 200,
          ok: true,
          headers: new Headers({ 'content-type': 'audio/mpeg' }),
          body: null,
          arrayBuffer: async () => source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength)
        }) as unknown as Response
    );

    const clip = await downloadMp3Clip(fetcher, 'https://example.test/track.mp3', { targetMs: 100, maxBytes: 10_000 });

    expect(clip.body.equals(mp3Frames(4))).toBe(true);
    expect(clip.receivedBytes).toBe(source.length);
  });

  it('cancels a non-MP3 download during format probing', async () => {
    let cancelled = false;
    const fetcher = vi.fn(async () =>
      streamResponse(
        [Buffer.alloc(70 * 1024, 0x41), Buffer.alloc(70 * 1024, 0x41), Buffer.alloc(70 * 1024, 0x41)],
        {
          onCancel: () => {
            cancelled = true;
          }
        }
      )
    );

    await expect(downloadMp3Clip(fetcher, 'https://example.test/track.m4a', { targetMs: 1_000, maxBytes: 10_000 })).rejects.toThrow(
      'Unsupported audio format: expected mp3'
    );
    expect(cancelled).toBe(true);
  });

  it('aborts a stalled upstream request by timeout', async () => {
    const fetcher = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        })
    );

    await expect(
      downloadMp3Clip(fetcher, 'https://example.test/track.mp3', { targetMs: 100, maxBytes: 10_000, timeoutMs: 20 })
    ).rejects.toThrow();
  });

  it('aborts a download through an external signal', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        })
    );

    const pending = downloadMp3Clip(fetcher, 'https://example.test/track.mp3', {
      targetMs: 100,
      maxBytes: 10_000,
      signal: controller.signal
    });
    controller.abort();

    await expect(pending).rejects.toThrow();
  });

  it('cancels the download when maxBytes is exceeded', async () => {
    let cancelled = false;
    const fetcher = vi.fn(async () =>
      streamResponse(
        Array.from({ length: 20 }, () => mp3Frame()),
        {
          onCancel: () => {
            cancelled = true;
          }
        }
      )
    );

    await expect(downloadMp3Clip(fetcher, 'https://example.test/track.mp3', { targetMs: 5_000, maxBytes: 500 })).rejects.toThrow(
      'Audio file is too large'
    );
    expect(cancelled).toBe(true);
  });
});
