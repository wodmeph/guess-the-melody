export const MAX_MP3_CLIP_MS = 30_000;

const MAX_FRAME_BYTES = 8_192;
const MAX_FORMAT_PROBE_BYTES = 64 * 1024;
const MAX_ID3_TAG_BYTES = 5 * 1024 * 1024;

export type Mp3Clip = {
  body: Buffer;
  durationMs: number;
  receivedBytes: number;
  truncated: boolean;
};

type Mp3FrameHeader = {
  frameLength: number;
  durationMs: number;
};

type CollectorResult = {
  complete: boolean;
  error?: Error;
};

const BITRATES_MPEG1: Record<1 | 2 | 3, readonly number[]> = {
  1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
};

const BITRATES_MPEG2: Record<1 | 2 | 3, readonly number[]> = {
  1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
};

const SAMPLE_RATES: Record<'mpeg1' | 'mpeg2' | 'mpeg2.5', readonly number[]> = {
  mpeg1: [44_100, 48_000, 32_000],
  mpeg2: [22_050, 24_000, 16_000],
  'mpeg2.5': [11_025, 12_000, 8_000]
};

class Mp3FrameCollector {
  private pending: Buffer = Buffer.alloc(0);
  private id3Checked = false;
  private id3SkipBytes = 0;
  private searchBytes = 0;
  private resyncBytes = 0;
  private firstFrameChecked = false;
  private readonly frames: Buffer[] = [];
  private durationMs = 0;
  private bodyLength = 0;
  private finished = false;

  constructor(
    private readonly targetMs: number,
    private readonly maxBytes: number
  ) {}

  push(chunk: Buffer): void {
    if (this.finished || chunk.length === 0) {
      return;
    }
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
  }

  finish(final: boolean): CollectorResult {
    while (!this.finished) {
      if (!this.id3Checked) {
        if (this.pending.length < 10) {
          if (!final) {
            return { complete: false };
          }
          this.id3Checked = true;
          if (this.pending.length === 0) {
            return { complete: false, error: unsupportedFormatError() };
          }
        } else {
          const tagLength = id3v2TagLength(this.pending);
          this.id3Checked = true;
          if (tagLength > 0) {
            if (tagLength > MAX_ID3_TAG_BYTES) {
              return { complete: false, error: new Error('Audio file is too large') };
            }
            this.id3SkipBytes = tagLength;
            continue;
          }
          continue;
        }
      }

      if (this.id3SkipBytes > 0) {
        const consume = Math.min(this.pending.length, this.id3SkipBytes);
        this.pending = this.pending.subarray(consume);
        this.id3SkipBytes -= consume;
        if (this.id3SkipBytes > 0) {
          if (final) {
            return { complete: false, error: unsupportedFormatError() };
          }
          return { complete: false };
        }
        continue;
      }

      if (!this.firstFrameChecked) {
        const found = this.findFrameStart(final);
        if (found.error) {
          return { complete: false, error: found.error };
        }
        if (!found.found) {
          return { complete: false };
        }
      }

      if (this.pending.length < 4) {
        if (!final) {
          return { complete: false };
        }
        this.finished = true;
        continue;
      }

      const header = parseMp3FrameHeader(this.pending, 0);
      if (!header) {
        const resynced = this.resync(final);
        if (resynced.error) {
          return { complete: false, error: resynced.error };
        }
        if (!resynced.found) {
          if (this.finished) {
            continue;
          }
          return { complete: false };
        }
        continue;
      }

      if (this.pending.length < header.frameLength) {
        if (!final) {
          return { complete: false };
        }
        this.finished = true;
        continue;
      }

      const frame = this.pending.subarray(0, header.frameLength);
      this.pending = this.pending.subarray(header.frameLength);

      if (!this.firstFrameChecked) {
        this.firstFrameChecked = true;
        if (isMetadataFrame(frame)) {
          continue;
        }
      }

      this.frames.push(frame);
      this.bodyLength += frame.length;
      this.durationMs += header.durationMs;

      if (this.bodyLength > this.maxBytes) {
        return { complete: false, error: new Error('Audio file is too large') };
      }
      if (this.durationMs >= this.targetMs) {
        this.finished = true;
      }
    }

    return { complete: true };
  }

  toClip(receivedBytes: number): Mp3Clip {
    const body = Buffer.concat(this.frames);
    if (body.length === 0) {
      throw unsupportedFormatError();
    }
    return {
      body,
      durationMs: this.durationMs,
      receivedBytes,
      truncated: body.length !== receivedBytes
    };
  }

  private findFrameStart(final: boolean): { found: boolean; error?: Error } {
    while (this.pending.length >= 4) {
      if (this.pending[0] === 0xff && (this.pending[1] & 0xe0) === 0xe0 && parseMp3FrameHeader(this.pending, 0)) {
        return { found: true };
      }

      this.searchBytes += 1;
      if (this.searchBytes > MAX_FORMAT_PROBE_BYTES) {
        return { found: false, error: unsupportedFormatError() };
      }
      this.pending = this.pending.subarray(1);
    }

    if (final) {
      return { found: false, error: unsupportedFormatError() };
    }
    return { found: false };
  }

  private resync(final: boolean): { found: boolean; error?: Error } {
    while (this.pending.length >= 4) {
      if (this.pending[0] === 0xff && (this.pending[1] & 0xe0) === 0xe0 && parseMp3FrameHeader(this.pending, 0)) {
        this.resyncBytes = 0;
        return { found: true };
      }

      this.resyncBytes += 1;
      if (this.resyncBytes > MAX_FORMAT_PROBE_BYTES) {
        return { found: false, error: unsupportedFormatError() };
      }
      this.pending = this.pending.subarray(1);
    }

    if (final) {
      this.finished = true;
    }
    return { found: false };
  }
}

export function clipMp3Buffer(input: Buffer, targetMs: number, maxBytes: number): Mp3Clip {
  const collector = new Mp3FrameCollector(targetMs, maxBytes);
  collector.push(input);
  const result = collector.finish(true);
  if (result.error) {
    throw result.error;
  }
  return collector.toClip(input.length);
}

export async function downloadMp3Clip(
  fetcher: typeof fetch,
  url: string,
  options: { targetMs: number; maxBytes: number }
): Promise<Mp3Clip> {
  const controller = new AbortController();
  const accept = 'audio/mpeg, audio/*;q=0.9, */*;q=0.8';
  let response = await fetcher(url, {
    headers: {
      Accept: accept,
      Range: 'bytes=0-'
    },
    signal: controller.signal
  });

  if (response.status === 416) {
    response = await fetcher(url, {
      headers: { Accept: accept },
      signal: controller.signal
    });
  }

  if (response.status !== 200 && response.status !== 206) {
    throw new Error(`Audio download failed: ${response.status}`);
  }

  const collector = new Mp3FrameCollector(options.targetMs, options.maxBytes);

  if (!response.body) {
    const body = Buffer.from(await response.arrayBuffer());
    collector.push(body);
    const result = collector.finish(true);
    if (result.error) {
      throw result.error;
    }
    return collector.toClip(body.length);
  }

  const reader = response.body.getReader();
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.length === 0) {
        continue;
      }
      const chunk = Buffer.from(value);
      receivedBytes += chunk.length;
      collector.push(chunk);
      const result = collector.finish(false);
      if (result.error) {
        await cancelReader(reader, controller);
        throw result.error;
      }
      if (result.complete) {
        await cancelReader(reader, controller);
        return collector.toClip(receivedBytes);
      }
    }

    const result = collector.finish(true);
    if (result.error) {
      await cancelReader(reader, controller);
      throw result.error;
    }
    return collector.toClip(receivedBytes);
  } finally {
    reader.releaseLock();
  }
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>, controller: AbortController): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // The stream may already be closed by the time the clip is complete.
  }
  controller.abort();
}

function parseMp3FrameHeader(buffer: Buffer, offset: number): Mp3FrameHeader | undefined {
  if (buffer.length - offset < 4) {
    return undefined;
  }

  const byte0 = buffer[offset];
  const byte1 = buffer[offset + 1];
  const byte2 = buffer[offset + 2];

  if (byte0 !== 0xff || (byte1 & 0xe0) !== 0xe0) {
    return undefined;
  }

  const versionBits = (byte1 >> 3) & 0x03;
  const layerBits = (byte1 >> 1) & 0x03;
  const bitrateIndex = (byte2 >> 4) & 0x0f;
  const sampleRateIndex = (byte2 >> 2) & 0x03;

  if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) {
    return undefined;
  }

  const mpeg1 = versionBits === 3;
  const versionKey = mpeg1 ? 'mpeg1' : versionBits === 2 ? 'mpeg2' : 'mpeg2.5';
  const layer = (4 - layerBits) as 1 | 2 | 3;
  const bitrateTable = mpeg1 ? BITRATES_MPEG1[layer] : BITRATES_MPEG2[layer];
  const bitrate = bitrateTable[bitrateIndex] * 1000;
  const sampleRate = SAMPLE_RATES[versionKey][sampleRateIndex];
  const padding = (byte2 >> 1) & 0x01;

  if (!bitrate || !sampleRate) {
    return undefined;
  }

  const samplesPerFrame = layer === 1 ? 384 : layer === 2 ? 1152 : mpeg1 ? 1152 : 576;
  let frameLength: number;

  if (layer === 1) {
    frameLength = Math.floor((12 * bitrate) / sampleRate + padding) * 4;
  } else if (layer === 2) {
    frameLength = Math.floor((144 * bitrate) / sampleRate + padding);
  } else {
    frameLength = Math.floor(((mpeg1 ? 144 : 72) * bitrate) / sampleRate + padding);
  }

  if (frameLength < 4 || frameLength > MAX_FRAME_BYTES) {
    return undefined;
  }

  return {
    frameLength,
    durationMs: (samplesPerFrame / sampleRate) * 1000
  };
}

function id3v2TagLength(buffer: Buffer): number {
  if (buffer.length < 10 || buffer[0] !== 0x49 || buffer[1] !== 0x44 || buffer[2] !== 0x33) {
    return 0;
  }

  const size = ((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) | ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f);
  const hasFooter = (buffer[5] & 0x10) !== 0;
  return 10 + size + (hasFooter ? 10 : 0);
}

function isMetadataFrame(frame: Buffer): boolean {
  const probe = frame.subarray(0, Math.min(frame.length, 96)).toString('latin1');
  return probe.includes('Xing') || probe.includes('Info') || probe.includes('VBRI');
}

function unsupportedFormatError(): Error {
  return new Error('Unsupported audio format: expected mp3');
}
